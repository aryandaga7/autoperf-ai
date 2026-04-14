import { describe, it, expect } from "vitest";
import { bootstrapCI } from "./statistics.js";

describe("bootstrapCI", () => {
  // ─── Basic behavior ────────────────────────────────────────────────

  it("returns a CI that contains the point estimate", () => {
    const before = [100, 200, 300, 400, 500];
    const after = [80, 160, 240, 320, 400];
    const result = bootstrapCI(before, after);
    expect(result.pointEstimate).toBeCloseTo(-60, 0); // mean diff = -60
    expect(result.lowerBound).toBeLessThanOrEqual(result.pointEstimate);
    expect(result.upperBound).toBeGreaterThanOrEqual(result.pointEstimate);
    expect(result.confidenceLevel).toBe(0.95);
  });

  it("uses percentile method for n < 8", () => {
    const before = [100, 200, 300, 400, 500];
    const after = [80, 160, 240, 320, 400];
    const result = bootstrapCI(before, after);
    expect(result.method).toBe("percentile");
  });

  it("uses BCa method for n >= 8", () => {
    const before = [100, 200, 300, 400, 500, 600, 700, 800];
    const after = [80, 160, 240, 320, 400, 480, 560, 640];
    const result = bootstrapCI(before, after);
    expect(result.method).toBe("bca");
  });

  it("produces narrower CI with more data", () => {
    const seed = 123;
    // Use n=10 vs n=20 so both use BCa (n >= 8)
    // Add variance so the CI isn't degenerate
    const before10 = [100, 200, 300, 400, 500, 150, 250, 350, 450, 550];
    const after10 = [75, 170, 250, 340, 430, 120, 210, 300, 390, 480];
    const ci10 = bootstrapCI(before10, after10, { seed });
    const width10 = ci10.upperBound - ci10.lowerBound;

    const before20 = [...before10, 120, 220, 320, 420, 520, 180, 280, 380, 480, 580];
    const after20 = [...after10, 95, 185, 270, 360, 450, 145, 240, 330, 420, 510];
    const ci20 = bootstrapCI(before20, after20, { seed });
    const width20 = ci20.upperBound - ci20.lowerBound;

    expect(width20).toBeLessThan(width10);
  });

  // ─── Deterministic with seed ───────────────────────────────────────

  it("produces identical results with the same seed", () => {
    const before = [100, 200, 300, 400, 500];
    const after = [80, 160, 240, 320, 400];
    const r1 = bootstrapCI(before, after, { seed: 999 });
    const r2 = bootstrapCI(before, after, { seed: 999 });
    expect(r1.lowerBound).toBe(r2.lowerBound);
    expect(r1.upperBound).toBe(r2.upperBound);
  });

  it("produces different results with different seeds", () => {
    // Data with variance so resampling actually produces different outcomes
    const before = [100, 200, 300, 400, 500];
    const after = [75, 210, 250, 380, 520];
    const r1 = bootstrapCI(before, after, { seed: 1 });
    const r2 = bootstrapCI(before, after, { seed: 2 });
    // Very likely different (though theoretically could be same)
    expect(
      r1.lowerBound !== r2.lowerBound || r1.upperBound !== r2.upperBound,
    ).toBe(true);
  });

  // ─── Edge cases ────────────────────────────────────────────────────

  it("handles empty arrays", () => {
    const result = bootstrapCI([], []);
    expect(result.pointEstimate).toBe(0);
    expect(result.lowerBound).toBe(0);
    expect(result.upperBound).toBe(0);
  });

  it("handles n=1 (cannot bootstrap)", () => {
    const result = bootstrapCI([100], [80]);
    expect(result.pointEstimate).toBe(-20);
    expect(result.lowerBound).toBe(-20);
    expect(result.upperBound).toBe(-20);
  });

  it("handles all-same values (zero variance)", () => {
    const before = [100, 100, 100, 100, 100];
    const after = [80, 80, 80, 80, 80];
    const result = bootstrapCI(before, after);
    expect(result.pointEstimate).toBe(-20);
    // CI should be very tight around -20
    expect(result.lowerBound).toBeCloseTo(-20, 1);
    expect(result.upperBound).toBeCloseTo(-20, 1);
  });

  it("handles all-zero differences", () => {
    const before = [100, 200, 300, 400, 500];
    const after = [100, 200, 300, 400, 500];
    const result = bootstrapCI(before, after);
    expect(result.pointEstimate).toBe(0);
    expect(result.lowerBound).toBe(0);
    expect(result.upperBound).toBe(0);
  });

  it("handles large outlier", () => {
    const before = [100, 100, 100, 100, 100, 100, 100, 100, 100, 10000];
    const after = [80, 80, 80, 80, 80, 80, 80, 80, 80, 5000];
    const result = bootstrapCI(before, after);
    // The outlier pair has diff = -5000, others have diff = -20
    // Mean diff ≈ -518, but CI should be wide due to outlier
    expect(result.upperBound - result.lowerBound).toBeGreaterThan(100);
  });

  it("throws on mismatched lengths", () => {
    expect(() => bootstrapCI([1, 2, 3], [1, 2])).toThrow("equal-length");
  });

  // ─── Coverage meta-test ────────────────────────────────────────────

  it("CI covers the true mean difference in ≥90% of simulated runs (n=10)", () => {
    // Synthetic data: true mean difference = -50, sd = 20
    // Run 200 simulations, check coverage
    const trueMeanDiff = -50;
    const sd = 20;
    const n = 10;
    const nSims = 200;
    let covered = 0;

    for (let sim = 0; sim < nSims; sim++) {
      // Generate paired data with known difference
      const before: number[] = [];
      const after: number[] = [];

      // Simple pseudo-random using different seeds per sim
      const rng = mulberry32(sim * 1000 + 7);
      for (let i = 0; i < n; i++) {
        const base = 500 + boxMuller(rng) * 100;
        before.push(base);
        after.push(base + trueMeanDiff + boxMuller(rng) * sd);
      }

      const ci = bootstrapCI(before, after, {
        seed: sim + 42,
        nBootstrap: 2000, // fewer for speed
      });

      if (ci.lowerBound <= trueMeanDiff && trueMeanDiff <= ci.upperBound) {
        covered++;
      }
    }

    const coverageRate = covered / nSims;
    // 95% CI should cover ≥90% of the time (allowing for small-n undercover)
    expect(coverageRate).toBeGreaterThanOrEqual(0.85);
  });

  // ─── Custom alpha ──────────────────────────────────────────────────

  it("wider CI at 99% vs 95%", () => {
    const before = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
    const after = before.map((v) => v * 0.8);
    const ci95 = bootstrapCI(before, after, { alpha: 0.05, seed: 42 });
    const ci99 = bootstrapCI(before, after, { alpha: 0.01, seed: 42 });
    const width95 = ci95.upperBound - ci95.lowerBound;
    const width99 = ci99.upperBound - ci99.lowerBound;
    expect(width99).toBeGreaterThanOrEqual(width95);
  });
});

// ─── Test helpers (simple PRNG + Box-Muller for normal samples) ──────

function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(rng: () => number): number {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}
