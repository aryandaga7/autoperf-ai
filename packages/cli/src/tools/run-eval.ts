import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, isAbsolute, join } from "node:path";
import { runEval as runEvalCore } from "../eval/run-eval.js";
import { generateProfile } from "../eval/profile-generator.js";
import type { EvalQuery, EvalRunResult, JudgeConfig } from "../eval/types.js";

/** Compact per-query summary (no full response text, steps, or judge reasoning). */
export interface QuerySummary {
  query: string;
  cost: number;
  quality: number;
  latencyMs: number;
  tokens: number;
  steps: number;
  error?: string;
}

/**
 * Compact result returned via MCP. Full details are written to disk.
 * Contains everything the orchestrator needs for accept/reject decisions
 * and compareResults calls, without the 100K+ char per-query response text.
 */
export interface RunEvalToolResult {
  aggregate: EvalRunResult["aggregate"];
  rawSamples: EvalRunResult["rawSamples"];
  profilePath: string;
  detailsPath: string;
  querySummaries: QuerySummary[];
}

const DEFAULT_QUERIES_PATH = "context/evals/weather-queries.json";

/**
 * Load eval queries from a JSON file.
 * Path is resolved relative to process.cwd() (project root).
 */
async function loadQueries(queriesPath: string): Promise<EvalQuery[]> {
  const absPath = isAbsolute(queriesPath)
    ? queriesPath
    : resolve(process.cwd(), queriesPath);
  const raw = await readFile(absPath, "utf-8");
  const parsed = JSON.parse(raw);
  // Support both bare-array [{query, ...}] and wrapped {queries: [{query, ...}]} formats
  const queries: EvalQuery[] = Array.isArray(parsed) ? parsed : parsed.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error(
      `Queries file must contain a non-empty array. ` +
        `Expected [{query, expectedBehavior}] or {queries: [{query, expectedBehavior}]}. ` +
        `Got: ${typeof parsed}`,
    );
  }
  return queries;
}

/**
 * runEval tool handler.
 *
 * Runs a target agent against eval queries, returns structured metrics.
 * Wraps the core runEval function from eval/run-eval.ts.
 *
 * profileOutputDir: optional override for where profiles are written.
 * If omitted, defaults to {agentPath}/profiles/ (backward-compatible).
 * Pass .autoperf/{target}/profiles/ for main-tree baseline evals so that
 * profiles go to the canonical .autoperf/ location, not the target dir.
 */
export async function handleRunEval(args: {
  agentPath: string;
  queriesPath?: string;
  judgeConfig?: JudgeConfig;
  concurrency?: number;
  profileOutputDir?: string;
}): Promise<RunEvalToolResult> {
  // Resolve agent path to absolute
  const agentPath = isAbsolute(args.agentPath)
    ? args.agentPath
    : resolve(process.cwd(), args.agentPath);

  // Load queries
  const queriesPath = args.queriesPath ?? DEFAULT_QUERIES_PATH;
  const queries = await loadQueries(queriesPath);

  const concurrency = args.concurrency ?? 3;

  console.error(
    `[autoperf] runEval: agent=${agentPath}, queries=${queriesPath} (${queries.length} queries, concurrency=${concurrency})`,
  );

  const result = await runEvalCore(
    agentPath,
    queries,
    { concurrency },
    args.judgeConfig,
  );

  console.error(
    `[autoperf] runEval complete: ${result.aggregate.totalTokens} tokens, $${result.aggregate.totalCost.toFixed(4)}, avg quality ${result.aggregate.avgQuality.toFixed(2)}`,
  );

  // Resolve profile output directory.
  // If profileOutputDir is provided (absolute or relative to cwd), use it.
  // Otherwise default to {agentPath}/profiles/ for backward compatibility
  // (worktree evals write to the worktree — picked up by preserveEvalProfiles).
  const profileDir = args.profileOutputDir
    ? isAbsolute(args.profileOutputDir)
      ? args.profileOutputDir
      : resolve(process.cwd(), args.profileOutputDir)
    : join(agentPath, "profiles");

  // Generate optimization profile and write to disk
  const profile = generateProfile(result);
  await mkdir(profileDir, { recursive: true });
  const safeTimestamp = result.timestamp.replace(/[:.]/g, "-");
  const profilePath = join(profileDir, `eval-${safeTimestamp}.md`);
  await writeFile(profilePath, profile, "utf-8");

  // P7: Write full eval details to disk (response text, steps, judge reasoning)
  // so the MCP response stays compact. The orchestrator can read this file
  // if it needs to drill down into per-query details.
  const detailsPath = join(profileDir, `eval-${safeTimestamp}-details.json`);
  await writeFile(detailsPath, JSON.stringify(result, null, 2), "utf-8");

  console.error(`[autoperf] Profile written to ${profilePath}`);
  console.error(`[autoperf] Full details written to ${detailsPath}`);

  // Build compact per-query summaries (no response text, no steps, no judge reasoning)
  const querySummaries: QuerySummary[] = result.queries.map((q) => ({
    query: q.query,
    cost: q.cost,
    quality: q.quality.overall,
    latencyMs: q.totalLatencyMs,
    tokens: q.totalTokens,
    steps: q.steps.length,
    ...(q.error ? { error: q.error } : {}),
  }));

  return {
    aggregate: result.aggregate,
    rawSamples: result.rawSamples,
    profilePath,
    detailsPath,
    querySummaries,
  };
}
