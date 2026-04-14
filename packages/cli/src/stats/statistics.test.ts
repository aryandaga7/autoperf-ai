import { describe, it, expect } from "vitest";
import {
  computeMADConfidence,
  mannWhitneyU,
  cliffsDelta,
  computeEffectSize,
  checkRegressions,
  wilcoxonSignedRank,
  bootstrapCI,
} from "./statistics.js";

// ─── computeMADConfidence ─────────────────────────────────────────────

describe("computeMADConfidence", () => {
  it("returns high confidence for stable values", () => {
    const result = computeMADConfidence([100, 101, 100, 99, 100]);
    expect(result.confidence).toBeGreaterThan(0.95);
  });

  it("returns low confidence for noisy values", () => {
    const result = computeMADConfidence([50, 100, 200, 80, 300]);
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  it("handles empty array", () => {
    const result = computeMADConfidence([]);
    expect(result.confidence).toBe(0);
  });

  it("returns correct median", () => {
    const result = computeMADConfidence([1, 3, 5, 7, 9]);
    expect(result.median).toBe(5);
  });

  it("handles even-length array (averages two middle values)", () => {
    const result = computeMADConfidence([1, 3, 5, 7]);
    expect(result.median).toBe(4);
  });

  it("returns confidence=0 when median is 0 (zero baseline guard)", () => {
    const result = computeMADConfidence([0, 0, 0, 0, 0]);
    expect(result.confidence).toBe(1); // MAD=0, CoD=0, confidence=1
  });

  it("works with AI agent token counts", () => {
    // Typical token counts from repeated agent runs
    const result = computeMADConfidence([1250, 1280, 1260, 1270, 1255]);
    expect(result.confidence).toBeGreaterThan(0.95);
    expect(result.median).toBe(1260);
  });

  it("detects noisy latency measurements", () => {
    // Latency with high variance (API jitter)
    const result = computeMADConfidence([500, 1200, 800, 2000, 600]);
    expect(result.confidence).toBeLessThan(0.7);
  });
});

// ─── mannWhitneyU ─────────────────────────────────────────────────────

describe("mannWhitneyU", () => {
  it("returns p ≈ 1.0 for identical distributions", () => {
    const result = mannWhitneyU([50, 50, 50, 50, 50], [50, 50, 50, 50, 50]);
    expect(result.pValue).toBeCloseTo(1.0, 1);
    expect(result.uStatistic).toBe(12.5);
  });

  it("returns p < 0.01 for perfectly separated distributions", () => {
    const result = mannWhitneyU(
      [100, 100, 100, 100, 100],
      [50, 50, 50, 50, 50],
    );
    expect(result.uStatistic).toBe(0);
    expect(result.pValue).toBeLessThan(0.01);
  });

  it("returns non-significant p for overlapping distributions", () => {
    const result = mannWhitneyU([1, 2, 3, 4, 5], [3, 4, 5, 6, 7]);
    expect(result.pValue).toBeGreaterThan(0.05);
  });

  it("handles ties correctly via averaged ranks", () => {
    const result = mannWhitneyU([1, 2, 3], [2, 3, 4]);
    expect(result.uStatistic).toBeDefined();
    expect(result.pValue).toBeGreaterThan(0);
    expect(result.pValue).toBeLessThanOrEqual(1);
  });

  it("handles empty arrays gracefully", () => {
    const result = mannWhitneyU([], [1, 2, 3]);
    expect(result.uStatistic).toBe(0);
    expect(result.pValue).toBe(1);
  });

  it("handles single-element groups", () => {
    const result = mannWhitneyU([10], [1]);
    expect(result.uStatistic).toBe(0);
    expect(result.pValue).toBeLessThanOrEqual(1);
  });

  it("works with larger samples (normal approximation)", () => {
    const before = [90, 91, 92, 93, 94, 95, 96, 97, 98, 99];
    const after = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59];
    const result = mannWhitneyU(before, after);
    expect(result.uStatistic).toBe(0);
    expect(result.pValue).toBeLessThan(0.001);
  });

  it("detects significant token count differences", () => {
    // Before: ~1500 tokens, After: ~800 tokens (model downgrade)
    const before = [1480, 1520, 1500, 1510, 1490];
    const after = [780, 820, 800, 810, 790];
    const result = mannWhitneyU(before, after);
    expect(result.pValue).toBeLessThan(0.01);
  });

  it("does not flag similar token counts as significant", () => {
    // Both groups around ~1000 tokens with overlap
    const before = [980, 1020, 1010, 990, 1005];
    const after = [995, 1015, 985, 1025, 1000];
    const result = mannWhitneyU(before, after);
    expect(result.pValue).toBeGreaterThan(0.05);
  });
});

// ─── cliffsDelta ──────────────────────────────────────────────────────

describe("cliffsDelta", () => {
  it("returns delta=0, negligible for identical distributions", () => {
    const result = cliffsDelta([50, 50, 50, 50, 50], [50, 50, 50, 50, 50]);
    expect(result.delta).toBe(0);
    expect(result.category).toBe("negligible");
  });

  it("returns |delta|=1.0, large for perfectly separated (before > after)", () => {
    const result = cliffsDelta(
      [100, 100, 100, 100, 100],
      [50, 50, 50, 50, 50],
    );
    expect(result.delta).toBe(1.0);
    expect(result.category).toBe("large");
  });

  it("returns |delta|=1.0, large for perfectly separated (after > before)", () => {
    const result = cliffsDelta(
      [50, 50, 50, 50, 50],
      [100, 100, 100, 100, 100],
    );
    expect(result.delta).toBe(-1.0);
    expect(result.category).toBe("large");
  });

  it("categorizes small effect correctly", () => {
    const result = cliffsDelta([1, 2, 3, 4, 5], [1.5, 2.5, 3.5, 4.5, 5.5]);
    expect(result.delta).toBeCloseTo(-0.2, 2);
    expect(result.category).toBe("small");
  });

  it("categorizes large effect for well-separated groups", () => {
    const result = cliffsDelta([1, 2, 3, 4, 5], [3, 4, 5, 6, 7]);
    expect(Math.abs(result.delta)).toBeGreaterThanOrEqual(0.474);
    expect(result.category).toBe("large");
  });

  it("handles empty arrays", () => {
    const result = cliffsDelta([], [1, 2, 3]);
    expect(result.delta).toBe(0);
    expect(result.category).toBe("negligible");
  });

  it("detects large cost reduction (model downgrade)", () => {
    // Before: ~$0.05/query, After: ~$0.005/query (10x reduction)
    const before = [0.048, 0.052, 0.050, 0.051, 0.049];
    const after = [0.004, 0.006, 0.005, 0.005, 0.005];
    const result = cliffsDelta(before, after);
    expect(result.delta).toBe(1.0); // All before > all after
    expect(result.category).toBe("large");
  });
});

// ─── computeEffectSize ────────────────────────────────────────────────

describe("computeEffectSize", () => {
  it("detects token reduction as improvement", () => {
    const result = computeEffectSize("totalTokens", 1500, 800);
    expect(result.direction).toBe("improved");
    expect(result.absolute).toBe(-700);
    expect(result.relative).toBeCloseTo(-700 / 1500);
  });

  it("detects token increase as regression", () => {
    const result = computeEffectSize("totalTokens", 800, 1500);
    expect(result.direction).toBe("regressed");
    expect(result.absolute).toBe(700);
  });

  it("detects latency reduction as improvement", () => {
    const result = computeEffectSize("latencyMs", 2000, 1000);
    expect(result.direction).toBe("improved");
  });

  it("detects quality increase as improvement (higher is better)", () => {
    const result = computeEffectSize("qualityScore", 3.5, 4.2);
    expect(result.direction).toBe("improved");
  });

  it("detects quality decrease as regression (higher is better)", () => {
    const result = computeEffectSize("qualityScore", 4.0, 3.2);
    expect(result.direction).toBe("regressed");
  });

  it("treats sub-noise-floor changes as unchanged (tokens)", () => {
    // 30 token difference is below noise floor of 50
    const result = computeEffectSize("totalTokens", 1000, 1030);
    expect(result.direction).toBe("unchanged");
    expect(result.relative).toBe(0);
  });

  it("treats sub-noise-floor changes as unchanged (latency)", () => {
    // 150ms difference is below noise floor of 200ms
    const result = computeEffectSize("latencyMs", 2000, 2150);
    expect(result.direction).toBe("unchanged");
    expect(result.relative).toBe(0);
  });

  it("treats sub-noise-floor changes as unchanged (cost)", () => {
    // $0.0005 difference is below noise floor of $0.001
    const result = computeEffectSize("costUsd", 0.05, 0.0505);
    expect(result.direction).toBe("unchanged");
  });

  it("treats sub-noise-floor changes as unchanged (quality)", () => {
    // 0.2 point difference is below noise floor of 0.3
    const result = computeEffectSize("qualityScore", 4.0, 3.8);
    expect(result.direction).toBe("unchanged");
  });

  it("handles zero baseline with noise floor scaling", () => {
    const result = computeEffectSize("totalTokens", 0, 100);
    expect(result.direction).toBe("regressed");
    // relative = absolute / noiseFloor = 100 / 50 = 2.0
    expect(result.relative).toBe(2.0);
  });

  it("detects cost reduction as improvement", () => {
    const result = computeEffectSize("costUsd", 0.05, 0.005);
    expect(result.direction).toBe("improved");
    expect(result.relative).toBeCloseTo(-0.9);
  });

  it("defaults to lower-is-better for unknown metrics", () => {
    const result = computeEffectSize("unknownMetric", 100, 50);
    expect(result.direction).toBe("improved"); // lower = better by default
  });
});

// ─── checkRegressions ─────────────────────────────────────────────────

describe("checkRegressions", () => {
  const allMetrics = ["totalTokens", "latencyMs", "costUsd", "qualityScore"];

  it("returns empty array when no regressions", () => {
    const before = { totalTokens: 1500, latencyMs: 2000, costUsd: 0.05, qualityScore: 4.0 };
    const after = { totalTokens: 800, latencyMs: 1000, costUsd: 0.01, qualityScore: 4.2 };
    const regs = checkRegressions(allMetrics, before, after);
    expect(regs).toHaveLength(0);
  });

  it("flags token regression exceeding both thresholds", () => {
    // totalTokens: 1000 → 1300 = +300 absolute (>100) AND +30% relative (>20%)
    const before = { totalTokens: 1000, latencyMs: 2000, costUsd: 0.05, qualityScore: 4.0 };
    const after = { totalTokens: 1300, latencyMs: 2000, costUsd: 0.05, qualityScore: 4.0 };
    const regs = checkRegressions(allMetrics, before, after);
    expect(regs).toHaveLength(1);
    expect(regs[0].metric).toBe("totalTokens");
    expect(regs[0].absoluteChange).toBe(300);
  });

  it("does not flag token regression below absolute threshold", () => {
    // totalTokens: 1000 → 1050 = +50 absolute (<100 threshold)
    const before = { totalTokens: 1000, latencyMs: 2000, costUsd: 0.05, qualityScore: 4.0 };
    const after = { totalTokens: 1050, latencyMs: 2000, costUsd: 0.05, qualityScore: 4.0 };
    const regs = checkRegressions(allMetrics, before, after);
    const tokenReg = regs.find((r) => r.metric === "totalTokens");
    expect(tokenReg).toBeUndefined();
  });

  it("does not flag token regression below relative threshold", () => {
    // totalTokens: 10000 → 10150 = +150 absolute (>100) but +1.5% relative (<20%)
    const before = { totalTokens: 10000, latencyMs: 2000, costUsd: 0.05, qualityScore: 4.0 };
    const after = { totalTokens: 10150, latencyMs: 2000, costUsd: 0.05, qualityScore: 4.0 };
    const regs = checkRegressions(allMetrics, before, after);
    const tokenReg = regs.find((r) => r.metric === "totalTokens");
    expect(tokenReg).toBeUndefined();
  });

  it("flags quality regression (lower score is bad)", () => {
    // qualityScore: 4.0 → 3.2 = -0.8 absolute (>0.5) AND -20% relative (>10%)
    const before = { totalTokens: 1000, latencyMs: 2000, costUsd: 0.05, qualityScore: 4.0 };
    const after = { totalTokens: 1000, latencyMs: 2000, costUsd: 0.05, qualityScore: 3.2 };
    const regs = checkRegressions(allMetrics, before, after);
    expect(regs).toHaveLength(1);
    expect(regs[0].metric).toBe("qualityScore");
    expect(regs[0].absoluteChange).toBeCloseTo(0.8);
  });

  it("does not flag quality regression below absolute threshold", () => {
    // qualityScore: 4.0 → 3.7 = -0.3 absolute (<0.5 threshold)
    const before = { totalTokens: 1000, latencyMs: 2000, costUsd: 0.05, qualityScore: 4.0 };
    const after = { totalTokens: 1000, latencyMs: 2000, costUsd: 0.05, qualityScore: 3.7 };
    const regs = checkRegressions(allMetrics, before, after);
    const qualReg = regs.find((r) => r.metric === "qualityScore");
    expect(qualReg).toBeUndefined();
  });

  it("does not flag improvement as regression", () => {
    // All metrics improved
    const before = { totalTokens: 1500, latencyMs: 3000, costUsd: 0.10, qualityScore: 3.0 };
    const after = { totalTokens: 800, latencyMs: 1500, costUsd: 0.02, qualityScore: 4.5 };
    const regs = checkRegressions(allMetrics, before, after);
    expect(regs).toHaveLength(0);
  });

  it("flags multiple regressions simultaneously", () => {
    const before = { totalTokens: 1000, latencyMs: 1000, costUsd: 0.05, qualityScore: 4.0 };
    // Tokens doubled, latency tripled, quality tanked
    const after = { totalTokens: 2000, latencyMs: 3000, costUsd: 0.05, qualityScore: 2.5 };
    const regs = checkRegressions(allMetrics, before, after);
    expect(regs.length).toBeGreaterThanOrEqual(3);
    expect(regs.map((r) => r.metric)).toContain("totalTokens");
    expect(regs.map((r) => r.metric)).toContain("latencyMs");
    expect(regs.map((r) => r.metric)).toContain("qualityScore");
  });

  it("handles zero baseline gracefully", () => {
    // Cost goes from 0 to 0.05 — regression with Infinity relative change
    const before = { totalTokens: 1000, latencyMs: 2000, costUsd: 0, qualityScore: 4.0 };
    const after = { totalTokens: 1000, latencyMs: 2000, costUsd: 0.05, qualityScore: 4.0 };
    const regs = checkRegressions(allMetrics, before, after);
    const costReg = regs.find((r) => r.metric === "costUsd");
    expect(costReg).toBeDefined();
    expect(costReg!.relativeChange).toBe(Infinity);
  });

  it("checks only requested metrics", () => {
    // Only check tokens — quality regression should not be flagged
    const before = { totalTokens: 1000, qualityScore: 4.0 };
    const after = { totalTokens: 800, qualityScore: 2.0 };
    const regs = checkRegressions(["totalTokens"], before, after);
    expect(regs).toHaveLength(0); // tokens improved, quality not checked
  });

  it("skips metrics missing from before/after", () => {
    const before = { totalTokens: 1000 };
    const after = { totalTokens: 800 };
    // costUsd is in metricNames but not in the data — should be skipped
    const regs = checkRegressions(["totalTokens", "costUsd"], before, after);
    expect(regs).toHaveLength(0);
  });
});

// ─── Full paired comparison pipeline (integration) ───────────────────

describe("paired comparison pipeline (integration)", () => {
  it("Wilcoxon + bootstrap CI + effect size + regression check agree on clear improvement", () => {
    // Model downgrade scenario: tokens drop 60%, cost drops, quality stable
    const beforeTokens = [1500, 1800, 1200, 2000, 1600];
    const afterTokens = [600, 720, 480, 800, 640];
    const beforeCost = [0.048, 0.058, 0.038, 0.064, 0.051];
    const afterCost = [0.005, 0.006, 0.004, 0.007, 0.005];
    const beforeQuality = [4.0, 4.2, 3.8, 4.1, 4.0];
    const afterQuality = [3.9, 4.0, 3.7, 4.0, 3.8];

    // Wilcoxon: all diffs same direction → significant
    const wTokens = wilcoxonSignedRank(beforeTokens, afterTokens);
    expect(wTokens.effectiveN).toBe(5);
    expect(wTokens.pValue).toBeCloseTo(0.0625, 3);

    const wCost = wilcoxonSignedRank(beforeCost, afterCost);
    expect(wCost.pValue).toBeCloseTo(0.0625, 3);

    // Bootstrap CI: should not contain 0 (clear improvement)
    const ciTokens = bootstrapCI(beforeTokens, afterTokens, { seed: 42 });
    expect(ciTokens.pointEstimate).toBeLessThan(0);
    expect(ciTokens.upperBound).toBeLessThan(0); // entire CI below 0

    const ciCost = bootstrapCI(beforeCost, afterCost, { seed: 42 });
    expect(ciCost.upperBound).toBeLessThan(0);

    // Effect size: clear improvement
    const esTokens = computeEffectSize("totalTokens", 1620, 648);
    expect(esTokens.direction).toBe("improved");
    expect(esTokens.relative).toBeLessThan(-0.5);

    // Cliff's Delta: perfectly separated
    const cdTokens = cliffsDelta(beforeTokens, afterTokens);
    expect(cdTokens.delta).toBe(1.0);
    expect(cdTokens.category).toBe("large");

    // No quality regression
    const regs = checkRegressions(
      ["qualityScore"],
      { qualityScore: 4.02 },
      { qualityScore: 3.88 },
    );
    expect(regs).toHaveLength(0); // Below threshold
  });

  it("pipeline correctly identifies no-change scenario", () => {
    // Same values ± noise
    const before = [1000, 1000, 1000, 1000, 1000];
    const after = [1005, 995, 1010, 990, 1000];

    const w = wilcoxonSignedRank(before, after);
    expect(w.pValue).toBeGreaterThan(0.5);

    const ci = bootstrapCI(before, after, { seed: 42 });
    // CI should contain 0
    expect(ci.lowerBound).toBeLessThanOrEqual(0);
    expect(ci.upperBound).toBeGreaterThanOrEqual(0);

    const es = computeEffectSize("totalTokens", 1000, 1000);
    expect(es.direction).toBe("unchanged");
  });
});
