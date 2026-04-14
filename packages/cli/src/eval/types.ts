// Eval query definition (loaded from per-agent query JSON files)
export interface EvalQuery {
  query: string;
  expectedBehavior: string;
  shouldCallTool?: boolean; // coarse boolean — fallback when expectedTools not specified
  expectedTools?: string[]; // exact tool names expected (e.g. ["getWeather", "getWeather"])
}

// Per-step metrics captured by the TelemetryIntegration
export interface StepMetrics {
  stepNumber: number;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  finishReason: string;
  toolCalls: string[]; // tool names called in this step
  stepLatencyMs: number;
}

// Quality score from LLM-as-judge + deterministic signals
export interface QualityScore {
  correctness: number; // 1-5
  relevance: number; // 1-5
  domainScore: number; // 1-5 (dimension varies by agent type)
  domainDimension: string; // name of the third dimension (e.g. "thoroughness", "actionability")
  overall: number; // composite: LLM judge average, adjusted by tool call penalty
  reasoning: string; // chain-of-thought analysis before scoring
  binaryPass: boolean; // quality gate: pass/fail for regression detection
  gateReason?: string; // explanation if gate failed
  toolCallCorrect?: boolean; // undefined if no tool expectation, true/false if checked
}

// Judge configuration — controls rubric type, thresholds, and custom criteria
export type RubricType = "research-report" | "code-review" | "generic";

export interface JudgeConfig {
  rubricType: RubricType;
  passingThreshold?: number; // overall score minimum for binary gate (default: 3.0)
  dimensionMinimum?: number; // per-dimension floor for binary gate (default: 2.0)
  customCriteria?: string; // additional criteria text injected into judge prompt
  judgeModel?: string; // model ID override (e.g. "gpt-5.4-mini"). Default: claude-sonnet-4-6
}

// Complete result for a single query
export interface QueryResult {
  query: string;
  response: string;
  steps: StepMetrics[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  toolCallsMade: string[];
  cost: number; // USD, computed from pricing table
  quality: QualityScore;
  error?: string;
}

/** Options for multi-run eval and rate-limit protection. */
export interface EvalRunOptions {
  /** Number of times to run each query (1 = Tier 1, 3 = Tier 2, 5 = Tier 3). Default: 1 */
  runsPerQuery?: number;
  /** Delay in ms between runs of the same query (for multi-run eval). Default: 0 */
  delayBetweenQueriesMs?: number;
  /** Max retries on 429 rate-limit errors. Default: 3 */
  maxRetries?: number;
  /** Number of queries to run in parallel. Default: 1 (sequential). Recommended: 3-5. */
  concurrency?: number;
}

// Aggregate result for a full eval run (all queries)
export interface EvalRunResult {
  agentPath: string;
  timestamp: string;
  queries: QueryResult[];
  aggregate: {
    totalTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgTokensPerQuery: number;
    avgLatencyMs: number;
    totalCost: number;
    avgCost: number;
    avgQuality: number;
  };
  // Raw per-query sample arrays for statistical comparison
  // When runsPerQuery > 1, these are median-aggregated per query
  rawSamples: {
    tokens: number[];
    latency: number[];
    cost: number[];
    quality: number[];
  };
  /** Per-query per-run raw data. Only present when runsPerQuery > 1. queries[i][j] = run j of query i */
  rawRunData?: QueryResult[][];
  /** How many runs per query were performed */
  runsPerQuery?: number;
}
