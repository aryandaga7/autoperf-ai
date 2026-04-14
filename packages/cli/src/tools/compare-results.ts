import {
  computeEffectSize,
  computeMADConfidence,
  mannWhitneyU,
  cliffsDelta,
  checkRegressions,
  wilcoxonSignedRank,
  bootstrapCI,
} from "../stats/statistics.js";
import {
  STATISTICAL_THRESHOLDS,
  QUALITY_GUARD_RAILS,
} from "../stats/config.js";
import type {
  EffectSize,
  MADConfidence,
  MannWhitneyResult,
  CliffsDeltaResult,
  RegressionFlag,
  WilcoxonResult,
  BootstrapCIResult,
} from "../stats/types.js";

/** Shape of the before/after input — just the fields we need from EvalRunResult. */
export interface CompareInput {
  aggregate: {
    totalTokens: number;
    avgLatencyMs: number;
    totalCost: number;
    avgQuality: number;
  };
  rawSamples: {
    tokens: number[];
    latency: number[];
    cost: number[];
    quality: number[];
  };
}

/** Per-metric analysis returned by compareResults. */
export interface MetricAnalysis {
  before: number;
  after: number;
  effectSize: EffectSize;
  /** Primary test for paired data (same queries before/after) */
  wilcoxon: WilcoxonResult;
  /** Bootstrap CI for the mean paired difference */
  bootstrapCI: BootstrapCIResult;
  /** Fallback for unpaired data — retained for cross-agent comparisons */
  mannWhitney: MannWhitneyResult;
  cliffsDelta: CliffsDeltaResult;
  madConfidence: MADConfidence;
  /** Based on Wilcoxon p-value (primary) */
  statisticallySignificant: boolean;
  meaningfulEffect: boolean;
}

/** Per-query quality analysis for detecting individual regressions. */
export interface PerQueryAnalysis {
  queryIndex: number;
  qualityBefore: number;
  qualityAfter: number;
  qualityDelta: number;
  flagged: boolean;
  reason?: string;
}

/** Summary of per-query quality regressions. */
export interface RegressionSummary {
  flaggedCount: number;
  totalQueries: number;
  worstRegression?: { queryIndex: number; delta: number };
  /** Percentage of queries with quality below QUALITY_FLOOR (0–100). */
  percentBelowFloor: { before: number; after: number };
}

/** Reason for a hard reject — structured for CC to parse and log. */
export interface HardRejectReason {
  type: "absolute_floor" | "baseline_regression";
  queryIndex: number;
  score: number;
  threshold: number;
  baselineScore?: number;
  detail: string;
}

/** Full comparison result — raw analysis, no verdict. */
export interface CompareResultsOutput {
  metrics: Record<string, MetricAnalysis>;
  regressions: RegressionFlag[];
  summary: string;
  /** Per-query quality analysis. Present when before/after quality samples are paired. */
  perQueryAnalysis?: PerQueryAnalysis[];
  /** Aggregated per-query regression summary. Present when perQueryAnalysis is computed. */
  regressionSummary?: RegressionSummary;
  /** Hard reject signal. Present only when quality gates are violated. */
  hardReject?: {
    reject: true;
    reasons: HardRejectReason[];
  };
}

/**
 * Mapping from metric names used in stats config → fields in CompareInput.
 * Keys are the metric names used by computeEffectSize/checkRegressions.
 * Values describe how to extract before/after scalars + raw sample arrays.
 */
const METRIC_MAP: Array<{
  name: string;
  label: string;
  getAggregate: (input: CompareInput) => number;
  getSamples: (input: CompareInput) => number[];
}> = [
  {
    name: "totalTokens",
    label: "Total Tokens",
    getAggregate: (i) => i.aggregate.totalTokens,
    getSamples: (i) => i.rawSamples.tokens,
  },
  {
    name: "latencyMs",
    label: "Avg Latency",
    getAggregate: (i) => i.aggregate.avgLatencyMs,
    getSamples: (i) => i.rawSamples.latency,
  },
  {
    name: "costUsd",
    label: "Total Cost",
    getAggregate: (i) => i.aggregate.totalCost,
    getSamples: (i) => i.rawSamples.cost,
  },
  {
    name: "qualityScore",
    label: "Avg Quality",
    getAggregate: (i) => i.aggregate.avgQuality,
    getSamples: (i) => i.rawSamples.quality,
  },
];

/**
 * compareResults tool handler.
 *
 * Runs per-metric statistical analysis on before/after eval results.
 * Returns raw analysis with effect sizes, significance tests, and
 * regression flags. Does NOT issue an accept/reject verdict — CC decides.
 */
export function handleCompareResults(args: {
  before: CompareInput;
  after: CompareInput;
  originalBaselineQuality?: number[];
}): CompareResultsOutput {
  const { before, after } = args;
  const metrics: Record<string, MetricAnalysis> = {};
  const summaryParts: string[] = [];

  for (const m of METRIC_MAP) {
    const beforeVal = m.getAggregate(before);
    const afterVal = m.getAggregate(after);
    const beforeSamples = m.getSamples(before);
    const afterSamples = m.getSamples(after);

    const effectSize = computeEffectSize(m.name, beforeVal, afterVal);

    // Paired tests (primary) — requires equal-length sample arrays
    const isPaired =
      beforeSamples.length === afterSamples.length && beforeSamples.length > 0;

    const wsr = isPaired
      ? wilcoxonSignedRank(beforeSamples, afterSamples)
      : {
          wStatistic: 0,
          pValue: 1,
          effectiveN: 0,
          zeroDifferences: 0,
          method: "exact" as const,
        };

    const bci = isPaired
      ? bootstrapCI(beforeSamples, afterSamples)
      : {
          pointEstimate: 0,
          lowerBound: 0,
          upperBound: 0,
          confidenceLevel: 0.95,
          nBootstrap: 10000,
          method: "percentile" as const,
        };

    // Unpaired tests (fallback)
    const mw = mannWhitneyU(beforeSamples, afterSamples);
    const cd = cliffsDelta(beforeSamples, afterSamples);
    const mad = computeMADConfidence(afterSamples);

    // Significance: use Wilcoxon when paired, Mann-Whitney fallback
    const primaryPValue = isPaired ? wsr.pValue : mw.pValue;
    const statisticallySignificant =
      primaryPValue < STATISTICAL_THRESHOLDS.P_VALUE_SIGNIFICANCE;
    const meaningfulEffect =
      Math.abs(cd.delta) >= STATISTICAL_THRESHOLDS.CLIFFS_DELTA_MEDIUM;

    metrics[m.name] = {
      before: beforeVal,
      after: afterVal,
      effectSize,
      wilcoxon: wsr,
      bootstrapCI: bci,
      mannWhitney: mw,
      cliffsDelta: cd,
      madConfidence: mad,
      statisticallySignificant,
      meaningfulEffect,
    };

    // Build summary line
    const pctChange =
      effectSize.relative !== 0
        ? `${effectSize.relative > 0 ? "+" : ""}${(effectSize.relative * 100).toFixed(1)}%`
        : "no change";
    const testLabel = isPaired
      ? `Wilcoxon p=${wsr.pValue.toFixed(3)}`
      : `M-W p=${mw.pValue.toFixed(3)}`;
    summaryParts.push(
      `${m.label}: ${pctChange} (${effectSize.direction}, ${testLabel}, Cliff's δ=${cd.category})`,
    );
  }

  // Check regressions
  const beforeAgg: Record<string, number> = {};
  const afterAgg: Record<string, number> = {};
  for (const m of METRIC_MAP) {
    beforeAgg[m.name] = m.getAggregate(before);
    afterAgg[m.name] = m.getAggregate(after);
  }
  const regressions = checkRegressions(
    METRIC_MAP.map((m) => m.name),
    beforeAgg,
    afterAgg,
  );

  const regressionNote =
    regressions.length > 0
      ? ` ⚠ Regressions: ${regressions.map((r) => r.metric).join(", ")}.`
      : "";

  // Per-query quality analysis (only when samples are paired)
  const beforeQuality = before.rawSamples.quality;
  const afterQuality = after.rawSamples.quality;
  const qualityPaired =
    beforeQuality.length === afterQuality.length && beforeQuality.length > 0;

  let perQueryAnalysis: PerQueryAnalysis[] | undefined;
  let regressionSummary: RegressionSummary | undefined;
  const hardRejectReasons: HardRejectReason[] = [];

  // Hard gate checks require original baseline quality with matching length
  const {
    PER_QUERY_DROP_THRESHOLD,
    QUALITY_FLOOR,
    HARD_QUALITY_FLOOR,
    HARD_REGRESSION_THRESHOLD,
  } = QUALITY_GUARD_RAILS;
  const baselineQuality = args.originalBaselineQuality;
  const baselinePaired =
    baselineQuality &&
    afterQuality.length === baselineQuality.length &&
    baselineQuality.length > 0;

  if (qualityPaired) {
    const n = beforeQuality.length;

    perQueryAnalysis = [];
    let worstDelta = 0;
    let worstIndex = -1;
    let belowFloorBefore = 0;
    let belowFloorAfter = 0;

    for (let i = 0; i < n; i++) {
      const qBefore = beforeQuality[i];
      const qAfter = afterQuality[i];
      const delta = qAfter - qBefore; // negative = regression

      if (qBefore < QUALITY_FLOOR) belowFloorBefore++;
      if (qAfter < QUALITY_FLOOR) belowFloorAfter++;

      const flagged = delta < -PER_QUERY_DROP_THRESHOLD;
      const entry: PerQueryAnalysis = {
        queryIndex: i,
        qualityBefore: qBefore,
        qualityAfter: qAfter,
        qualityDelta: delta,
        flagged,
      };

      if (flagged) {
        entry.reason = `quality dropped ${Math.abs(delta).toFixed(1)} points (${qBefore.toFixed(1)} → ${qAfter.toFixed(1)})`;
      }

      perQueryAnalysis.push(entry);

      if (delta < worstDelta) {
        worstDelta = delta;
        worstIndex = i;
      }

      // Hard gate: absolute floor check (requires original baseline)
      if (baselinePaired && qAfter < HARD_QUALITY_FLOOR) {
        const baselineQ = baselineQuality[i];
        const isKnownFloor = baselineQ < HARD_QUALITY_FLOOR;
        if (!isKnownFloor) {
          hardRejectReasons.push({
            type: "absolute_floor",
            queryIndex: i,
            score: qAfter,
            threshold: HARD_QUALITY_FLOOR,
            baselineScore: baselineQ,
            detail:
              `Q${i + 1} scored ${qAfter.toFixed(1)}/5 — below hard floor of ${HARD_QUALITY_FLOOR}` +
              ` (baseline was ${baselineQ.toFixed(1)})`,
          });
        }
      }

      // Hard gate: baseline regression check
      if (baselinePaired) {
        const baselineQ = baselineQuality[i];
        const baselineDelta = qAfter - baselineQ;
        if (baselineDelta < -HARD_REGRESSION_THRESHOLD) {
          hardRejectReasons.push({
            type: "baseline_regression",
            queryIndex: i,
            score: qAfter,
            threshold: HARD_REGRESSION_THRESHOLD,
            baselineScore: baselineQ,
            detail:
              `Q${i + 1} dropped ${Math.abs(baselineDelta).toFixed(1)} points from baseline ` +
              `(${baselineQ.toFixed(1)} → ${qAfter.toFixed(1)}), exceeds ${HARD_REGRESSION_THRESHOLD}-point threshold`,
          });
        }
      }
    }

    const flaggedCount = perQueryAnalysis.filter((q) => q.flagged).length;

    regressionSummary = {
      flaggedCount,
      totalQueries: n,
      ...(worstIndex >= 0
        ? { worstRegression: { queryIndex: worstIndex, delta: worstDelta } }
        : {}),
      percentBelowFloor: {
        before: (belowFloorBefore / n) * 100,
        after: (belowFloorAfter / n) * 100,
      },
    };
  }

  // Build hard reject prefix for summary
  let hardRejectNote = "";
  if (hardRejectReasons.length > 0) {
    const details = hardRejectReasons.map((r) => r.detail).join("; ");
    hardRejectNote = ` HARD REJECT: ${details}.`;
  }

  // Build per-query note for summary
  let perQueryNote = "";
  if (regressionSummary && regressionSummary.flaggedCount > 0) {
    const { flaggedCount, totalQueries, worstRegression } = regressionSummary;
    perQueryNote = ` ⚠ Per-query: ${flaggedCount}/${totalQueries} queries regressed`;
    if (worstRegression) {
      perQueryNote += ` (worst: Q${worstRegression.queryIndex + 1} Δ${worstRegression.delta.toFixed(1)})`;
    }
    perQueryNote += ".";
  }
  if (
    regressionSummary &&
    regressionSummary.percentBelowFloor.after >
      regressionSummary.percentBelowFloor.before
  ) {
    perQueryNote += ` ⚠ Quality floor: ${regressionSummary.percentBelowFloor.before.toFixed(0)}% → ${regressionSummary.percentBelowFloor.after.toFixed(0)}% below ${QUALITY_GUARD_RAILS.QUALITY_FLOOR}.`;
  }

  const summary =
    (hardRejectNote ? hardRejectNote + " " : "") +
    summaryParts.join(" | ") +
    regressionNote +
    perQueryNote;

  console.error(`[autoperf] compareResults: ${summary}`);

  return {
    metrics,
    regressions,
    summary,
    ...(perQueryAnalysis ? { perQueryAnalysis } : {}),
    ...(regressionSummary ? { regressionSummary } : {}),
    ...(hardRejectReasons.length > 0
      ? { hardReject: { reject: true as const, reasons: hardRejectReasons } }
      : {}),
  };
}
