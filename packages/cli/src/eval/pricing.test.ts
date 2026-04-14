import { describe, it, expect } from "vitest";
import { computeCost, getModelPricing, getAllModelIds } from "./pricing.js";

// ─── normalizeModelId (tested indirectly via getModelPricing / computeCost) ──

describe("normalizeModelId — via getModelPricing()", () => {
  it("strips OpenAI YYYY-MM-DD suffix: gpt-5.4-mini-2026-03-17 → gpt-5.4-mini", () => {
    // Direct key exists for the normalized form
    const direct = getModelPricing("gpt-5.4-mini");
    const suffixed = getModelPricing("gpt-5.4-mini-2026-03-17");
    expect(suffixed).toBeDefined();
    expect(suffixed).toEqual(direct);
  });

  it("strips Anthropic YYYYMMDD suffix: claude-haiku-4-5-20251001 → claude-haiku-4-5", () => {
    // claude-haiku-4-5 is a direct PRICING key (also an alias target)
    const direct = getModelPricing("claude-haiku-4-5");
    const suffixed = getModelPricing("claude-haiku-4-5-20251001");
    expect(direct).toBeDefined();
    expect(suffixed).toBeDefined();
    // Both resolve to haiku pricing
    expect(suffixed!.inputPer1M).toBe(direct!.inputPer1M);
    expect(suffixed!.outputPer1M).toBe(direct!.outputPer1M);
  });

  it("leaves claude-sonnet-4-6 unchanged (no date suffix)", () => {
    const pricing = getModelPricing("claude-sonnet-4-6");
    expect(pricing).toBeDefined();
    expect(pricing!.inputPer1M).toBe(3.0);
    expect(pricing!.outputPer1M).toBe(15.0);
  });

  it("leaves gpt-5.4 unchanged (no date suffix)", () => {
    const pricing = getModelPricing("gpt-5.4");
    expect(pricing).toBeDefined();
    expect(pricing!.inputPer1M).toBe(2.5);
    expect(pricing!.outputPer1M).toBe(15.0);
  });
});

// ─── computeCost ─────────────────────────────────────────────────────────────

describe("computeCost", () => {
  // ─── Zero tokens ────────────────────────────────────────────────────

  it("returns 0 when all token counts are zero", () => {
    expect(computeCost("claude-haiku-4-5", 0, 0)).toBe(0);
  });

  it("returns 0 when all token counts are zero (OpenAI model)", () => {
    expect(computeCost("gpt-5.4-mini", 0, 0)).toBe(0);
  });

  // ─── Anthropic model with cache tokens ──────────────────────────────

  it("anthropic model (claude-haiku-4-5-20251001) — uses cache read/write pricing", () => {
    // 1M input, 1M cache read, 1M cache write, 1M output
    // inputPer1M=1.0, outputPer1M=5.0, cacheWritePer1M=1.25, cacheReadPer1M=0.1
    // regularInput = 1M - 1M (cacheRead) = 0
    // cost = (0*1.0 + 1M*5.0 + 1M*0.1 + 1M*1.25) / 1M = 5.0 + 0.1 + 1.25 = 6.35
    const cost = computeCost(
      "claude-haiku-4-5-20251001",
      1_000_000,
      1_000_000,
      1_000_000,
      1_000_000,
    );
    expect(cost).toBeCloseTo(6.35, 6);
  });

  it("anthropic model without cache tokens — uses full input rate", () => {
    // 1M input, 1M output, no cache
    // cost = (1M*1.0 + 1M*5.0) / 1M = 6.0
    const cost = computeCost("claude-haiku-4-5-20251001", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(6.0, 6);
  });

  // ─── OpenAI model with date suffix ──────────────────────────────────

  it("openai model with date suffix (gpt-5.4-mini-2026-03-17) — resolves to $0.75/$4.50", () => {
    // gpt-5.4-mini: inputPer1M=0.75, outputPer1M=4.50
    // 1M input, 1M output, no cache
    // cost = (1M*0.75 + 1M*4.5) / 1M = 5.25
    const cost = computeCost("gpt-5.4-mini-2026-03-17", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(5.25, 6);
  });

  it("openai date-suffixed model uses $0.75 NOT $3 (distinguishes from Sonnet pricing)", () => {
    // gpt-5.4-mini input cost = $0.75/M, Sonnet = $3/M
    const miniCost = computeCost("gpt-5.4-mini-2026-03-17", 1_000_000, 0);
    expect(miniCost).toBeCloseTo(0.75, 6);
    expect(miniCost).not.toBeCloseTo(3.0, 1);
  });

  // ─── OpenAI base name ───────────────────────────────────────────────

  it("openai base name (gpt-5.4-nano) — uses $0.20/$1.25", () => {
    // inputPer1M=0.20, outputPer1M=1.25
    // 1M input, 1M output = 1.45
    const cost = computeCost("gpt-5.4-nano", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(1.45, 6);
  });

  // ─── Anthropic alias ─────────────────────────────────────────────────

  it("anthropic alias (claude-sonnet-4-5) resolves through alias map", () => {
    // alias → claude-sonnet-4-5-20250929: inputPer1M=3.0, outputPer1M=15.0
    // 1M input, 1M output = 18.0
    const cost = computeCost("claude-sonnet-4-5", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18.0, 6);
  });

  // ─── Unknown model with known prefix ────────────────────────────────

  it("unknown openai-prefix model (o3-mini-2026-01-15) — uses gpt-5.4-mini provider fallback", () => {
    // o3 prefix → gpt-5.4-mini: inputPer1M=0.75, outputPer1M=4.50
    // 1M input, 1M output = 5.25
    const cost = computeCost("o3-mini-2026-01-15", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(5.25, 6);
  });

  it("unknown gpt-prefix model — uses gpt-5.4-mini provider fallback", () => {
    // gpt- prefix → gpt-5.4-mini: inputPer1M=0.75
    const cost = computeCost("gpt-99-turbo", 1_000_000, 0);
    expect(cost).toBeCloseTo(0.75, 6);
  });

  // ─── Completely unknown model — Haiku fallback ───────────────────────

  it("completely unknown model (kimi-2.0-pro) — uses Haiku fallback pricing", () => {
    // Haiku fallback: inputPer1M=1.0, outputPer1M=5.0
    // 1M input, 1M output = 6.0
    const cost = computeCost("kimi-2.0-pro", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(6.0, 6);
  });

  it("completely unknown model with no prefix match — Haiku fallback is cheaper than Sonnet", () => {
    // Haiku (1.0 input) cheaper than Sonnet (3.0 input)
    const unknownCost = computeCost("unknown-model-xyz", 1_000_000, 0);
    const sonnetCost = computeCost("claude-sonnet-4-6", 1_000_000, 0);
    expect(unknownCost).toBeLessThan(sonnetCost);
    // Specifically uses Haiku pricing
    expect(unknownCost).toBeCloseTo(1.0, 6);
  });

  // ─── Google model ────────────────────────────────────────────────────

  it("google model (gemini-2.5-flash) — uses $0.30/$2.50", () => {
    // inputPer1M=0.30, outputPer1M=2.50
    // 1M input, 1M output = 2.80
    const cost = computeCost("gemini-2.5-flash", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(2.8, 6);
  });

  it("google model with cached input uses discounted cachedInputPer1M rate", () => {
    // gemini-2.5-flash: inputPer1M=0.30, cachedInputPer1M=0.075, outputPer1M=2.50
    // regularInput = 1M - 0.5M = 0.5M at $0.30, cache = 0.5M at $0.075, output 0
    // cost = (500_000*0.30 + 500_000*0.075) / 1M = 0.15 + 0.0375 = 0.1875
    const cost = computeCost("gemini-2.5-flash", 1_000_000, 0, 500_000);
    expect(cost).toBeCloseTo(0.1875, 6);
  });

  // ─── Scale tests (real token counts) ────────────────────────────────

  it("computes correct cost for typical real-world token counts (claude-haiku-4-5)", () => {
    // 5000 input, 500 output, 2000 cache read, 1000 cache write
    // regularInput = 5000 - 2000 = 3000
    // cost = (3000*1.0 + 500*5.0 + 2000*0.1 + 1000*1.25) / 1M
    //      = (3000 + 2500 + 200 + 1250) / 1M = 6950 / 1M = 0.00695
    const cost = computeCost("claude-haiku-4-5", 5000, 500, 2000, 1000);
    expect(cost).toBeCloseTo(0.00695, 5);
  });
});

// ─── getModelPricing ─────────────────────────────────────────────────────────

describe("getModelPricing", () => {
  it("returns pricing object for a known model", () => {
    const pricing = getModelPricing("gpt-5.4-mini");
    expect(pricing).toBeDefined();
    expect(pricing!.inputPer1M).toBe(0.75);
    expect(pricing!.outputPer1M).toBe(4.5);
    expect(pricing!.cachedInputPer1M).toBe(0.075);
  });

  it("returns pricing for a date-suffixed OpenAI model (not undefined)", () => {
    const pricing = getModelPricing("gpt-5.4-mini-2026-03-17");
    expect(pricing).toBeDefined();
    expect(pricing!.inputPer1M).toBe(0.75);
  });

  it("returns pricing for a date-suffixed Anthropic model (not undefined)", () => {
    const pricing = getModelPricing("claude-haiku-4-5-20251001");
    expect(pricing).toBeDefined();
    expect(pricing!.inputPer1M).toBe(1.0);
    expect(pricing!.cacheReadPer1M).toBe(0.1);
    expect(pricing!.cacheWritePer1M).toBe(1.25);
  });

  it("returns fallback pricing for unknown model with known provider prefix", () => {
    const pricing = getModelPricing("o3-mini");
    expect(pricing).toBeDefined();
    // o3 prefix → gpt-5.4-mini fallback
    expect(pricing!.inputPer1M).toBe(0.75);
  });

  it("returns undefined for completely unknown model with no prefix match", () => {
    const pricing = getModelPricing("kimi-2.0-pro");
    expect(pricing).toBeUndefined();
  });

  it("returns pricing for alias (claude-sonnet-4-5)", () => {
    const pricing = getModelPricing("claude-sonnet-4-5");
    expect(pricing).toBeDefined();
    expect(pricing!.inputPer1M).toBe(3.0);
    expect(pricing!.outputPer1M).toBe(15.0);
  });

  it("returns correct google model pricing (gemini-2.5-flash)", () => {
    const pricing = getModelPricing("gemini-2.5-flash");
    expect(pricing).toBeDefined();
    expect(pricing!.inputPer1M).toBe(0.3);
    expect(pricing!.outputPer1M).toBe(2.5);
    expect(pricing!.cachedInputPer1M).toBe(0.075);
  });
});

// ─── getAllModelIds ───────────────────────────────────────────────────────────

describe("getAllModelIds", () => {
  it("returns a non-empty array", () => {
    const ids = getAllModelIds();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("contains direct pricing keys", () => {
    const ids = getAllModelIds();
    expect(ids).toContain("gpt-5.4-mini");
    expect(ids).toContain("gpt-5.4-nano");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("gemini-2.5-flash");
  });

  it("contains alias keys", () => {
    const ids = getAllModelIds();
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).toContain("claude-sonnet-4-5");
    expect(ids).toContain("claude-opus-4-5");
  });

  it("contains both direct keys and alias keys (union)", () => {
    const ids = getAllModelIds();
    // At minimum: the models listed in PRICING + the aliases
    // We know there are Anthropic, OpenAI, and Google models
    const hasAnthropic = ids.some((id) => id.startsWith("claude-"));
    const hasOpenAI = ids.some((id) => id.startsWith("gpt-"));
    const hasGoogle = ids.some((id) => id.startsWith("gemini-"));
    expect(hasAnthropic).toBe(true);
    expect(hasOpenAI).toBe(true);
    expect(hasGoogle).toBe(true);
  });
});
