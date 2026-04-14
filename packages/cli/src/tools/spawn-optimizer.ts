import { resolve, isAbsolute, basename, relative } from "node:path";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { runClaudeCode, CCTimeoutError } from "../infra/claude-code.js";
import {
  writeIterationAgentMcpConfig,
  buildIterationAgentSettings,
} from "../infra/mcp-config.js";
import {
  getChangedFiles,
  createWorktree,
  getRepoRoot,
} from "../infra/git-ops.js";
import {
  writeIterationTrace,
  formatToolSummary,
} from "../infra/iteration-trace.js";
import {
  getIterationAgentSystemPrompt,
  buildIterationAgentTaskPrompt,
} from "../prompts/optimizer.js";
import { generateModelRegistry } from "../infra/model-registry.js";
import {
  copyMetadataToWorktree,
  getAutoperfPaths,
} from "../infra/autoperf-dir.js";

/** Result returned to CC after an optimizer run. */
export interface SpawnOptimizerResult {
  success: boolean;
  /** CC sub-agent's text result (what it said it did). */
  result: string | null;
  /** Files the sub-agent changed in the target directory. */
  filesChanged: string[];
  /** Path to the saved session trace file. */
  sessionTracePath: string | null;
  /** Brief summary of tool calls the sub-agent made. */
  toolSummary: string;
  /** Cost of this sub-agent run in USD (from CC's cost tracking). */
  cost: number;
  /** Error message if the run failed. */
  error: string | null;
  /** Path to the iteration reasoning doc (iter-{N}.md) for orchestrator to read. */
  reasoningDocPath: string | null;
  /** Which iteration this was. */
  iterationNumber: number;
  /** Path to the target agent within the worktree (for post-change eval). */
  worktreeTargetPath: string | null;
  /** Path to the worktree root directory (for accept/reject tools). */
  worktreePath: string | null;
  /** Git branch name for the worktree (for acceptIteration tool). */
  branchName: string | null;
}

/**
 * Lazy singleton for MCP config path. Generated once on first spawn.
 * Returns null when no research tools are available (no API keys set).
 */
let cachedMcpConfigPath: string | null | undefined = undefined;

function getMcpConfigPath(): string | null {
  if (cachedMcpConfigPath === undefined) {
    cachedMcpConfigPath = writeIterationAgentMcpConfig();
    if (cachedMcpConfigPath) {
      console.error(`[autoperf] MCP config written to ${cachedMcpConfigPath}`);
    } else {
      console.error(
        "[autoperf] No research MCP tools configured (set CONTEXT7_API_KEY or NIA_API_KEY in .env for better results)",
      );
    }
  }
  return cachedMcpConfigPath;
}

/** Resolve a path to absolute, using process.cwd() as base for relative paths. */
function toAbsolute(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/**
 * spawnOptimizer tool handler.
 *
 * Creates a git worktree for isolation, then spawns an autonomous iteration
 * agent that receives structured inputs (optimization profile, state file,
 * meta-knowledge) as file paths — no prescriptive instructions.
 *
 * The agent runs in the worktree, researches, discovers, and implements
 * domain-scoped optimizations, then writes a reasoning doc and commits.
 *
 * Returns worktree info so the orchestrator can:
 * - Run post-change eval on worktreeTargetPath
 * - Call acceptIteration (merge) or rejectIteration (remove)
 *
 * Errors from the sub-agent (timeout, crash) are caught and returned
 * as structured error objects, not thrown — CC needs to reason about failures.
 */
export async function handleSpawnOptimizer(args: {
  targetDir: string;
  optimizationProfilePath: string;
  optimizationMdPath: string;
  metaKnowledgePath: string;
  iterationNumber: number;
  model?: string;
  totalIterations?: number;
  baselineCost?: number;
  currentBestCost?: number;
  baselineQuality?: number;
  currentBestQuality?: number;
}): Promise<SpawnOptimizerResult> {
  const targetDir = toAbsolute(args.targetDir);
  const model = args.model ?? "sonnet";
  const iterationNumber = args.iterationNumber;
  const targetName = basename(targetDir);
  const worktreeId = `${targetName}-iter-${iterationNumber}`;

  // ── Create worktree for isolation ─────────────────────────────────
  const repoRoot = await getRepoRoot(targetDir);
  const { worktreePath, branchName } = await createWorktree(
    repoRoot,
    worktreeId,
  );

  // Compute target agent path within the worktree
  const relativeTarget = relative(repoRoot, targetDir);
  const worktreeTargetPath = resolve(worktreePath, relativeTarget);

  // Symlink node_modules so package imports resolve in the worktree
  const mainNodeModules = resolve(targetDir, "node_modules");
  const worktreeNodeModules = resolve(worktreeTargetPath, "node_modules");
  try {
    await symlink(mainNodeModules, worktreeNodeModules);
  } catch (err) {
    console.error(
      `[autoperf] Warning: could not symlink node_modules to worktree: ${err}`,
    );
  }

  // ── D9: Write plugin settings into worktree ──────────────────────
  // Discover all installed plugins, enable only typescript-lsp + vercel,
  // disable everything else. Prevents user plugins (superpowers, etc.)
  // from leaking into the iteration agent's environment.
  try {
    const settings = await buildIterationAgentSettings();
    const settingsDir = resolve(worktreePath, ".claude");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      resolve(settingsDir, "settings.json"),
      JSON.stringify(settings, null, 2),
    );
    const enabled = Object.entries(settings.enabledPlugins)
      .filter(([, v]) => v)
      .map(([k]) => k.split("@")[0]);
    console.error(
      `[autoperf] Worktree plugins: ${enabled.length > 0 ? enabled.join(", ") : "none"}`,
    );
  } catch (err) {
    console.error(
      `[autoperf] Warning: could not write worktree settings: ${err}`,
    );
  }

  // ── Copy metadata from .autoperf/{target}/ into worktree ─────────
  // Copies optimization.md, iteration-reasoning/, and profiles/ so the
  // iteration agent has full prior context. Source is .autoperf/{target}/
  // (canonical location). Files are NOT committed by the agent — the
  // worktree .gitignore below prevents accidental staging.
  await copyMetadataToWorktree(repoRoot, targetName, worktreeTargetPath);

  // ── Write worktree .gitignore safety net ─────────────────────────
  // Prevents the iteration agent from accidentally committing metadata
  // files (optimization.md, profiles/, iteration-reasoning/, events).
  // Even if the agent runs `git add .`, these entries are excluded.
  try {
    await writeFile(
      resolve(worktreeTargetPath, ".gitignore"),
      "# AutoPerf metadata — managed by autoperf, not committed\niteration-reasoning/\nprofiles/\noptimization.md\nautoperf-events.jsonl\n",
    );
  } catch (err) {
    console.error(
      `[autoperf] Warning: could not write worktree .gitignore: ${err}`,
    );
  }

  // Convention-based reasoning doc path (in worktree — committed, survives merge)
  const reasoningDocPath = resolve(
    worktreeTargetPath,
    "iteration-reasoning",
    `iter-${iterationNumber}.md`,
  );

  // Generate available-models.md (detects API keys + installed packages)
  const autoperfPaths = getAutoperfPaths(repoRoot, targetName);
  const registryOutputDir = autoperfPaths.traces;
  const registry = await generateModelRegistry(targetDir, registryOutputDir);

  // Build task prompt: targetDir = worktree (where agent edits code),
  // input file paths = absolute on main (readable from anywhere)
  const taskPrompt = buildIterationAgentTaskPrompt({
    targetDir: worktreeTargetPath,
    optimizationProfilePath: toAbsolute(args.optimizationProfilePath),
    optimizationMdPath: toAbsolute(args.optimizationMdPath),
    metaKnowledgePath: toAbsolute(args.metaKnowledgePath),
    availableModelsPath: registry.filePath,
    iterationNumber,
    totalIterations: args.totalIterations,
    baselineCost: args.baselineCost,
    currentBestCost: args.currentBestCost,
    baselineQuality: args.baselineQuality,
    currentBestQuality: args.currentBestQuality,
  });

  console.error(
    `[autoperf] spawnOptimizer #${iterationNumber}: model=${model}, worktree=${worktreePath}, target=${worktreeTargetPath}`,
  );

  try {
    const { result, events } = await runClaudeCode({
      prompt: taskPrompt,
      cwd: worktreeTargetPath,
      model,
      systemPrompt: getIterationAgentSystemPrompt(),
      mcpConfigPath: getMcpConfigPath() ?? undefined,
    });

    // Capture changed files in the worktree
    const filesChanged = await getChangedFiles(worktreeTargetPath).catch(
      () => [],
    );

    // Write session trace to .autoperf/{target}/traces/
    const traceDir = autoperfPaths.traces;
    const sessionTracePath = await writeIterationTrace(
      iterationNumber,
      events,
      traceDir,
    ).catch((err) => {
      console.error(`[autoperf] Failed to write trace: ${err}`);
      return null;
    });

    const toolSummary = formatToolSummary(events);
    const cost = result.total_cost_usd;

    console.error(
      `[autoperf] spawnOptimizer #${iterationNumber} complete: cost=$${cost.toFixed(4)}, ${toolSummary}, files=${filesChanged.length}`,
    );

    return {
      success: true,
      result: result.result,
      filesChanged,
      sessionTracePath,
      toolSummary,
      cost,
      error: null,
      reasoningDocPath,
      iterationNumber,
      worktreeTargetPath,
      worktreePath,
      branchName,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof CCTimeoutError;

    console.error(
      `[autoperf] spawnOptimizer #${iterationNumber} failed: ${isTimeout ? "TIMEOUT" : "ERROR"}: ${errorMsg}`,
    );

    return {
      success: false,
      result: null,
      filesChanged: [],
      sessionTracePath: null,
      toolSummary: "",
      cost: 0,
      error: errorMsg,
      reasoningDocPath: null,
      iterationNumber,
      worktreeTargetPath,
      worktreePath,
      branchName,
    };
  }
}
