/**
 * MAD confidence analysis for a set of values.
 */
export interface MADConfidence {
  median: number;
  mad: number;
  /** MAD / median ratio */
  coefficientOfDispersion: number;
  /** max(0, 1 - (MAD / median)) */
  confidence: number;
}

/**
 * Per-metric effect size from a before/after comparison.
 */
export interface EffectSize {
  /** Absolute difference (after - before) */
  absolute: number;
  /** Relative change as fraction (e.g., -0.26 = 26% reduction) */
  relative: number;
  /** Whether the metric improved, regressed, or was unchanged */
  direction: "improved" | "regressed" | "unchanged";
}

/** Result from Mann-Whitney U test. */
export interface MannWhitneyResult {
  /** The U statistic (minimum of U1, U2) */
  uStatistic: number;
  /** Two-tailed p-value from normal approximation */
  pValue: number;
}

/** Result from Cliff's Delta effect size calculation. */
export interface CliffsDeltaResult {
  /** Delta value in [-1, 1] — positive means group 1 tends to be larger */
  delta: number;
  /** Effect size category based on |delta| */
  category: "negligible" | "small" | "medium" | "large";
}

/** Result from Wilcoxon signed-rank test (paired). */
export interface WilcoxonResult {
  /** The W statistic (sum of positive ranks, or min of W+/W-) */
  wStatistic: number;
  /** Two-tailed p-value (exact for n ≤ 20, normal approx for n > 20) */
  pValue: number;
  /** n after excluding zero differences */
  effectiveN: number;
  /** Count of pairs with zero difference (excluded from test) */
  zeroDifferences: number;
  /** Whether exact or approximate p-value was used */
  method: "exact" | "normal-approximation";
}

/** Result from BCa (or percentile) bootstrap confidence interval. */
export interface BootstrapCIResult {
  /** Mean of the paired differences */
  pointEstimate: number;
  /** Lower bound of the CI */
  lowerBound: number;
  /** Upper bound of the CI */
  upperBound: number;
  /** e.g., 0.95 for 95% CI */
  confidenceLevel: number;
  /** Number of bootstrap resamples used */
  nBootstrap: number;
  /** Whether BCa or basic percentile was used */
  method: "bca" | "percentile";
}

/** Combined statistical test results for before/after sample comparison. */
export interface StatisticalTest {
  mannWhitney: MannWhitneyResult;
  cliffsDelta: CliffsDeltaResult;
}

/**
 * Per-query metrics collected from an AI agent eval run.
 * These are the raw values that get aggregated and compared.
 */
export interface AgentMetrics {
  /** Total tokens (input + output) for this query */
  totalTokens: number;
  /** Wall-clock latency in ms for this query */
  latencyMs: number;
  /** Computed cost in USD for this query */
  costUsd: number;
  /** LLM-as-judge quality score (1-5) for this query */
  qualityScore: number;
}

/**
 * Regression detected on a single metric.
 */
export interface RegressionFlag {
  metric: string;
  absoluteChange: number;
  relativeChange: number;
}
