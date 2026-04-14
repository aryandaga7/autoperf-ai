/**
 * Judge model provider detection.
 *
 * Detects the correct AI SDK provider for a given judge model ID.
 * Uses dynamic import() so @ai-sdk/openai and @ai-sdk/google remain
 * optional peer dependencies — only loaded when the user actually
 * selects a non-Anthropic judge model via --judge-model.
 *
 * Default: claude-sonnet-4-6 via @ai-sdk/anthropic (required dep).
 */

import type { LanguageModel } from "ai";

// ── Provider mapping ──────────────────────────────────────────────

interface ProviderSpec {
  name: string;
  envVar: string;
  sdkPackage: string;
  factoryName: string;
  defaultModel: string;
}

const PROVIDERS: ProviderSpec[] = [
  {
    name: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    sdkPackage: "@ai-sdk/anthropic",
    factoryName: "anthropic",
    defaultModel: "claude-sonnet-4-6",
  },
  {
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    sdkPackage: "@ai-sdk/openai",
    factoryName: "openai",
    defaultModel: "gpt-5.4-mini",
  },
  {
    name: "Google",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    sdkPackage: "@ai-sdk/google",
    factoryName: "google",
    defaultModel: "gemini-2.5-flash",
  },
];

/** Prefix patterns to detect provider from model ID. */
const PREFIX_MAP: Array<{ prefix: string; providerName: string }> = [
  { prefix: "claude-", providerName: "Anthropic" },
  { prefix: "gpt-", providerName: "OpenAI" },
  { prefix: "o1", providerName: "OpenAI" },
  { prefix: "o3", providerName: "OpenAI" },
  { prefix: "o4", providerName: "OpenAI" },
  { prefix: "gemini-", providerName: "Google" },
];

// ── Detection ─────────────────────────────────────────────────────

export interface JudgeModelResult {
  model: LanguageModel;
  modelId: string;
  providerName: string;
}

function detectProvider(modelId: string): ProviderSpec | undefined {
  for (const { prefix, providerName } of PREFIX_MAP) {
    if (modelId.startsWith(prefix)) {
      return PROVIDERS.find((p) => p.name === providerName);
    }
  }
  return undefined;
}

/**
 * Resolve a judge model instance from a model ID string.
 *
 * - If modelId is provided, detects the provider from the prefix,
 *   checks the required env var, and dynamically imports the SDK.
 * - If modelId is undefined, defaults to claude-sonnet-4-6 via @ai-sdk/anthropic.
 *
 * Throws with a clear message if the required API key or SDK is missing.
 */
export async function resolveJudgeModel(
  modelId?: string,
): Promise<JudgeModelResult> {
  // Default to Anthropic
  const resolvedModelId = modelId ?? "claude-sonnet-4-6";
  const provider = detectProvider(resolvedModelId);

  if (!provider) {
    throw new Error(
      `Unknown judge model provider for "${resolvedModelId}". ` +
        `Model ID must start with one of: claude-, gpt-, o1, o3, o4, gemini-`,
    );
  }

  // Check API key
  if (!process.env[provider.envVar]) {
    throw new Error(
      `Judge model "${resolvedModelId}" requires ${provider.envVar} to be set.\n` +
        `Either set ${provider.envVar} in your .env file or use --judge-model to select a different provider.`,
    );
  }

  // Dynamic import of the provider SDK
  let factory: (id: string) => LanguageModel;
  try {
    const mod = await import(provider.sdkPackage);
    factory = mod[provider.factoryName];
  } catch {
    throw new Error(
      `Judge model "${resolvedModelId}" requires ${provider.sdkPackage} to be installed.\n` +
        `Run: npm install ${provider.sdkPackage}`,
    );
  }

  return {
    model: factory(resolvedModelId),
    modelId: resolvedModelId,
    providerName: provider.name,
  };
}
