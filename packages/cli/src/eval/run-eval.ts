import { judgeQuality } from "./quality-judge.js";
import { computeCost } from "./pricing.js";
import type {
  EvalQuery,
  QueryResult,
  EvalRunResult,
  EvalRunOptions,
  JudgeConfig,
  StepMetrics,
} from "./types.js";

/**
 * Runs a target agent against a set of eval queries and returns structured metrics.
 *
 * Dynamically imports the target agent, extracts metrics from AI SDK result steps,
 * runs each query, scores quality, and aggregates results.
 *
 * Supports multi-run evaluation (runsPerQuery > 1): runs each query N times,
 * aggregates per-query results by median, and stores raw per-run data.
 * Also supports rate-limit protection via configurable delay and 429 backoff.
 *
 * @param agentPath - Absolute path to the target agent directory (must have agent.ts with createAgent())
 * @param queries - Array of eval queries to run
 * @param options - Multi-run and rate-limit options (optional, defaults to single-run, no delay)
 * @returns Structured eval results with per-query and aggregate metrics
 */
export async function runEval(
  agentPath: string,
  queries: EvalQuery[],
  options?: EvalRunOptions,
  judgeConfig?: JudgeConfig,
): Promise<EvalRunResult> {
  const runsPerQuery = Math.max(1, options?.runsPerQuery ?? 1);
  const delayMs = options?.delayBetweenQueriesMs ?? 0;
  const maxRetries = options?.maxRetries ?? 3;
  const concurrency = Math.max(1, options?.concurrency ?? 1);

  // Dynamic import of the target agent module.
  // Cache-bust with a timestamp so re-evals pick up code changes
  // made by the optimizer sub-agent between iterations.
  const agentModule = await import(`${agentPath}/agent.ts?t=${Date.now()}`);
  if (typeof agentModule.createAgent !== "function") {
    throw new Error(
      `${agentPath}/agent.ts must export a createAgent() function`,
    );
  }

  console.error(
    `[autoperf] Running ${queries.length} queries with concurrency=${concurrency}, runsPerQuery=${runsPerQuery}`,
  );

  // rawRunData[queryIdx][runIdx] = QueryResult for that run
  // Pre-allocate for deterministic ordering regardless of completion order
  const rawRunData: QueryResult[][] = new Array(queries.length);

  /**
   * Execute a single query (with all its runs) — one unit of work for the pool.
   * Each query gets its own agent instance to avoid shared state.
   */
  async function executeQuery(queryIdx: number): Promise<void> {
    const evalQuery = queries[queryIdx];
    const runsForQuery: QueryResult[] = [];

    for (let run = 0; run < runsPerQuery; run++) {
      if (run > 0 && delayMs > 0) {
        await sleep(delayMs);
      }

      // Fresh agent per run to avoid leaking mutable tool state
      // (e.g. findings array, counters) between independent samples
      const runAgent = agentModule.createAgent();

      console.error(
        `[autoperf] Query ${queryIdx + 1}/${queries.length}${runsPerQuery > 1 ? ` run ${run + 1}/${runsPerQuery}` : ""}: "${evalQuery.query.slice(0, 60)}..."`,
      );

      const result = await runSingleQuery(
        runAgent,
        evalQuery,
        maxRetries,
        judgeConfig,
      );
      runsForQuery.push(result);
    }

    rawRunData[queryIdx] = runsForQuery;
  }

  // Run queries through a concurrency-limited pool
  await runWithConcurrency(
    queries.map((_, idx) => () => executeQuery(idx)),
    concurrency,
  );

  // Aggregate: if multi-run, take median per query; if single-run, use directly
  const queryResults: QueryResult[] =
    runsPerQuery === 1
      ? rawRunData.map((runs) => runs[0])
      : rawRunData.map((runs, qIdx) =>
          aggregateRunsByMedian(runs, queries[qIdx].query),
        );

  // Compute aggregate metrics
  const successfulResults = queryResults.filter((r) => !r.error);
  const totalTokens = queryResults.reduce((sum, r) => sum + r.totalTokens, 0);
  const totalInputTokens = queryResults.reduce(
    (sum, r) => sum + r.totalInputTokens,
    0,
  );
  const totalOutputTokens = queryResults.reduce(
    (sum, r) => sum + r.totalOutputTokens,
    0,
  );
  const totalCost = queryResults.reduce((sum, r) => sum + r.cost, 0);
  const avgLatency =
    successfulResults.length > 0
      ? successfulResults.reduce((sum, r) => sum + r.totalLatencyMs, 0) /
        successfulResults.length
      : 0;
  const avgQuality =
    successfulResults.length > 0
      ? successfulResults.reduce((sum, r) => sum + r.quality.overall, 0) /
        successfulResults.length
      : 0;

  const result: EvalRunResult = {
    agentPath,
    timestamp: new Date().toISOString(),
    queries: queryResults,
    aggregate: {
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      avgTokensPerQuery:
        queryResults.length > 0 ? totalTokens / queryResults.length : 0,
      avgLatencyMs: avgLatency,
      totalCost,
      avgCost: queryResults.length > 0 ? totalCost / queryResults.length : 0,
      avgQuality,
    },
    rawSamples: {
      tokens: queryResults.map((r) => r.totalTokens),
      latency: queryResults.map((r) => r.totalLatencyMs),
      cost: queryResults.map((r) => r.cost),
      quality: queryResults.map((r) => r.quality.overall),
    },
  };

  if (runsPerQuery > 1) {
    result.rawRunData = rawRunData;
    result.runsPerQuery = runsPerQuery;
  }

  return result;
}

/**
 * Run a single query against the agent with 429 retry/backoff.
 *
 * Extracts metrics directly from the GenerateTextResult's `steps` and `totalUsage`
 * fields, which are populated by the AI SDK's ToolLoopAgent after execution.
 * This approach works with all agent types (ToolLoopAgent, generateText, etc.)
 * without requiring telemetry integration support.
 */
async function runSingleQuery(
  agent: {
    generate: (opts: Record<string, unknown>) => Promise<{
      text: string;
      steps?: Array<{
        stepNumber: number;
        model?: { modelId: string };
        usage: {
          inputTokens?: number;
          outputTokens?: number;
          inputTokenDetails?: {
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
        };
        finishReason: string;
        toolCalls?: Array<{ toolName: string; input?: unknown }>;
        response?: { modelId?: string };
      }>;
      totalUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: {
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
      };
    }>;
  },
  evalQuery: EvalQuery,
  maxRetries: number,
  judgeConfig?: JudgeConfig,
): Promise<QueryResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = 10_000 * Math.pow(2, attempt - 1); // 10s, 20s, 40s
      console.error(
        `[autoperf] 429 backoff: waiting ${backoffMs}ms before retry ${attempt}/${maxRetries}`,
      );
      await sleep(backoffMs);
    }

    const startTime = Date.now();

    try {
      const result = await agent.generate({
        prompt: evalQuery.query,
        timeout: 120_000, // 2 min — prevent hung agents from blocking eval
      });

      const totalLatencyMs = Date.now() - startTime;

      // Extract per-step metrics from the result's steps array
      const resultSteps = (result.steps ?? []) as Array<{
        stepNumber: number;
        model?: { modelId: string };
        usage: {
          inputTokens?: number;
          outputTokens?: number;
          inputTokenDetails?: {
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
        };
        finishReason: string;
        toolCalls?: Array<{ toolName: string; input?: unknown }>;
        response?: { modelId?: string };
      }>;

      const steps: StepMetrics[] = resultSteps.map((step) => ({
        stepNumber: step.stepNumber,
        modelId: step.response?.modelId ?? step.model?.modelId ?? "unknown",
        inputTokens: step.usage.inputTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0,
        totalTokens:
          (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0),
        cacheReadTokens: step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheWriteTokens: step.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        finishReason: step.finishReason,
        toolCalls: (step.toolCalls ?? []).map((tc) => tc.toolName),
        stepLatencyMs: 0, // per-step timing not available from result
      }));

      // Use totalUsage from result if available, otherwise sum steps
      const totalUsage = result.totalUsage;
      const totalInputTokens =
        totalUsage?.inputTokens ??
        steps.reduce((sum, s) => sum + s.inputTokens, 0);
      const totalOutputTokens =
        totalUsage?.outputTokens ??
        steps.reduce((sum, s) => sum + s.outputTokens, 0);
      const totalTokens = totalInputTokens + totalOutputTokens;
      const cacheReadTokens =
        totalUsage?.inputTokenDetails?.cacheReadTokens ??
        steps.reduce((sum, s) => sum + s.cacheReadTokens, 0);
      const cacheWriteTokens =
        totalUsage?.inputTokenDetails?.cacheWriteTokens ??
        steps.reduce((sum, s) => sum + s.cacheWriteTokens, 0);

      const modelId = steps[0]?.modelId ?? "unknown";
      const toolCallsMade = steps.flatMap((s) => s.toolCalls);

      // Extract tool call inputs for quality judge (text in tool args
      // is often the real deliverable, e.g. PR review body)
      const toolCallsWithArgs: Array<{ toolName: string; input: string }> =
        resultSteps.flatMap((step) =>
          (step.toolCalls ?? [])
            .filter((tc) => tc.input !== undefined)
            .map((tc) => ({
              toolName: tc.toolName,
              input:
                typeof tc.input === "string"
                  ? tc.input
                  : JSON.stringify(tc.input),
            })),
        );

      const cost = computeCost(
        modelId,
        totalInputTokens,
        totalOutputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      );

      // Judge quality (LLM call + deterministic signals)
      let quality: import("./types.js").QualityScore;
      try {
        quality = await judgeQuality(
          evalQuery.query,
          result.text,
          evalQuery,
          toolCallsMade,
          toolCallsWithArgs,
          judgeConfig,
        );
      } catch (judgeErr) {
        quality = {
          correctness: 0,
          relevance: 0,
          domainScore: 0,
          domainDimension: "unknown",
          overall: 0,
          binaryPass: false,
          reasoning: `Judge error: ${judgeErr instanceof Error ? judgeErr.message : String(judgeErr)}`,
        };
      }

      return {
        query: evalQuery.query,
        response: result.text,
        steps,
        totalInputTokens,
        totalOutputTokens,
        totalTokens,
        totalLatencyMs,
        toolCallsMade,
        cost,
        quality,
      };
    } catch (err) {
      lastError = err;
      // Retry on 429 rate-limit errors
      if (isRateLimitError(err) && attempt < maxRetries) {
        continue;
      }
      break;
    }
  }

  // All retries exhausted or non-retryable error
  return {
    query: evalQuery.query,
    response: "",
    steps: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    toolCallsMade: [],
    cost: 0,
    quality: {
      correctness: 0,
      relevance: 0,
      domainScore: 0,
      domainDimension: "unknown",
      overall: 0,
      binaryPass: false,
      reasoning: `Agent error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    },
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

/** Check if an error is a 429 rate-limit response. */
function isRateLimitError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e.status === 429 || e.statusCode === 429) return true;
    if (typeof e.message === "string" && e.message.includes("429")) return true;
  }
  return false;
}

/** Compute the median of a numeric array. */
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Aggregate multiple runs of the same query by taking the median of each metric.
 * Uses the response from the median-cost run for the text fields.
 */
function aggregateRunsByMedian(
  runs: QueryResult[],
  query: string,
): QueryResult {
  const successful = runs.filter((r) => !r.error);
  if (successful.length === 0) {
    // All runs failed — return the first error
    return runs[0];
  }

  const medianTokens = medianOf(successful.map((r) => r.totalTokens));
  const medianInput = medianOf(successful.map((r) => r.totalInputTokens));
  const medianOutput = medianOf(successful.map((r) => r.totalOutputTokens));
  const medianLatency = medianOf(successful.map((r) => r.totalLatencyMs));
  const medianCost = medianOf(successful.map((r) => r.cost));
  const medianQuality = medianOf(successful.map((r) => r.quality.overall));

  // Pick the run closest to median cost for text fields
  const representative = successful.reduce((best, r) =>
    Math.abs(r.cost - medianCost) < Math.abs(best.cost - medianCost) ? r : best,
  );

  return {
    query,
    response: representative.response,
    steps: representative.steps,
    totalInputTokens: medianInput,
    totalOutputTokens: medianOutput,
    totalTokens: medianTokens,
    totalLatencyMs: medianLatency,
    toolCallsMade: representative.toolCallsMade,
    cost: medianCost,
    quality: {
      ...representative.quality,
      overall: medianQuality,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an array of async tasks with a concurrency limit.
 * All tasks run to completion — errors in one do not abort others.
 */
async function runWithConcurrency(
  tasks: (() => Promise<void>)[],
  limit: number,
): Promise<void> {
  if (limit >= tasks.length) {
    // No limiting needed — run all in parallel, but use allSettled
    // so one failure doesn't abort siblings (matches worker-pool behavior)
    const results = await Promise.allSettled(tasks.map((fn) => fn()));
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((f) => f.reason),
        `${failures.length} query tasks failed`,
      );
    }
    return;
  }

  let nextIdx = 0;
  const errors: unknown[] = [];

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      try {
        await tasks[idx]();
      } catch (err) {
        errors.push(err);
      }
    }
  }

  // Spawn `limit` workers that pull from the shared task queue
  await Promise.all(Array.from({ length: limit }, () => worker()));

  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} query tasks failed`);
  }
}
