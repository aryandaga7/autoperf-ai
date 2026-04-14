// Register tsx ESM loader BEFORE any other imports that might trigger
// dynamic import of .ts files. The MCP server is spawned as `node dist/mcp-server.js`
// and needs tsx for dynamically importing target agent.ts files during eval.
import { register } from "node:module";
try {
  register("tsx/esm", import.meta.url);
} catch {
  // tsx may not be installed in all environments — the server can still
  // function for non-eval tools. If runEval is called without tsx, it
  // will fail with a clear "cannot import .ts" error.
}

import { readFileSync } from "node:fs";
import { readdir, copyFile, mkdir } from "node:fs/promises";
import { resolve, join, basename, isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleRunEval } from "./tools/run-eval.js";
import { handleCompareResults } from "./tools/compare-results.js";
import { handleSpawnOptimizer } from "./tools/spawn-optimizer.js";
import { mergeWorktree, removeWorktree } from "./infra/git-ops.js";
import { EventEmitter } from "./infra/event-emitter.js";
import { getAutoperfPaths } from "./infra/autoperf-dir.js";

// Load .env from the working directory. The MCP server is spawned by CC as a
// child process — most env vars are inherited, but attempt to load any missing
// vars from .env so that all keys (ANTHROPIC_API_KEY, CONTEXT7_API_KEY,
// NIA_API_KEY, etc.) are available.
{
  const envPath = resolve(process.cwd(), ".env");
  try {
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=['"]?(.+?)['"]?$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
    console.error(`[autoperf] Loaded env from ${envPath}`);
  } catch {
    // .env not found — rely on inherited environment variables.
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "[autoperf] WARNING: ANTHROPIC_API_KEY not found in environment or .env",
    );
  }
}

const server = new McpServer({
  name: "autoperf",
  version: "0.1.0",
});

// ── Lazy event emitter ──────────────────────────────────────────────
// Writes lifecycle events to .autoperf/{target}/events.jsonl.
// NOTE: Singleton — first call with a targetDir sets the output directory
// for the lifetime of the process. This is single-target-only; if multi-target
// optimization is added, convert to a Map keyed by resolved directory.
let _emitter: EventEmitter | null = null;
function getEmitter(targetDir?: string): EventEmitter {
  if (!_emitter) {
    // EventEmitter writes to {outputDir}/autoperf-events.jsonl.
    // We pass .autoperf/{target}/ as outputDir so events land at
    // .autoperf/{target}/autoperf-events.jsonl.
    let outputDir: string;
    if (targetDir) {
      const resolvedDir = isAbsolute(targetDir)
        ? targetDir
        : resolve(process.cwd(), targetDir);
      const mainTreeDir = resolveToMainTree(resolvedDir);
      const targetName = basename(mainTreeDir);
      outputDir = getAutoperfPaths(process.cwd(), targetName).root;
    } else {
      outputDir = process.cwd();
    }
    _emitter = new EventEmitter(outputDir);
  }
  return _emitter;
}

/**
 * Resolve a path that may be inside a worktree back to its main-tree
 * equivalent. Worktrees live under `.autoperf/worktrees/{id}/` and mirror
 * the repo structure, so we strip the worktree prefix to get the main path.
 */
function resolveToMainTree(agentPath: string): string {
  const marker = ".autoperf/worktrees";
  const idx = agentPath.indexOf(marker);
  if (idx === -1) return agentPath;
  const repoRoot = agentPath.slice(0, idx).replace(/\/$/, "");
  const rest = agentPath.slice(idx + marker.length);
  // rest is "/{worktreeId}/{relPath...}"
  // We need to skip the worktreeId segment (first path component after marker)
  const secondSlash = rest.indexOf("/", 1);
  if (secondSlash === -1) return agentPath;
  return join(repoRoot, rest.slice(secondSlash + 1));
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Preserve iteration reasoning docs from a worktree before removal.
 *
 * Scans the worktree for `iteration-reasoning/iter-*.md` files and copies
 * them to `.autoperf/{targetName}/iteration-reasoning/`. This ensures
 * reasoning docs from both accepted and rejected iterations are preserved
 * in the canonical .autoperf/ location.
 *
 * Best-effort — failures are logged but don't block accept/reject.
 */
async function preserveReasoningDocs(
  worktreePath: string,
  repoRoot: string,
  targetName: string,
): Promise<string[]> {
  const preserved: string[] = [];
  const paths = getAutoperfPaths(repoRoot, targetName);

  try {
    const allEntries = await readdir(worktreePath, { recursive: true });
    const reasoningDocs = (allEntries as string[]).filter(
      (f) =>
        /iteration-reasoning[\\/]iter-\d+\.md$/.test(f) &&
        !f.includes("node_modules") &&
        !f.startsWith(".git"),
    );

    await mkdir(paths.reasoning, { recursive: true });

    for (const relPath of reasoningDocs) {
      const destPath = join(paths.reasoning, basename(relPath));
      try {
        await copyFile(join(worktreePath, relPath), destPath);
        preserved.push(basename(relPath));
        console.error(
          `[autoperf] Preserved reasoning doc: ${basename(relPath)}`,
        );
      } catch (err) {
        console.error(
          `[autoperf] Warning: could not copy reasoning doc ${relPath}: ${err}`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[autoperf] Warning: could not scan worktree for reasoning docs: ${err}`,
    );
  }

  return preserved;
}

/**
 * Preserve eval profiles and details from a worktree before removal.
 *
 * Copies all `profiles/eval-*` files from the worktree's target directory
 * to `.autoperf/{targetName}/profiles/`, prefixed with `iter-{N}-` so
 * profiles from different iterations don't collide. No git commits.
 *
 * Best-effort — failures are logged but don't block accept/reject.
 */
async function preserveEvalProfiles(
  worktreePath: string,
  repoRoot: string,
  targetDir: string,
  iterationNumber: number,
  targetName: string,
): Promise<string[]> {
  const preserved: string[] = [];
  const paths = getAutoperfPaths(repoRoot, targetName);

  try {
    const absTargetDir = isAbsolute(targetDir)
      ? targetDir
      : resolve(repoRoot, targetDir);
    const relTargetDir = absTargetDir.startsWith(repoRoot + "/")
      ? absTargetDir.slice(repoRoot.length + 1)
      : absTargetDir;
    const worktreeProfilesDir = join(worktreePath, relTargetDir, "profiles");

    let entries: string[];
    try {
      const dirEntries = await readdir(worktreeProfilesDir);
      entries = dirEntries.filter((f) => f.startsWith("eval-"));
    } catch {
      return preserved; // profiles dir doesn't exist in worktree
    }

    await mkdir(paths.profiles, { recursive: true });

    for (const file of entries) {
      const destName = `iter-${iterationNumber}-${file}`;
      try {
        await copyFile(
          join(worktreeProfilesDir, file),
          join(paths.profiles, destName),
        );
        preserved.push(destName);
        console.error(`[autoperf] Preserved eval profile: ${destName}`);
      } catch (err) {
        console.error(
          `[autoperf] Warning: could not copy profile ${file}: ${err}`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[autoperf] Warning: could not preserve eval profiles: ${err}`,
    );
  }
  return preserved;
}

// ── runEval ──────────────────────────────────────────────────────────
// Runs a target agent against eval queries, returns structured metrics.
// CC uses this to measure agent performance before and after optimizations.

server.tool(
  "runEval",
  "Run a target AI SDK agent against eval queries and collect metrics (tokens, latency, cost, quality). Returns compact JSON with aggregate metrics, rawSamples (for compareResults), per-query summaries, profilePath, and detailsPath. Full per-query details (response text, steps, judge reasoning) are written to detailsPath on disk. The optimization profile (per-step cost breakdown, context growth, tool/model usage) is written to profilePath on disk.",
  {
    agentPath: z
      .string()
      .describe(
        "Path to the target agent directory (relative to project root or absolute). Must contain agent.ts exporting createAgent().",
      ),
    queriesPath: z
      .string()
      .optional()
      .describe(
        "Path to eval queries JSON file (relative to project root or absolute). Defaults to context/evals/weather-queries.json.",
      ),
    concurrency: z
      .number()
      .optional()
      .describe(
        "Number of eval queries to run in parallel. Default: 3. Higher values reduce wall-clock time but increase API rate-limit pressure. Recommended: 3-5.",
      ),
    profileOutputDir: z
      .string()
      .optional()
      .describe(
        "Override directory for profile and details output. If omitted, writes to {agentPath}/profiles/. Pass .autoperf/{target}/profiles/ for main-tree baseline evals.",
      ),
    evalType: z
      .enum(["baseline", "calibration", "iteration"])
      .optional()
      .describe(
        "Tag for this eval run. 'baseline' for initial baseline, " +
          "'calibration' for continuation re-eval (cost/latency reference only), " +
          "'iteration' for post-optimization eval. Default: 'iteration'.",
      ),
  },
  async (args) => {
    try {
      const result = await handleRunEval(args);
      await getEmitter(args.agentPath).emit({
        type: "eval:completed",
        data: {
          evalType: args.evalType ?? "iteration",
          agentPath: args.agentPath,
          totalCost: result.aggregate.totalCost,
          avgQuality: result.aggregate.avgQuality,
          totalTokens: result.aggregate.totalTokens,
          avgLatencyMs: result.aggregate.avgLatencyMs,
          profilePath: result.profilePath,
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `runEval error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ── compareResults ───────────────────────────────────────────────────
// Statistical comparison of two eval runs. Returns raw analysis — CC
// reads the effect sizes, p-values, and regression flags to decide
// accept/reject.

const evalSamplesSchema = z.object({
  aggregate: z.object({
    totalTokens: z.number(),
    avgLatencyMs: z.number(),
    totalCost: z.number(),
    avgQuality: z.number(),
  }),
  rawSamples: z.object({
    tokens: z.array(z.number()),
    latency: z.array(z.number()),
    cost: z.array(z.number()),
    quality: z.array(z.number()),
  }),
});

server.tool(
  "compareResults",
  "Compare before/after eval results with statistical analysis. Returns per-metric effect sizes, Wilcoxon signed-rank p-values (primary, for paired before/after on the same queries) with Mann-Whitney U as fallback, Cliff's Delta, MAD confidence, and regression flags. When originalBaselineQuality is provided, also runs hard quality gates (absolute floor + baseline regression) and returns a hardReject field if violated. Does NOT issue a verdict — you decide accept/reject based on the evidence, but if hardReject is present you MUST reject.",
  {
    before: evalSamplesSchema.describe(
      "Baseline eval result (aggregate + rawSamples from a previous runEval call).",
    ),
    after: evalSamplesSchema.describe(
      "Post-optimization eval result (aggregate + rawSamples from a runEval call after changes).",
    ),
    originalBaselineQuality: z
      .array(z.number())
      .optional()
      .describe(
        "Per-query quality scores from the ORIGINAL baseline eval (not current-best). " +
          "Enables hard quality gates: absolute floor check (reject if any query < 2.0 " +
          "unless it was already below 2.0 at baseline) and baseline regression check " +
          "(reject if any query drops > 2.0 points from baseline). Pass the quality " +
          'array from optimization.md\'s "## Original Baseline (Quality Reference)" section ' +
          '(or "## Baseline" in older formats).',
      ),
  },
  async (args) => {
    try {
      const result = handleCompareResults(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `compareResults error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ── spawnOptimizer ───────────────────────────────────────────────────
// Spawns an autonomous iteration agent to discover and implement
// optimizations. Receives file paths (profile, state, meta-knowledge)
// — no prescriptive instructions. Returns structured result with
// reasoning doc path for orchestrator to read.

server.tool(
  "spawnOptimizer",
  "Spawn an autonomous iteration agent in an isolated git worktree. The agent receives the optimization profile, state file, and meta-knowledge as file paths — no prescriptive instructions. It researches via Context7 + Nia, implements domain-scoped changes, verifies they work, writes a reasoning doc, and commits. Returns worktreeTargetPath (for post-change runEval), worktreePath + branchName (for acceptIteration/rejectIteration), reasoning doc path, files changed, and cost.",
  {
    targetDir: z
      .string()
      .describe(
        "Path to the target agent directory (relative to project root or absolute). The iteration agent's working directory.",
      ),
    optimizationProfilePath: z
      .string()
      .describe(
        "Path to the optimization profile Markdown file (from runEval's profilePath output). Shows per-step cost breakdown, context growth, tool/model usage.",
      ),
    optimizationMdPath: z
      .string()
      .describe(
        "Path to the optimization.md state file for this target. Tracks baseline, current best, iteration log, active optimizations, learned principles.",
      ),
    metaKnowledgePath: z
      .string()
      .describe(
        "Path to the meta-knowledge file. Categories of optimization with SDK concept pointers and research directions.",
      ),
    iterationNumber: z
      .number()
      .describe(
        "Which iteration number this is (1-indexed). Used for reasoning doc naming (iter-{N}.md) and tracking.",
      ),
    model: z
      .string()
      .optional()
      .describe('CC model for the iteration agent. Defaults to "sonnet".'),
    totalIterations: z
      .number()
      .optional()
      .describe("Total planned iterations for this optimization run."),
    baselineCost: z
      .number()
      .optional()
      .describe(
        "Baseline total cost from initial eval (before any optimizations).",
      ),
    currentBestCost: z
      .number()
      .optional()
      .describe("Current best total cost from most recent accepted eval."),
    baselineQuality: z
      .number()
      .optional()
      .describe("Baseline average quality score (1-5)."),
    currentBestQuality: z
      .number()
      .optional()
      .describe("Current best average quality score (1-5)."),
  },
  async (args) => {
    try {
      const result = await handleSpawnOptimizer(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `spawnOptimizer error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ── acceptIteration ──────────────────────────────────────────────────
// Merges the iteration agent's worktree branch into main (accept path).
// The worktree directory is removed but the branch is kept for traceability.

server.tool(
  "acceptIteration",
  "Accept an iteration's changes by merging its worktree branch into main via fast-forward. Call after evaluating and comparing results. Removes the worktree directory, keeps the branch for traceability.",
  {
    worktreePath: z
      .string()
      .describe("Worktree root directory path (from spawnOptimizer result)."),
    branchName: z
      .string()
      .describe("Git branch name (from spawnOptimizer result)."),
    targetDir: z
      .string()
      .describe(
        "Path to the target agent directory on main tree (e.g., targets/agent-b). Used to preserve eval profiles.",
      ),
    iterationNumber: z
      .number()
      .describe(
        "Iteration number (1-indexed). Used to prefix preserved eval profile filenames.",
      ),
  },
  async (args) => {
    try {
      const repoRoot = process.cwd();
      const targetName = basename(
        isAbsolute(args.targetDir)
          ? args.targetDir
          : resolve(repoRoot, args.targetDir),
      );

      // Preserve reasoning docs from worktree BEFORE merge.
      // The worktree .gitignore prevents the iteration agent from committing
      // reasoning docs, so they won't arrive via ff merge — we copy them now.
      await preserveReasoningDocs(args.worktreePath, repoRoot, targetName);

      // Preserve eval profiles from worktree before merge+removal
      const preservedProfiles = await preserveEvalProfiles(
        args.worktreePath,
        repoRoot,
        args.targetDir,
        args.iterationNumber,
        targetName,
      );

      // Merge worktree branch into main. Working tree is clean (optimization.md
      // and profiles live in .autoperf/ which is gitignored) — no stash needed.
      await mergeWorktree(repoRoot, args.worktreePath, args.branchName);

      await getEmitter(args.targetDir).emit({
        type: "decision:made",
        data: {
          decision: "accept",
          branchName: args.branchName,
          preservedEvalProfiles: preservedProfiles,
        },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              accepted: true,
              merged: args.branchName,
              preservedEvalProfiles: preservedProfiles,
              message:
                "Worktree merged to main. Changes are now on main branch." +
                (preservedProfiles.length > 0
                  ? ` Preserved ${preservedProfiles.length} eval profile(s).`
                  : ""),
            }),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `acceptIteration error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ── rejectIteration ─────────────────────────────────────────────────
// Removes the iteration agent's worktree (reject path).
// Main branch remains unchanged. Branch is kept for traceability.

server.tool(
  "rejectIteration",
  "Reject an iteration's changes by removing its worktree. Main branch remains unchanged. The branch is kept for traceability (git log autoperf/iter-N).",
  {
    worktreePath: z
      .string()
      .describe("Worktree root directory path (from spawnOptimizer result)."),
    targetDir: z
      .string()
      .describe(
        "Path to the target agent directory on main tree (e.g., targets/agent-b). Used to preserve eval profiles.",
      ),
    iterationNumber: z
      .number()
      .describe(
        "Iteration number (1-indexed). Used to prefix preserved eval profile filenames.",
      ),
  },
  async (args) => {
    try {
      const repoRoot = process.cwd();
      const targetName = basename(
        isAbsolute(args.targetDir)
          ? args.targetDir
          : resolve(repoRoot, args.targetDir),
      );

      // Preserve reasoning docs before removing worktree
      const preserved = await preserveReasoningDocs(
        args.worktreePath,
        repoRoot,
        targetName,
      );

      // Preserve eval profiles before removing worktree
      const preservedProfiles = await preserveEvalProfiles(
        args.worktreePath,
        repoRoot,
        args.targetDir,
        args.iterationNumber,
        targetName,
      );

      await removeWorktree(repoRoot, args.worktreePath);
      await getEmitter(args.targetDir).emit({
        type: "decision:made",
        data: {
          decision: "reject",
          worktreeRemoved: args.worktreePath,
          preservedReasoningDocs: preserved,
          preservedEvalProfiles: preservedProfiles,
        },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              rejected: true,
              worktreeRemoved: args.worktreePath,
              preservedReasoningDocs: preserved,
              preservedEvalProfiles: preservedProfiles,
              message:
                "Worktree removed. Main branch unchanged." +
                (preserved.length > 0
                  ? ` Preserved ${preserved.length} reasoning doc(s).`
                  : "") +
                (preservedProfiles.length > 0
                  ? ` Preserved ${preservedProfiles.length} eval profile(s).`
                  : ""),
            }),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `rejectIteration error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ── Start server ─────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[autoperf] MCP server started (stdio transport)");
}

main().catch((err) => {
  console.error("[autoperf] Fatal error starting MCP server:", err);
  process.exit(1);
});
