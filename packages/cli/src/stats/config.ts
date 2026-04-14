/**
 * Statistical configuration for AI agent metric comparison.
 *
 * These thresholds are calibrated for AI SDK agent metrics:
 * tokens, latency, cost, and quality scores.
 */

/**
 * For each metric, whether lower is better.
 * Quality is the only metric where higher is better.
 */
export const LOWER_IS_BETTER: Record<string, boolean> = {
  totalTokens: true,
  latencyMs: true,
  costUsd: true,
  qualityScore: false,
};

/**
 * Absolute noise floors per metric.
 *
 * Changes smaller than these thresholds are treated as measurement noise
 * (direction = "unchanged", relative = 0). Prevents the zero-baseline
 * problem and filters out LLM non-determinism artifacts.
 *
 * Rationale:
 * - totalTokens: 50 — LLM output varies by ~20-50 tokens between identical calls
 * - latencyMs: 200 — network jitter + API variance
 * - costUsd: 0.001 — sub-penny changes are noise
 * - qualityScore: 0.3 — LLM-as-judge scoring has ~0.2-0.3 variance on 1-5 scale
 */
export const ABSOLUTE_NOISE_FLOORS: Record<string, number> = {
  totalTokens: 50,
  latencyMs: 200,
  costUsd: 0.001,
  qualityScore: 0.3,
};

/**
 * Per-metric regression thresholds.
 *
 * A regression is flagged when the metric moved in the bad direction AND
 * the change exceeds BOTH the absolute and relative thresholds.
 * This dual gate prevents false positives at both small and large values.
 *
 * Rationale:
 * - totalTokens: 20% AND 100 tokens — small absolute changes at low token
 *   counts aren't meaningful; large relative changes at high counts are
 * - latencyMs: 25% AND 500ms — similar logic for latency
 * - costUsd: 25% AND $0.01 — cost regression should be material
 * - qualityScore: 10% AND 0.5 points — quality is precious; tight threshold
 *   but still allows for LLM-as-judge variance
 */
export const REGRESSION_THRESHOLDS: Record<
  string,
  { absolute: number; relative: number }
> = {
  totalTokens: { absolute: 100, relative: 0.2 },
  latencyMs: { absolute: 500, relative: 0.25 },
  costUsd: { absolute: 0.01, relative: 0.25 },
  qualityScore: { absolute: 0.5, relative: 0.1 },
};

/**
 * Statistical test thresholds for Mann-Whitney U + Cliff's Delta.
 *
 * Used by the compareResults MCP tool to annotate whether differences
 * are statistically supported. CC reads these annotations to inform
 * its accept/reject decision.
 */
export const STATISTICAL_THRESHOLDS = {
  /** p-value significance level for Mann-Whitney U (two-tailed) */
  P_VALUE_SIGNIFICANCE: 0.05,
  /** Minimum |Cliff's Delta| to consider the effect meaningful (medium) */
  CLIFFS_DELTA_MEDIUM: 0.33,
} as const;

/**
 * Per-query quality guard rail thresholds.
 *
 * Used by compareResults to flag individual query regressions that
 * aggregate statistics (Wilcoxon, Cliff's delta) would mask.
 *
 * Calibrated from Agent B optimization runs where per-query regressions
 * (e.g., Q4: 5.0→2.3, Q7: 3.0→1.0) were invisible in aggregate stats.
 */
export const QUALITY_GUARD_RAILS = {
  /**
   * Flag a per-query regression when quality drops by this many points.
   * On a 1–5 scale, a 1.0-point drop is a 20% loss — significant for any query.
   * Tighter than the 0.5-point aggregate regression threshold because
   * individual query drops are more actionable than averaged-out regressions.
   */
  PER_QUERY_DROP_THRESHOLD: 1.0,
  /**
   * Quality floor below which a query is considered "failing".
   * Used to track what percentage of queries fall below acceptable quality
   * before vs after an optimization.
   */
  QUALITY_FLOOR: 3.0,
  /**
   * Hard quality floor. If any query scores below this AND that query was
   * NOT already below this floor in the original baseline ("known floor
   * query"), the iteration is hard-rejected.
   *
   * 2.0/5 means the response is fundamentally broken — wrong, irrelevant,
   * or empty. Cost savings don't justify this. Aligned with the catastrophic
   * floor from SP-EVAL-1, now enforced in code rather than prompt-only.
   */
  HARD_QUALITY_FLOOR: 2.0,
  /**
   * Hard regression gate. If any query drops more than this many points
   * from its ORIGINAL BASELINE score, the iteration is hard-rejected.
   *
   * A >2.0-point drop on a 1-5 scale exceeds n=1 judge noise (~0.5-1.0
   * points) by 2-4x, making it almost certainly a real regression.
   * Catches gradual drift that current-best comparison misses.
   */
  HARD_REGRESSION_THRESHOLD: 2.0,
} as const;
