import type { Command } from "commander";
import { resolve, isAbsolute, join, basename } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  existsSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { access } from "node:fs/promises";
import { execa, type ResultPromise } from "execa";
import { config } from "dotenv";

import { getOrchestratorSystemPrompt } from "../prompts/orchestrator.js";
import { buildOrchestratorMcpConfig } from "../infra/mcp-config.js";
import { cleanupOrphanedWorktrees } from "../infra/git-ops.js";
import type { StreamEvent } from "../infra/types.js";
import { ensureAutoperfDir, getAutoperfPaths } from "../infra/autoperf-dir.js";
import { generateReport } from "../report/generate-report.js";

// ── Path resolution helpers ─────────────────────────────────────────────

/** Package root: from dist/commands/ → packages/cli/ */
const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Resolve the meta-knowledge file bundled with the package.
 */
function resolveMetaKnowledge(): string {
  const bundled = resolve(PACKAGE_ROOT, "data/optimization-meta-knowledge.md");
  if (existsSync(bundled)) return bundled;

  throw new Error(
    `Meta-knowledge file not found: ${bundled}\n` +
      "Ensure the package is properly installed.",
  );
}

/**
 * Resolve the MCP server entrypoint (compiled JS).
 */
function resolveMcpServer(): string {
  const mcpServer = resolve(PACKAGE_ROOT, "dist/mcp-server.js");
  if (!existsSync(mcpServer)) {
    throw new Error(`MCP server not found: ${mcpServer}`);
  }
  return mcpServer;
}

// ── Query loading ───────────────────────────────────────────────────────

function loadQueries(queriesPath: string): {
  queries: unknown[];
  count: number;
} {
  const raw = readFileSync(queriesPath, "utf-8");
  const parsed = JSON.parse(raw);
  const queries: unknown[] = Array.isArray(parsed) ? parsed : parsed.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error(
      "Queries file must contain a non-empty array.\n" +
        'Expected: [{"query": "..."}] or {"queries": [{"query": "..."}]}',
    );
  }
  return { queries, count: queries.length };
}

// ── Query set hash ─────────────────────────────────────────────────────

/**
 * Compute a stable content hash of a query set file.
 * Hashes the parsed+sorted JSON so whitespace/formatting changes don't
 * trigger false mismatches. Returns first 12 hex chars (sufficient for
 * change detection, not security).
 */
function computeQuerySetHash(queriesPath: string): string {
  const raw = readFileSync(queriesPath, "utf-8");
  const parsed = JSON.parse(raw);
  const queries = Array.isArray(parsed) ? parsed : parsed.queries;
  const canonical = JSON.stringify(queries);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/**
 * Extract the stored query set hash from optimization.md.
 * Returns null if no hash is found (pre-SP-EVAL-4 format).
 */
function extractStoredQueryHash(optimizationMdPath: string): string | null {
  const content = readFileSync(optimizationMdPath, "utf-8");
  const match = content.match(/Query set hash: `([a-f0-9]+)`/);
  return match ? match[1] : null;
}

// ── Fresh cleanup ───────────────────────────────────────────────────────

async function cleanAutoperfArtifacts(
  repoRoot: string,
  label: string,
): Promise<void> {
  const paths = getAutoperfPaths(repoRoot, label);
  if (existsSync(paths.root)) {
    rmSync(paths.root, { recursive: true, force: true });
    console.log(`[autoperf] Cleaned: .autoperf/${label}/`);
  }

  // Also clean up any worktrees
  const worktreesDir = resolve(repoRoot, ".autoperf", "worktrees");
  if (existsSync(worktreesDir)) {
    rmSync(worktreesDir, { recursive: true, force: true });
    console.log("[autoperf] Cleaned: .autoperf/worktrees/");
    // Prune git worktree metadata to prevent "already registered" errors
    await execa("git", ["worktree", "prune"], { cwd: repoRoot });
  }

  // Recreate empty directory structure
  await ensureAutoperfDir(repoRoot, label);
}

// ── Continuation state detection ────────────────────────────────────────

function detectContinuationState(
  repoRoot: string,
  label: string,
): {
  isContinuation: boolean;
  startIteration: number;
} {
  const optimizationMd = getAutoperfPaths(repoRoot, label).optimizationMd;
  if (!existsSync(optimizationMd)) {
    return { isContinuation: false, startIteration: 1 };
  }

  const content = readFileSync(optimizationMd, "utf-8");
  const iterMatches = content.matchAll(/### Iteration (\d+)/g);
  let lastIter = 0;
  for (const m of iterMatches) {
    const n = parseInt(m[1], 10);
    if (n > lastIter) lastIter = n;
  }

  return { isContinuation: true, startIteration: lastIter + 1 };
}

// ── User prompt generation ──────────────────────────────────────────────

function buildUserPrompt(opts: {
  targetPath: string;
  queriesPath: string;
  metaKnowledgePath: string;
  queryCount: number;
  maxIterations: number;
  evalTier: number;
  label: string;
  isContinuation: boolean;
  startIteration: number;
  querySetHash: string;
}): string {
  if (opts.isContinuation) {
    return `# AutoPerf Optimization Run — ${opts.label} — Continuation

## Configuration
- **Target agent**: ${opts.targetPath}
- **Eval queries**: ${opts.queriesPath} (${opts.queryCount} queries)
- **Meta-knowledge**: ${opts.metaKnowledgePath}
- **Max iterations**: ${opts.maxIterations} (continuing from iteration ${opts.startIteration - 1} — start at iteration ${opts.startIteration})
- **Eval tier**: ${opts.evalTier} (n=${opts.evalTier} per query)

## Context — Continuing from Prior Run

This is a CONTINUATION run. The optimization.md file at \`.autoperf/${opts.label}/optimization.md\` already has:
- Original Baseline metrics and quality scores (your permanent quality reference)
- Prior iterations with accepts/rejects
- Active optimizations, learned principles, and current cost/latency reference

**Do NOT re-baseline.** The existing optimization.md IS your state. Read it first.

## Instructions

1. **Calibration eval**: Run \`runEval\` on the current target agent (with \`profileOutputDir: ".autoperf/${opts.label}/profiles/"\`, \`evalType: "calibration"\`) to get a fresh optimization profile and current environment metrics. This is a CALIBRATION — it measures the current agent's cost/latency in today's environment.

   **How to use the calibration results:**
   - Update the "## Current Cost/Latency Reference" section in optimization.md with these metrics and raw samples. These become your "before" for cost/latency comparisons in this session.
   - Do NOT modify the "## Original Baseline (Quality Reference)" section. That section contains the permanent quality reference from the original run.
   - The \`originalBaselineQuality\` array you pass to \`compareResults\` ALWAYS comes from the "## Original Baseline (Quality Reference)" section — never from this calibration eval.
   - If optimization.md uses older section names ("## Baseline" instead of "## Original Baseline (Quality Reference)"), treat "## Baseline" as the quality reference.

2. **Iterate** (iterations ${opts.startIteration} through ${opts.maxIterations}):
   - Spawn an iteration agent via \`spawnOptimizer\` — pass the iteration context params (totalIterations=${opts.maxIterations}, baselineCost, currentBestCost, baselineQuality, currentBestQuality)
   - Evaluate the modified agent in the worktree via \`runEval\` (use \`worktreeTargetPath\` as agentPath)
   - Compare results via \`compareResults\`:
     - **"before"**: Use the calibration eval (or latest accepted iteration) raw samples — this drives cost/latency assessment
     - **"originalBaselineQuality"**: ALWAYS use the quality array from the "## Original Baseline (Quality Reference)" section — this enables hard quality gates
   - If \`compareResults\` returns \`hardReject\`, do NOT call \`acceptIteration\`. Read the \`detailsPath\` file from the candidate's \`runEval\` to diagnose the quality failure. Record the diagnosis in optimization.md when rejecting.
   - For quality beyond hard gates: review candidate per-query scores against original baseline quality in optimization.md's "## Original Baseline (Quality Reference)" section. Reason about whether any quality changes are acceptable given the cost/latency improvement.
   - Read the iteration agent's reasoning doc
   - Accept or reject with evidence-based reasoning
   - Update optimization.md
   - Decide whether to continue

3. **Stop** when: diminishing returns, quality floor, plateau (3+ consecutive rejections), or iteration ${opts.maxIterations} reached.

Important:
- Pass \`queriesPath: "${opts.queriesPath}"\` to every \`runEval\` call
- Store raw samples from each eval in optimization.md so you can use them for \`compareResults\`
- **Always pass \`originalBaselineQuality\`** to \`compareResults\` — extract the quality array from optimization.md's "## Original Baseline (Quality Reference)" section (or "## Baseline" in older formats). This enables hard quality gates that prevent catastrophic regressions.
- After an accept, use the accepted iteration's metrics as "before" for subsequent cost/latency comparisons. For quality, always reference the "## Original Baseline (Quality Reference)" section.
- Do NOT read the target agent's code. You are the loop manager, not the optimizer.
- Start iterations at ${opts.startIteration}

Begin with the calibration eval now.`;
  }

  return `# AutoPerf Optimization Run — ${opts.label} — Fresh Run

## Configuration
- **Target agent**: ${opts.targetPath}
- **Eval queries**: ${opts.queriesPath} (${opts.queryCount} queries)
- **Meta-knowledge**: ${opts.metaKnowledgePath}
- **Max iterations**: ${opts.maxIterations}
- **Eval tier**: ${opts.evalTier} (n=${opts.evalTier} per query)

## Instructions

This is a FRESH run. No optimization.md exists yet.

1. **Baseline**: Run \`runEval\` on the target agent (with \`evalType: "baseline"\`) to establish baseline metrics and generate the optimization profile. Pass \`profileOutputDir: ".autoperf/${opts.label}/profiles/"\` so profiles go to the canonical .autoperf/ location. Create \`optimization.md\` at \`.autoperf/${opts.label}/optimization.md\` with:

   **optimization.md section structure:**
   - **"## Original Baseline (Quality Reference)"** — aggregate metrics, raw quality samples array, per-query quality breakdown, and \`Query set hash: \\\`${opts.querySetHash}\\\`\`. Mark with \`<!-- PERMANENT — written during initial baseline eval, NEVER modified -->\`.
   - **"## Current Cost/Latency Reference"** — same aggregate metrics and raw samples initially (identical to baseline). Updated after calibration evals and accepted iterations. Mark with \`<!-- Updated on calibration evals and accepted iterations -->\`.
   - **"## Active Optimizations"** — empty initially.
   - **"## Learned Principles"** — empty initially.
   - **"## Iteration Log"** — empty initially.

2. **Iterate** (iterations 1 through ${opts.maxIterations}):
   - Spawn an iteration agent via \`spawnOptimizer\` — pass the iteration context params (totalIterations=${opts.maxIterations}, baselineCost, currentBestCost, baselineQuality, currentBestQuality)
   - Evaluate the modified agent in the worktree via \`runEval\` (use \`worktreeTargetPath\` as agentPath)
   - Compare results via \`compareResults\`:
     - **"before"**: Use the "## Current Cost/Latency Reference" raw samples (or latest accepted iteration) — this drives cost/latency assessment
     - **"originalBaselineQuality"**: ALWAYS use the quality array from the "## Original Baseline (Quality Reference)" section — this enables hard quality gates
   - If \`compareResults\` returns \`hardReject\`, do NOT call \`acceptIteration\`. Read the \`detailsPath\` file from the candidate's \`runEval\` to diagnose the quality failure. Record the diagnosis in optimization.md when rejecting.
   - For quality beyond hard gates: review candidate per-query scores against original baseline quality in optimization.md's "## Original Baseline (Quality Reference)" section. Reason about whether any quality changes are acceptable given the cost/latency improvement.
   - Read the iteration agent's reasoning doc
   - Accept or reject with evidence-based reasoning
   - Update optimization.md
   - Decide whether to continue

3. **Stop** when: diminishing returns, quality floor, plateau (3+ consecutive rejections), or iteration ${opts.maxIterations} reached.

Important:
- Pass \`queriesPath: "${opts.queriesPath}"\` to every \`runEval\` call
- Store raw samples from each eval in optimization.md so you can use them for \`compareResults\`
- **Always pass \`originalBaselineQuality\`** to \`compareResults\` — extract the quality array from optimization.md's "## Original Baseline (Quality Reference)" section. This enables hard quality gates that prevent catastrophic regressions.
- After an accept, use the accepted iteration's metrics as "before" for subsequent cost/latency comparisons. For quality, always reference the "## Original Baseline (Quality Reference)" section.
- Do NOT read the target agent's code. You are the loop manager, not the optimizer.

Begin with the baseline eval now.`;
}

// ── Stream parser for human-readable output ─────────────────────────────

/**
 * Parse a single NDJSON line and print a human-readable summary.
 * Returns void — side-effects only (console output).
 */
function handleStreamEvent(line: string): void {
  let event: StreamEvent;
  try {
    event = JSON.parse(line);
  } catch {
    return; // skip malformed lines
  }

  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_use" && block.name) {
        const label = formatToolCall(block.name, block.input);
        if (label) console.log(`[autoperf] ${label}`);
      }
      if (block.type === "text" && block.text) {
        // Print orchestrator reasoning — trim to avoid excessive blank lines
        const text = block.text.trim();
        if (text) {
          for (const textLine of text.split("\n")) {
            console.log(`  ${textLine}`);
          }
        }
      }
    }
  }

  if (event.type === "result") {
    console.log("");
    console.log("[autoperf] Orchestrator finished");
    if (event.total_cost_usd !== undefined) {
      console.log(
        `[autoperf] Orchestrator cost: $${event.total_cost_usd.toFixed(2)}`,
      );
    }
    if (event.duration_ms !== undefined) {
      const mins = Math.floor(event.duration_ms / 60000);
      const secs = Math.round((event.duration_ms % 60000) / 1000);
      console.log(`[autoperf] Duration: ${mins}m ${secs}s`);
    }
    if (event.num_turns !== undefined) {
      console.log(`[autoperf] Turns: ${event.num_turns}`);
    }
  }
}

/** CC internal tools that don't need to be shown to the user */
const CC_INTERNAL_TOOLS = new Set([
  "ToolSearch",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "Agent",
  "NotebookEdit",
]);

function formatToolCall(
  rawName: string,
  input?: Record<string, unknown>,
): string | null {
  // Strip MCP server prefix: mcp__autoperf__runEval → runEval
  const name = rawName.replace(/^mcp__autoperf__/, "");

  // Suppress CC internal tools
  if (CC_INTERNAL_TOOLS.has(name)) return null;

  switch (name) {
    case "runEval": {
      const agentPath = input?.agentPath as string | undefined;
      const label = agentPath?.includes(".autoperf/worktrees")
        ? "Running eval on worktree agent..."
        : "Running eval on target agent...";
      return label;
    }
    case "compareResults":
      return "Comparing before/after results...";
    case "spawnOptimizer": {
      const iter = input?.iterationNumber as number | undefined;
      return `Spawning iteration ${iter ?? "?"} agent...`;
    }
    case "acceptIteration": {
      const iter = input?.iterationNumber as number | undefined;
      return `Accepting iteration ${iter ?? "?"}`;
    }
    case "rejectIteration": {
      const iter = input?.iterationNumber as number | undefined;
      return `Rejecting iteration ${iter ?? "?"}`;
    }
    default:
      return `Calling ${name}...`;
  }
}

// ── Command registration ────────────────────────────────────────────────

export function registerOptimizeCommand(program: Command): void {
  program
    .command("optimize")
    .description("Run the full optimization loop on an AI agent")
    .requiredOption(
      "--target <path>",
      "Path to agent directory containing agent.ts",
    )
    .requiredOption("--queries <path>", "Path to queries JSON file")
    .option(
      "--iterations <n>",
      "Maximum number of optimization iterations",
      "10",
    )
    .option(
      "--model <model>",
      "Claude model for the orchestrator (opus, sonnet, haiku)",
      "opus",
    )
    .option("--eval-tier <n>", "Evaluation tier (runs per query)", "1")
    .option("--continue", "Continue from existing optimization.md")
    .option(
      "--fresh",
      "Clean all autoperf artifacts and start fresh (deletes .autoperf/{target}/)",
    )
    .option("--no-report", "Skip HTML report generation")
    .action(async (opts) => {
      try {
        // Load .env from user's cwd
        config();

        // ── Resolve paths ───────────────────────────────────────────
        const repoRoot = process.cwd();
        const targetPath = isAbsolute(opts.target)
          ? opts.target
          : resolve(repoRoot, opts.target);
        const queriesPath = isAbsolute(opts.queries)
          ? opts.queries
          : resolve(repoRoot, opts.queries);
        const metaKnowledgePath = resolveMetaKnowledge();
        const mcpServerPath = resolveMcpServer();
        const maxIterations = parseInt(opts.iterations, 10);
        const evalTier = parseInt(opts.evalTier, 10);
        const model: string = opts.model;
        const isContinue: boolean = !!opts.continue;
        const isFresh: boolean = !!opts.fresh;
        const label = basename(targetPath);

        // ── Validate numeric args ───────────────────────────────────
        if (!Number.isInteger(maxIterations) || maxIterations < 1) {
          console.error("Error: --iterations must be a positive integer.");
          process.exit(1);
        }
        if (!Number.isInteger(evalTier) || evalTier < 1) {
          console.error("Error: --eval-tier must be a positive integer.");
          process.exit(1);
        }

        // ── Validate flags ──────────────────────────────────────────
        if (isContinue && isFresh) {
          console.error(
            "Error: --continue and --fresh are mutually exclusive.",
          );
          process.exit(1);
        }

        // ── Preflight: target directory ─────────────────────────────
        try {
          await access(join(targetPath, "agent.ts"));
        } catch {
          console.error(`Error: ${targetPath}/agent.ts not found.`);
          console.error(
            "The target directory must contain an agent.ts that exports createAgent().",
          );
          process.exit(1);
        }

        // ── Preflight: queries file ─────────────────────────────────
        try {
          await access(queriesPath);
        } catch {
          console.error(`Error: Queries file not found: ${queriesPath}`);
          process.exit(1);
        }

        // ── Preflight: ANTHROPIC_API_KEY ────────────────────────────
        if (!process.env.ANTHROPIC_API_KEY) {
          console.error(
            "Error: ANTHROPIC_API_KEY not set.\n" +
              "The MCP server needs this key for quality judging.\n" +
              "Set ANTHROPIC_API_KEY in your .env file or environment.",
          );
          process.exit(1);
        }

        // ── Preflight: Claude Code available + plugin check ────────
        // Run --version (blocking) and plugin list (non-blocking) in parallel
        {
          const versionCheck = execa(
            "npx",
            ["@anthropic-ai/claude-code", "--version"],
            { timeout: 30_000 },
          ).catch(() => null);

          const pluginCheck = execa(
            "npx",
            ["@anthropic-ai/claude-code", "plugin", "list"],
            { timeout: 30_000 },
          ).catch(() => null);

          const [versionResult, pluginResult] = await Promise.all([
            versionCheck,
            pluginCheck,
          ]);

          if (!versionResult) {
            console.error(
              "Error: Claude Code not available.\n" +
                "Install or authenticate: npx @anthropic-ai/claude-code auth login",
            );
            process.exit(1);
          }

          // Warn about missing plugins (non-blocking)
          if (pluginResult?.stdout) {
            const installed = pluginResult.stdout;
            const missing: string[] = [];
            if (!installed.includes("typescript-lsp"))
              missing.push("typescript-lsp");
            if (!installed.includes("vercel")) missing.push("vercel");
            if (missing.length > 0) {
              console.log(
                `[autoperf] Warning: CC plugins not installed: ${missing.join(", ")}`,
              );
              console.log(
                "[autoperf] Iteration agents work without them but perform better with LSP + Vercel knowledge.",
              );
              console.log("[autoperf] Run: npx autoperf setup\n");
            }
          }
        }

        // ── Ensure .autoperf/{target}/ directory structure ──────────
        const autoperfPaths = await ensureAutoperfDir(repoRoot, label);

        // ── Clean up orphaned worktrees from prior crashes ──────────
        const cleanedWorktrees = await cleanupOrphanedWorktrees(repoRoot);
        if (cleanedWorktrees.length > 0) {
          console.log(
            `[autoperf] Cleaned ${cleanedWorktrees.length} orphaned worktree(s) from a prior run.`,
          );
        }

        // ── Handle --fresh ──────────────────────────────────────────
        if (isFresh) {
          if (existsSync(autoperfPaths.root)) {
            console.log("[autoperf] --fresh: cleaning autoperf artifacts...");
            await cleanAutoperfArtifacts(repoRoot, label);
          }
        }

        // ── Detect fresh vs continuation ────────────────────────────
        const hasOptimizationMd = existsSync(autoperfPaths.optimizationMd);

        if (isContinue && !hasOptimizationMd) {
          console.error(
            `Error: --continue specified but no optimization.md found at ${autoperfPaths.optimizationMd}`,
          );
          process.exit(1);
        }

        if (!isContinue && !isFresh && hasOptimizationMd) {
          console.error(
            `Error: Found existing optimization.md at ${autoperfPaths.optimizationMd}\n` +
              "Use --continue to resume the prior run, or --fresh to start over.",
          );
          process.exit(1);
        }

        let isContinuation = false;
        let startIteration = 1;
        if (isContinue) {
          const state = detectContinuationState(repoRoot, label);
          isContinuation = state.isContinuation;
          startIteration = state.startIteration;
        }

        // ── Load and count queries ──────────────────────────────────
        const { count: queryCount } = loadQueries(queriesPath);
        const querySetHash = computeQuerySetHash(queriesPath);

        // ── Check query set hash on continuation ────────────────────
        if (isContinuation) {
          const storedHash = extractStoredQueryHash(
            autoperfPaths.optimizationMd,
          );
          if (storedHash && storedHash !== querySetHash) {
            console.error(
              `Error: Query set changed since the original baseline.\n` +
                `  Baseline hash: ${storedHash}\n` +
                `  Current hash:  ${querySetHash}\n` +
                `Use --fresh to start a new optimization run with the updated query set.`,
            );
            process.exit(1);
          }
        }

        // ── Generate orchestrator MCP config ────────────────────────
        const mcpConfig = buildOrchestratorMcpConfig(mcpServerPath);
        const tmpDir = mkdtempSync(join(tmpdir(), "autoperf-orchestrator-"));
        const mcpConfigPath = join(tmpDir, "mcp.json");
        writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

        // ── Generate prompts ────────────────────────────────────────
        const systemPrompt = getOrchestratorSystemPrompt({
          targetAgentPath: targetPath,
          queriesPath,
          metaKnowledgePath,
          queryCount,
        });

        const userPrompt = buildUserPrompt({
          targetPath,
          queriesPath,
          metaKnowledgePath,
          queryCount,
          maxIterations,
          evalTier,
          label,
          isContinuation,
          startIteration,
          querySetHash,
        });

        // ── Print preflight report ──────────────────────────────────
        console.log("");
        console.log("AutoPerf Optimize");
        console.log("\u2500".repeat(65));
        console.log(`Target:      ${targetPath}`);
        console.log(`Queries:     ${queriesPath} (${queryCount} queries)`);
        console.log(
          `Mode:        ${isContinuation ? `continuation (iter ${startIteration}-${maxIterations})` : `fresh (iter 1-${maxIterations})`}`,
        );
        console.log(`Model:       ${model}`);
        console.log(`Eval tier:   ${evalTier}`);
        console.log("");

        // ── Security warning ────────────────────────────────────────
        console.warn(
          "[autoperf] WARNING: The optimize command runs Claude Code with --dangerously-skip-permissions.",
        );
        console.warn(
          "[autoperf]          This grants the AI agent unrestricted shell access in the worktree.",
        );
        console.warn(
          "[autoperf]          Only run this on code you trust, in an environment you control.",
        );
        console.log("");

        // ── Build CC args ───────────────────────────────────────────
        const ccArgs = [
          "@anthropic-ai/claude-code",
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          "--no-session-persistence",
          "--dangerously-skip-permissions",
          "--model",
          model,
          "--mcp-config",
          mcpConfigPath,
          "--strict-mcp-config",
          "--append-system-prompt",
          systemPrompt,
        ];

        // ── Strip ANTHROPIC_API_KEY from CC env (D2) ────────────────
        // CC should use its own auth (Max subscription or `claude auth login`)
        // not the API key. The MCP server loads .env independently.
        const env = { ...process.env };
        if (env.ANTHROPIC_API_KEY) {
          env._ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
          delete env.ANTHROPIC_API_KEY;
        }

        // ── Launch CC orchestrator ──────────────────────────────────
        console.log("[autoperf] Launching orchestrator...");
        console.log("");

        let ccProcess: ResultPromise | null = null;

        // Graceful shutdown on SIGINT/SIGTERM
        const cleanup = () => {
          console.log("\n[autoperf] Shutting down...");
          if (ccProcess) {
            ccProcess.kill("SIGTERM");
          }
          // Clean up temp files
          try {
            rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            // best effort
          }
          // Clean up orphaned worktrees
          try {
            const worktreesDir = resolve(repoRoot, ".autoperf", "worktrees");
            if (existsSync(worktreesDir)) {
              rmSync(worktreesDir, { recursive: true, force: true });
            }
            execSync("git worktree prune", { cwd: repoRoot });
          } catch {
            // best effort — startup cleanup catches anything missed
          }
          process.exit(130);
        };
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);

        ccProcess = execa("npx", ccArgs, {
          input: userPrompt,
          cwd: repoRoot,
          env,
          extendEnv: false,
          timeout: 120 * 60 * 1000, // 2 hours — optimization runs are long
          reject: false,
          stdout: "pipe",
          stderr: "inherit",
        });

        // Stream stdout line-by-line for human-readable output
        if (ccProcess.stdout) {
          let buffer = "";
          ccProcess.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            // Keep the last incomplete line in the buffer
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line.trim()) {
                handleStreamEvent(line);
              }
            }
          });
          ccProcess.stdout.on("end", () => {
            // Flush remaining buffer
            if (buffer.trim()) {
              handleStreamEvent(buffer);
            }
          });
        }

        const result = await ccProcess;

        // Clean up signal handlers
        process.removeListener("SIGINT", cleanup);
        process.removeListener("SIGTERM", cleanup);

        // Clean up temp files
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best effort
        }

        if (result.timedOut) {
          console.error(
            "\n[autoperf] Error: Orchestrator timed out (2h limit).",
          );
          process.exit(1);
        }

        if (result.exitCode !== 0) {
          console.error(
            `\n[autoperf] Orchestrator exited with code ${result.exitCode}`,
          );
          process.exit(1);
        }

        console.log("\n[autoperf] Optimization complete.");

        // Generate HTML report
        if (opts.report !== false) {
          try {
            console.log("[autoperf] Generating report...");
            const reportPath = await generateReport(
              autoperfPaths.root,
              "optimize",
            );
            console.log(`[autoperf] Report: ${reportPath}`);
          } catch (reportErr) {
            console.error(
              `[autoperf] Warning: report generation failed: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`,
            );
          }
        }
      } catch (err) {
        console.error(
          `\n[autoperf] Error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (err instanceof Error && err.stack) {
          console.error(err.stack);
        }
        process.exit(1);
      }
    });
}
