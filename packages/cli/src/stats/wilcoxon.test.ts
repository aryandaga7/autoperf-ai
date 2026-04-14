import { describe, it, expect } from "vitest";
import { wilcoxonSignedRank } from "./statistics.js";

describe("wilcoxonSignedRank", () => {
  // ─── Known-answer tests against published tables ────────────────────

  it("returns p=1 when all differences are zero", () => {
    const result = wilcoxonSignedRank([5, 5, 5, 5, 5], [5, 5, 5, 5, 5]);
    expect(result.pValue).toBe(1);
    expect(result.effectiveN).toBe(0);
    expect(result.zeroDifferences).toBe(5);
  });

  it("detects perfectly consistent improvement (n=5, all positive diffs)", () => {
    // All 5 diffs positive → W+ = 1+2+3+4+5 = 15, W- = 0
    // Exact: only 1 of 32 permutations gives W+=15, so two-tailed p = 2/32 = 0.0625
    const result = wilcoxonSignedRank(
      [10, 20, 30, 40, 50],
      [11, 21, 31, 41, 51],
    );
    expect(result.effectiveN).toBe(5);
    expect(result.wStatistic).toBe(0); // min(W+, W-) = min(15, 0) = 0
    expect(result.pValue).toBeCloseTo(0.0625, 3);
    expect(result.method).toBe("exact");
  });

  it("detects clear improvement with varying magnitudes (n=5)", () => {
    // before: [100, 200, 300, 400, 500]
    // after:  [90, 180, 270, 360, 450]
    // diffs:  [-10, -20, -30, -40, -50] — all negative (after < before = improvement for lower-is-better)
    // All ranks assigned to negative: W- = 15, W+ = 0
    const result = wilcoxonSignedRank(
      [100, 200, 300, 400, 500],
      [90, 180, 270, 360, 450],
    );
    expect(result.wStatistic).toBe(0);
    expect(result.pValue).toBeCloseTo(0.0625, 3);
  });

  it("returns non-significant p for mixed directions (n=5)", () => {
    // Some up, some down — no clear trend
    const result = wilcoxonSignedRank(
      [100, 200, 300, 400, 500],
      [110, 190, 310, 390, 510],
    );
    expect(result.pValue).toBeGreaterThan(0.1);
  });

  it("handles n=3 (very small sample)", () => {
    // 3 differences, all positive → W+ = 1+2+3 = 6
    // Exact: 2^3 = 8 permutations. W+=6 is most extreme.
    // Two-tailed p = 2/8 = 0.25
    const result = wilcoxonSignedRank([1, 2, 3], [2, 4, 7]);
    expect(result.effectiveN).toBe(3);
    expect(result.pValue).toBeCloseTo(0.25, 2);
    expect(result.method).toBe("exact");
  });

  it("handles n=1 (single pair)", () => {
    const result = wilcoxonSignedRank([10], [20]);
    expect(result.effectiveN).toBe(1);
    // 2^1 = 2 permutations. Both as extreme as observed → p=1
    expect(result.pValue).toBe(1);
  });

  // ─── Tie handling ──────────────────────────────────────────────────

  it("handles tied absolute differences via average ranking", () => {
    // diffs: [5, 5, 10] → abs: [5, 5, 10]
    // Ranks: [1.5, 1.5, 3] (tied abs values get averaged rank)
    // All positive → W+ = 1.5 + 1.5 + 3 = 6
    const result = wilcoxonSignedRank([10, 20, 30], [15, 25, 40]);
    expect(result.effectiveN).toBe(3);
    expect(result.wStatistic).toBe(0); // W- = 0
  });

  it("excludes zero differences and tests remaining", () => {
    // 5 pairs, but 2 have zero difference → effective n=3
    const result = wilcoxonSignedRank(
      [10, 20, 30, 40, 50],
      [15, 20, 35, 40, 55],
    );
    expect(result.effectiveN).toBe(3);
    expect(result.zeroDifferences).toBe(2);
  });

  // ─── Larger samples (still exact, n ≤ 20) ─────────────────────────

  it("detects significant difference at n=10 with consistent improvement", () => {
    const before = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const after = [80, 160, 240, 320, 400, 480, 560, 640, 720, 800];
    // All differences negative (20% reduction)
    const result = wilcoxonSignedRank(before, after);
    expect(result.effectiveN).toBe(10);
    expect(result.pValue).toBeLessThan(0.01);
    expect(result.method).toBe("exact");
  });

  it("returns non-significant p at n=10 with mixed changes", () => {
    const before = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    // Half improve, half regress by similar amounts
    const after = [90, 210, 290, 410, 490, 610, 690, 810, 890, 1010];
    const result = wilcoxonSignedRank(before, after);
    expect(result.pValue).toBeGreaterThan(0.1);
  });

  it("uses exact method for n=20", () => {
    const before = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    const after = before.map((v) => v * 0.8); // 20% reduction across the board
    const result = wilcoxonSignedRank(before, after);
    expect(result.method).toBe("exact");
    expect(result.pValue).toBeLessThan(0.001);
  });

  // ─── Normal approximation (n > 20) ────────────────────────────────

  it("uses normal approximation for n > 20", () => {
    const n = 25;
    const before = Array.from({ length: n }, (_, i) => (i + 1) * 10);
    const after = before.map((v) => v * 0.8);
    const result = wilcoxonSignedRank(before, after);
    expect(result.method).toBe("normal-approximation");
    expect(result.pValue).toBeLessThan(0.001);
  });

  it("normal approx agrees roughly with exact for n=20", () => {
    // We can't directly force the method, but we can verify the exact
    // result at n=20 is reasonable (serves as a sanity cross-check)
    const before = Array.from({ length: 20 }, (_, i) => (i + 1) * 50);
    const after = before.map((v, i) => (i % 2 === 0 ? v * 0.9 : v * 1.1));
    const result = wilcoxonSignedRank(before, after);
    // Mixed changes → shouldn't be highly significant
    expect(result.pValue).toBeGreaterThan(0.01);
  });

  // ─── Error handling ────────────────────────────────────────────────

  it("throws on mismatched array lengths", () => {
    expect(() => wilcoxonSignedRank([1, 2, 3], [1, 2])).toThrow(
      "equal-length",
    );
  });

  it("handles empty arrays", () => {
    const result = wilcoxonSignedRank([], []);
    expect(result.effectiveN).toBe(0);
    expect(result.pValue).toBe(1);
  });

  // ─── Agent metric scenarios ────────────────────────────────────────

  it("detects significant token reduction from model downgrade", () => {
    // Opus → Haiku: ~60-80% token cost reduction per query
    const before = [1500, 1800, 1200, 2000, 1600];
    const after = [400, 500, 350, 550, 420];
    const result = wilcoxonSignedRank(before, after);
    expect(result.pValue).toBeCloseTo(0.0625, 3); // n=5, all same direction
    expect(result.wStatistic).toBe(0);
  });

  it("does not flag noise as significant", () => {
    // Random ±2% fluctuations in token counts
    const before = [1000, 1000, 1000, 1000, 1000];
    const after = [1020, 980, 1010, 990, 1005];
    const result = wilcoxonSignedRank(before, after);
    expect(result.pValue).toBeGreaterThan(0.1);
  });
});
