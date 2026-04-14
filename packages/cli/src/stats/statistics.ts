import type {
  MADConfidence,
  EffectSize,
  MannWhitneyResult,
  CliffsDeltaResult,
  RegressionFlag,
  WilcoxonResult,
  BootstrapCIResult,
} from "./types.js";
import {
  LOWER_IS_BETTER,
  ABSOLUTE_NOISE_FLOORS,
  REGRESSION_THRESHOLDS,
} from "./config.js";

/**
 * Compute the median of a numeric array.
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute MAD-based confidence score for a set of metric values.
 *
 * MAD = median(|Xi - median(X)|)
 * confidence = max(0, 1 - (MAD / median))
 *
 * High confidence (>0.80) means the measurements are stable.
 * Low confidence (<0.70) means too much noise — rerun.
 */
export function computeMADConfidence(values: number[]): MADConfidence {
  if (values.length === 0) {
    return { median: 0, mad: 0, coefficientOfDispersion: 0, confidence: 0 };
  }

  const med = median(values);
  const absoluteDeviations = values.map((v) => Math.abs(v - med));
  const mad = median(absoluteDeviations);

  // Avoid division by zero for metrics that can be 0
  const coefficientOfDispersion = med === 0 ? 0 : mad / med;
  const confidence = Math.max(0, 1 - coefficientOfDispersion);

  return { median: med, mad, coefficientOfDispersion, confidence };
}

/**
 * Standard normal CDF approximation (Abramowitz & Stegun 7.1.26).
 * Accurate to ~7.5e-8.
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x >= 0 ? 1 : -1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const erf =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1 + sign * erf);
}

/**
 * Assign ranks to values, handling ties by averaging.
 * Returns ranks in the same order as the input array (1-based).
 */
function assignRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ value: v, index: i }));
  indexed.sort((a, b) => a.value - b.value);

  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length && indexed[j].value === indexed[i].value) {
      j++;
    }
    // Average rank for tied values (ranks are 1-based)
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      ranks[indexed[k].index] = avgRank;
    }
    i = j;
  }

  return ranks;
}

/**
 * Mann-Whitney U test: non-parametric comparison of two distributions.
 *
 * Tests whether the two groups come from the same distribution.
 * Uses normal approximation for the p-value (without tie correction —
 * conservative for small samples with ties).
 *
 * @param before - Sample values from the before-measurement runs
 * @param after - Sample values from the after-measurement runs
 * @returns U statistic and two-tailed p-value
 */
export function mannWhitneyU(
  before: number[],
  after: number[],
): MannWhitneyResult {
  const n1 = before.length;
  const n2 = after.length;

  if (n1 === 0 || n2 === 0) {
    return { uStatistic: 0, pValue: 1 };
  }

  // Combine both samples and rank all values
  const combined = [...before, ...after];
  const ranks = assignRanks(combined);

  // Sum ranks for group 1 (before)
  let R1 = 0;
  for (let i = 0; i < n1; i++) {
    R1 += ranks[i];
  }

  const U1 = n1 * n2 + (n1 * (n1 + 1)) / 2 - R1;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);

  // Normal approximation for p-value
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);

  if (sigma === 0) {
    return { uStatistic: U, pValue: 1 };
  }

  const z = (U - mu) / sigma;
  // U <= mu always, so z <= 0. Two-tailed p-value:
  const pValue = 2 * normalCDF(z);

  return { uStatistic: U, pValue };
}

/**
 * Cliff's Delta: non-parametric effect size for two groups.
 *
 * Measures the probability that a randomly chosen value from one
 * group is larger than a randomly chosen value from the other.
 * Range: [-1, 1]. Positive = before tends to be larger.
 *
 * Categories (Cliff, 1993):
 *   |d| < 0.147 → negligible
 *   |d| < 0.33  → small
 *   |d| < 0.474 → medium
 *   |d| >= 0.474 → large
 */
export function cliffsDelta(
  before: number[],
  after: number[],
): CliffsDeltaResult {
  const n1 = before.length;
  const n2 = after.length;

  if (n1 === 0 || n2 === 0) {
    return { delta: 0, category: "negligible" };
  }

  let countGreater = 0;
  let countLess = 0;

  for (const b of before) {
    for (const a of after) {
      if (b > a) countGreater++;
      else if (b < a) countLess++;
    }
  }

  const delta = (countGreater - countLess) / (n1 * n2);
  const absDelta = Math.abs(delta);

  let category: CliffsDeltaResult["category"];
  if (absDelta < 0.147) category = "negligible";
  else if (absDelta < 0.33) category = "small";
  else if (absDelta < 0.474) category = "medium";
  else category = "large";

  return { delta, category };
}

/**
 * Compute the effect size for a single metric between before and after.
 *
 * Exported for use by the compareResults MCP tool, which computes
 * per-metric effect sizes and returns them to CC for judgment.
 */
export function computeEffectSize(
  metricName: string,
  before: number,
  after: number,
): EffectSize {
  const absolute = after - before;
  const noiseFloor = ABSOLUTE_NOISE_FLOORS[metricName] ?? 0;

  // Below noise floor → treat as unchanged (fixes zero-baseline problem)
  if (Math.abs(absolute) < noiseFloor) {
    return { absolute, relative: 0, direction: "unchanged" };
  }

  // Zero baseline → scale by noise floor instead of dividing by zero
  const relative = before === 0 ? absolute / noiseFloor : absolute / before;

  const lowerIsBetter = LOWER_IS_BETTER[metricName] ?? true;

  let direction: EffectSize["direction"];
  if (Math.abs(relative) < 0.01) {
    direction = "unchanged";
  } else if (lowerIsBetter) {
    direction = absolute < 0 ? "improved" : "regressed";
  } else {
    direction = absolute > 0 ? "improved" : "regressed";
  }

  return { absolute, relative, direction };
}

/**
 * Check if any single metric regressed beyond its regression threshold.
 *
 * A regression is flagged when the metric worsened AND the change exceeds
 * BOTH the absolute and relative thresholds. This dual gate prevents:
 * - False positives at small absolute values (high relative, low absolute)
 * - False positives at large absolute values (high absolute, low relative)
 *
 * Returns an array of flagged regressions with their magnitudes.
 * An empty array means no regressions were detected.
 *
 * @param metricNames - Which metrics to check (e.g., ["totalTokens", "latencyMs", "costUsd", "qualityScore"])
 * @param before - Before values keyed by metric name
 * @param after - After values keyed by metric name
 */
export function checkRegressions(
  metricNames: string[],
  before: Record<string, number>,
  after: Record<string, number>,
): RegressionFlag[] {
  const regressions: RegressionFlag[] = [];

  for (const name of metricNames) {
    const threshold = REGRESSION_THRESHOLDS[name];
    if (!threshold) continue;

    const beforeVal = before[name];
    const afterVal = after[name];
    if (beforeVal === undefined || afterVal === undefined) continue;

    const lowerIsBetter = LOWER_IS_BETTER[name] ?? true;

    // Check if metric regressed (value moved in the bad direction)
    const regressed = lowerIsBetter
      ? afterVal > beforeVal
      : afterVal < beforeVal;
    if (!regressed) continue;

    const absoluteChange = Math.abs(afterVal - beforeVal);
    const relativeChange =
      beforeVal === 0
        ? absoluteChange > 0
          ? Infinity
          : 0
        : absoluteChange / Math.abs(beforeVal);

    // Both gates must be exceeded to flag a regression
    if (
      absoluteChange >= threshold.absolute &&
      relativeChange >= threshold.relative
    ) {
      regressions.push({ metric: name, absoluteChange, relativeChange });
    }
  }

  return regressions;
}

// ─── Wilcoxon Signed-Rank Test (Paired) ──────────────────────────────

/**
 * Wilcoxon signed-rank test for paired samples.
 *
 * Tests whether the median of paired differences is zero.
 * Uses exact permutation for n ≤ 20, normal approximation
 * with continuity + tie correction for n > 20.
 *
 * Zero differences are excluded per standard practice.
 *
 * @param before - Before-measurement values (one per query)
 * @param after - After-measurement values (same queries, same order)
 * @returns W statistic and two-tailed p-value
 */
export function wilcoxonSignedRank(
  before: number[],
  after: number[],
): WilcoxonResult {
  if (before.length !== after.length) {
    throw new Error(
      `Wilcoxon requires equal-length arrays: got ${before.length} vs ${after.length}`,
    );
  }

  // Compute paired differences, exclude zeros
  const diffs: { absDiff: number; sign: number }[] = [];
  let zeroDifferences = 0;

  for (let i = 0; i < before.length; i++) {
    const d = after[i] - before[i];
    if (d === 0) {
      zeroDifferences++;
    } else {
      diffs.push({ absDiff: Math.abs(d), sign: d > 0 ? 1 : -1 });
    }
  }

  const n = diffs.length;

  if (n === 0) {
    return {
      wStatistic: 0,
      pValue: 1,
      effectiveN: 0,
      zeroDifferences,
      method: "exact",
    };
  }

  // Rank the absolute differences (ties handled by averaging)
  const absValues = diffs.map((d) => d.absDiff);
  const ranks = assignRanks(absValues);

  // W+ = sum of ranks for positive differences
  let wPlus = 0;
  let wMinus = 0;
  for (let i = 0; i < n; i++) {
    if (diffs[i].sign > 0) {
      wPlus += ranks[i];
    } else {
      wMinus += ranks[i];
    }
  }

  const wStatistic = Math.min(wPlus, wMinus);

  // Compute p-value
  let pValue: number;
  let method: WilcoxonResult["method"];

  if (n <= 20) {
    pValue = wilcoxonExactP(wPlus, n, ranks);
    method = "exact";
  } else {
    pValue = wilcoxonNormalApproxP(wPlus, n, ranks);
    method = "normal-approximation";
  }

  return { wStatistic, pValue, effectiveN: n, zeroDifferences, method };
}

/**
 * Exact two-tailed p-value for the Wilcoxon signed-rank test.
 * Enumerates all 2^n possible sign assignments.
 */
function wilcoxonExactP(
  observedWPlus: number,
  n: number,
  ranks: number[],
): number {
  const totalPerms = 1 << n; // 2^n
  let countAsExtreme = 0;
  const maxW = ranks.reduce((a, b) => a + b, 0); // sum of all ranks

  for (let mask = 0; mask < totalPerms; mask++) {
    let wp = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        wp += ranks[i];
      }
    }
    // Two-tailed: count if W+ is as far from center as observed
    // Center of W+ under H0 = maxW / 2
    if (
      Math.abs(wp - maxW / 2) >= Math.abs(observedWPlus - maxW / 2) - 1e-10
    ) {
      countAsExtreme++;
    }
  }

  return Math.min(countAsExtreme / totalPerms, 1);
}

/**
 * Normal approximation p-value for Wilcoxon signed-rank.
 * Includes continuity correction and tie correction.
 */
function wilcoxonNormalApproxP(
  observedWPlus: number,
  n: number,
  ranks: number[],
): number {
  const mu = (n * (n + 1)) / 4;

  // Tie correction: compute groups of tied ranks
  let tieCorrection = 0;
  const rankCounts = new Map<number, number>();
  for (const r of ranks) {
    rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
  }
  for (const count of rankCounts.values()) {
    if (count > 1) {
      tieCorrection += count * count * count - count;
    }
  }

  const sigma = Math.sqrt(
    (n * (n + 1) * (2 * n + 1)) / 24 - tieCorrection / 48,
  );

  if (sigma === 0) return 1;

  // Continuity correction: subtract 0.5 from |W+ - mu|
  const z =
    (Math.abs(observedWPlus - mu) - 0.5) / sigma;

  // Two-tailed p-value
  return 2 * (1 - normalCDF(z));
}

// ─── BCa Bootstrap Confidence Intervals ──────────────────────────────

/**
 * Simple seeded PRNG (mulberry32) for reproducible bootstrap resampling.
 * Returns values in [0, 1).
 */
function createPRNG(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap confidence interval for the mean of paired differences.
 *
 * Uses BCa (bias-corrected and accelerated) when n ≥ 8,
 * falls back to basic percentile when n < 8 (jackknife acceleration
 * is too noisy at very small n).
 *
 * @param before - Before values (one per query)
 * @param after - After values (same queries, same order)
 * @param options - alpha (default 0.05), nBootstrap (default 10000), seed (default 42)
 */
export function bootstrapCI(
  before: number[],
  after: number[],
  options?: { alpha?: number; nBootstrap?: number; seed?: number },
): BootstrapCIResult {
  if (before.length !== after.length) {
    throw new Error(
      `bootstrapCI requires equal-length arrays: got ${before.length} vs ${after.length}`,
    );
  }

  const alpha = options?.alpha ?? 0.05;
  const nBootstrap = options?.nBootstrap ?? 10000;
  const seed = options?.seed ?? 42;
  const n = before.length;

  if (n === 0) {
    return {
      pointEstimate: 0,
      lowerBound: 0,
      upperBound: 0,
      confidenceLevel: 1 - alpha,
      nBootstrap,
      method: "percentile",
    };
  }

  // Paired differences
  const diffs = before.map((b, i) => after[i] - b);
  const pointEstimate = diffs.reduce((a, b) => a + b, 0) / n;

  if (n === 1) {
    // Can't bootstrap with n=1
    return {
      pointEstimate,
      lowerBound: pointEstimate,
      upperBound: pointEstimate,
      confidenceLevel: 1 - alpha,
      nBootstrap,
      method: "percentile",
    };
  }

  const rng = createPRNG(seed);

  // Generate bootstrap distribution of means
  const bootMeans: number[] = new Array(nBootstrap);
  for (let b = 0; b < nBootstrap; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += diffs[Math.floor(rng() * n)];
    }
    bootMeans[b] = sum / n;
  }
  bootMeans.sort((a, b) => a - b);

  const useBCa = n >= 8;

  if (!useBCa) {
    // Basic percentile bootstrap
    const loIdx = Math.max(0, Math.floor((alpha / 2) * nBootstrap) - 1);
    const hiIdx = Math.min(
      nBootstrap - 1,
      Math.ceil((1 - alpha / 2) * nBootstrap) - 1,
    );
    return {
      pointEstimate,
      lowerBound: bootMeans[loIdx],
      upperBound: bootMeans[hiIdx],
      confidenceLevel: 1 - alpha,
      nBootstrap,
      method: "percentile",
    };
  }

  // BCa: bias correction factor z0
  const countBelow = bootMeans.filter((m) => m < pointEstimate).length;
  const z0 = inverseNormalCDF(countBelow / nBootstrap);

  // BCa: acceleration factor from jackknife
  const jackMeans: number[] = new Array(n);
  const totalSum = diffs.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    jackMeans[i] = (totalSum - diffs[i]) / (n - 1);
  }
  const jackMean = jackMeans.reduce((a, b) => a + b, 0) / n;
  const jackDiffs = jackMeans.map((jm) => jackMean - jm);
  const sumCubed = jackDiffs.reduce((a, d) => a + d * d * d, 0);
  const sumSquared = jackDiffs.reduce((a, d) => a + d * d, 0);
  const aHat =
    sumSquared === 0 ? 0 : sumCubed / (6 * Math.pow(sumSquared, 1.5));

  // Adjusted percentiles
  const zAlphaLo = inverseNormalCDF(alpha / 2);
  const zAlphaHi = inverseNormalCDF(1 - alpha / 2);

  const adjLo = normalCDF(
    z0 + (z0 + zAlphaLo) / (1 - aHat * (z0 + zAlphaLo)),
  );
  const adjHi = normalCDF(
    z0 + (z0 + zAlphaHi) / (1 - aHat * (z0 + zAlphaHi)),
  );

  const loIdx = Math.max(0, Math.floor(adjLo * nBootstrap) - 1);
  const hiIdx = Math.min(
    nBootstrap - 1,
    Math.ceil(adjHi * nBootstrap) - 1,
  );

  return {
    pointEstimate,
    lowerBound: bootMeans[loIdx],
    upperBound: bootMeans[hiIdx],
    confidenceLevel: 1 - alpha,
    nBootstrap,
    method: "bca",
  };
}

/**
 * Inverse normal CDF (probit function) via rational approximation.
 * Abramowitz & Stegun 26.2.23. Accurate to ~4.5e-4.
 */
function inverseNormalCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  // Rational approximation for 0 < p < 0.5
  const pAdj = p < 0.5 ? p : 1 - p;
  const t = Math.sqrt(-2 * Math.log(pAdj));
  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;
  const d3 = 0.001308;

  let z = t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t);

  if (p < 0.5) z = -z;
  return z;
}
