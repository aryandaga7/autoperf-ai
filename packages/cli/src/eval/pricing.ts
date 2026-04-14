// Multi-provider model pricing (USD per 1M tokens) — April 2026
// Sources: Anthropic, OpenAI, Google pricing pages

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  // Anthropic-style: explicit cache with write overhead
  cacheWritePer1M?: number;
  cacheReadPer1M?: number;
  // OpenAI/Google-style: automatic caching at discounted rate
  cachedInputPer1M?: number;
}

const PRICING: Record<string, ModelPricing> = {
  // ── Anthropic ─────────────────────────────────────────────────────
  // Cache model: explicit breakpoints, 90% read discount, 25% write overhead

  // Opus 4.6
  "claude-opus-4-6": {
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    cacheWritePer1M: 6.25,
    cacheReadPer1M: 0.5,
  },
  // Haiku 4.5
  "claude-haiku-4-5-20251001": {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    cacheWritePer1M: 1.25,
    cacheReadPer1M: 0.1,
  },
  // Sonnet 4.5
  "claude-sonnet-4-5-20250929": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.3,
  },
  // Sonnet 4.0
  "claude-sonnet-4-20250514": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.3,
  },
  // Opus 4.5
  "claude-opus-4-5-20251101": {
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    cacheWritePer1M: 6.25,
    cacheReadPer1M: 0.5,
  },
  // Opus 4.0
  "claude-opus-4-0-20250514": {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheWritePer1M: 18.75,
    cacheReadPer1M: 1.5,
  },
  // Sonnet 4.6
  "claude-sonnet-4-6": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.3,
  },
  // Haiku 4.5 (short alias — also in ALIASES)
  "claude-haiku-4-5": {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    cacheWritePer1M: 1.25,
    cacheReadPer1M: 0.1,
  },

  // ── OpenAI ────────────────────────────────────────────────────────
  // Cache model: automatic for prompts ≥1024 tokens, no write overhead

  // GPT-5.4 (frontier)
  "gpt-5.4": {
    inputPer1M: 2.5,
    outputPer1M: 15.0,
    cachedInputPer1M: 1.25,
  },
  // GPT-5.4-mini (mid-tier workhorse)
  "gpt-5.4-mini": {
    inputPer1M: 0.75,
    outputPer1M: 4.5,
    cachedInputPer1M: 0.075,
  },
  // GPT-5.4-nano (budget sub-agent)
  "gpt-5.4-nano": {
    inputPer1M: 0.2,
    outputPer1M: 1.25,
    cachedInputPer1M: 0.02,
  },

  // ── Google ────────────────────────────────────────────────────────
  // Cache model: implicit automatic caching, 75% token discount

  // Gemini 2.5 Pro (frontier reasoning)
  "gemini-2.5-pro": {
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    cachedInputPer1M: 0.3125,
  },
  // Gemini 2.5 Flash (mid-tier, 1M context)
  "gemini-2.5-flash": {
    inputPer1M: 0.3,
    outputPer1M: 2.5,
    cachedInputPer1M: 0.075,
  },
  // Gemini 2.5 Flash-Lite (ultra-cheap, 1M context)
  "gemini-2.5-flash-lite": {
    inputPer1M: 0.1,
    outputPer1M: 0.4,
    cachedInputPer1M: 0.025,
  },
};

// Aliases for common short names
const ALIASES: Record<string, string> = {
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-0": "claude-sonnet-4-20250514",
  "claude-opus-4-5": "claude-opus-4-5-20251101",
  "claude-opus-4-0": "claude-opus-4-0-20250514",
};

// Provider-based fallback tiers for unknown models (better than defaulting to Sonnet)
const PROVIDER_FALLBACKS: Record<string, string> = {
  "gpt-": "gpt-5.4-mini",
  o1: "gpt-5.4-mini",
  o3: "gpt-5.4-mini",
  o4: "gpt-5.4-mini",
  "claude-": "claude-haiku-4-5-20251001",
  "gemini-": "gemini-2.5-flash",
};

/**
 * Strip date suffixes from model IDs for fuzzy matching.
 * OpenAI: gpt-5.4-mini-2026-03-17 → gpt-5.4-mini
 * Anthropic: claude-haiku-4-5-20251001 → claude-haiku-4-5
 */
function normalizeModelId(id: string): string {
  return id
    .replace(/-\d{4}-\d{2}-\d{2}$/, "") // OpenAI YYYY-MM-DD
    .replace(/-\d{8}$/, ""); // Anthropic YYYYMMDD
}

function resolveProviderFallback(modelId: string): ModelPricing | undefined {
  for (const [prefix, fallbackId] of Object.entries(PROVIDER_FALLBACKS)) {
    if (modelId.startsWith(prefix)) {
      return PRICING[fallbackId];
    }
  }
  return undefined;
}

function resolve(modelId: string): ModelPricing | undefined {
  // 1. Exact match
  if (PRICING[modelId]) return PRICING[modelId];
  if (ALIASES[modelId]) return PRICING[ALIASES[modelId]];

  // 2. Normalized match (strip date suffixes)
  const normalized = normalizeModelId(modelId);
  if (normalized !== modelId) {
    if (PRICING[normalized]) return PRICING[normalized];
    if (ALIASES[normalized]) return PRICING[ALIASES[normalized]];
  }

  // 3. Provider-based fallback (better than Sonnet for all)
  return resolveProviderFallback(modelId);
}

export function computeCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const pricing = resolve(modelId);
  if (!pricing) {
    // Truly unknown model (no exact, normalized, or provider-prefix match)
    console.warn(
      `[autoperf] Unknown model "${modelId}" — using Haiku pricing as fallback. ` +
        `Add this model to pricing.ts or provide a pricing override.`,
    );
    const fallback = PRICING["claude-haiku-4-5-20251001"];
    return (
      (inputTokens * fallback.inputPer1M +
        outputTokens * fallback.outputPer1M) /
      1_000_000
    );
  }

  const regularInputTokens = Math.max(0, inputTokens - cacheReadTokens);

  // Anthropic-style: explicit cache with write cost + discounted reads
  if (pricing.cacheReadPer1M != null) {
    return (
      (regularInputTokens * pricing.inputPer1M +
        outputTokens * pricing.outputPer1M +
        cacheReadTokens * pricing.cacheReadPer1M +
        cacheWriteTokens * (pricing.cacheWritePer1M ?? 0)) /
      1_000_000
    );
  }

  // OpenAI/Google-style: automatic caching at discounted input rate
  if (pricing.cachedInputPer1M != null) {
    return (
      (regularInputTokens * pricing.inputPer1M +
        outputTokens * pricing.outputPer1M +
        cacheReadTokens * pricing.cachedInputPer1M) /
      1_000_000
    );
  }

  // No caching info — count all input at full rate
  return (
    (inputTokens * pricing.inputPer1M + outputTokens * pricing.outputPer1M) /
    1_000_000
  );
}

export function getModelPricing(modelId: string): ModelPricing | undefined {
  return resolve(modelId);
}

/** All known model IDs (including aliases). */
export function getAllModelIds(): string[] {
  return [...Object.keys(PRICING), ...Object.keys(ALIASES)];
}
