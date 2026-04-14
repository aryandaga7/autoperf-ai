/**
 * Dynamic model registry.
 *
 * At startup, detects which providers are available (API key + installed
 * package) and generates an `available-models.md` file listing only usable
 * models, sorted by price. The iteration agent reads this to make informed
 * cross-provider model routing decisions.
 *
 * A provider is "available" when BOTH:
 * 1. The env var is set (e.g., OPENAI_API_KEY)
 * 2. The SDK package is installed in the target agent's node_modules
 */

import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

// ── Provider definitions ───────────────────────────────────────────

interface ProviderDef {
  name: string;
  envVar: string;
  /** npm package that must be in the target's node_modules */
  sdkPackage: string;
  /** Import path used in code: e.g., `import { openai } from '@ai-sdk/openai'` */
  importPath: string;
  /** Factory function name: e.g., `openai('gpt-5.4-mini')` */
  factoryName: string;
}

const PROVIDERS: ProviderDef[] = [
  {
    name: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    sdkPackage: "@ai-sdk/anthropic",
    importPath: "@ai-sdk/anthropic",
    factoryName: "anthropic",
  },
  {
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    sdkPackage: "@ai-sdk/openai",
    importPath: "@ai-sdk/openai",
    factoryName: "openai",
  },
  {
    name: "Google",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    sdkPackage: "@ai-sdk/google",
    importPath: "@ai-sdk/google",
    factoryName: "google",
  },
];

// ── Model catalog ──────────────────────────────────────────────────

interface ModelDef {
  id: string;
  provider: string;
  tier: "frontier" | "mid-tier" | "budget";
  inputPer1M: number;
  outputPer1M: number;
  contextWindow: string;
  notes: string;
}

/** Curated models sorted by effective cost (input + output weighted). */
const MODEL_CATALOG: ModelDef[] = [
  // Budget tier — sorted cheapest first
  {
    id: "gemini-2.5-flash-lite",
    provider: "Google",
    tier: "budget",
    inputPer1M: 0.1,
    outputPer1M: 0.4,
    contextWindow: "1M",
    notes: "Cheapest with 1M context. Good for simple tool calls, extraction.",
  },
  {
    id: "gpt-5.4-nano",
    provider: "OpenAI",
    tier: "budget",
    inputPer1M: 0.2,
    outputPer1M: 1.25,
    contextWindow: "400K",
    notes: "Best ultra-cheap OpenAI. Designed for sub-agents, classification.",
  },
  {
    id: "gemini-2.5-flash",
    provider: "Google",
    tier: "budget",
    inputPer1M: 0.3,
    outputPer1M: 2.5,
    contextWindow: "1M",
    notes: "Strong balance of cost and capability. 1M flat-rate context.",
  },

  // Mid-tier — sorted cheapest first
  {
    id: "gpt-5.4-mini",
    provider: "OpenAI",
    tier: "mid-tier",
    inputPer1M: 0.75,
    outputPer1M: 4.5,
    contextWindow: "400K",
    notes: "Best mid-tier value. 2x faster than GPT-5 mini. Full tool support.",
  },
  {
    id: "claude-haiku-4-5",
    provider: "Anthropic",
    tier: "mid-tier",
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    contextWindow: "200K",
    notes: "Proven in production. SWE-bench 73.3%. Reliable tool-calling.",
  },
  {
    id: "gemini-2.5-pro",
    provider: "Google",
    tier: "mid-tier",
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    contextWindow: "1M",
    notes:
      "Strong reasoning. 1M context. Approaching deprecation (Oct 2026 on Vertex).",
  },

  // Frontier — sorted cheapest first
  {
    id: "gpt-5.4",
    provider: "OpenAI",
    tier: "frontier",
    inputPer1M: 2.5,
    outputPer1M: 15.0,
    contextWindow: "1.05M",
    notes: "OpenAI flagship. Strong tool-calling, improved Toolathlon scores.",
  },
  {
    id: "claude-sonnet-4-6",
    provider: "Anthropic",
    tier: "frontier",
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    contextWindow: "1M",
    notes:
      "SWE-bench 79.6%, #1 MCP-Atlas tool-use benchmark. Primary workhorse.",
  },
  {
    id: "claude-opus-4-6",
    provider: "Anthropic",
    tier: "frontier",
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    contextWindow: "1M",
    notes:
      "SWE-bench 80.8%. Most capable. Use only when frontier reasoning needed.",
  },
];

// ── Availability detection ────────────────────────────────────────

interface ProviderAvailability {
  provider: ProviderDef;
  hasKey: boolean;
  hasPackage: boolean;
  available: boolean;
}

function checkProviderAvailability(targetDir: string): ProviderAvailability[] {
  return PROVIDERS.map((provider) => {
    const hasKey = !!process.env[provider.envVar];
    const packagePath = join(
      targetDir,
      "node_modules",
      ...provider.sdkPackage.split("/"),
    );
    const hasPackage = existsSync(packagePath);
    return {
      provider,
      hasKey,
      hasPackage,
      available: hasKey && hasPackage,
    };
  });
}

// ── Markdown generation ────────────────────────────────────────────

function generateAvailableModelsMarkdown(
  availability: ProviderAvailability[],
): string {
  const availableProviders = new Set(
    availability.filter((a) => a.available).map((a) => a.provider.name),
  );

  const availableModels = MODEL_CATALOG.filter((m) =>
    availableProviders.has(m.provider),
  );

  const lines: string[] = [
    "# Available Models",
    "",
    "Models available in this environment, sorted by price within each tier.",
    "Route each step to the **cheapest model that meets its complexity requirements**.",
    "Provider is irrelevant — only price and capability matter.",
    "",
  ];

  // Provider status summary
  lines.push("## Provider Status");
  lines.push("");
  for (const a of availability) {
    const status = a.available
      ? "AVAILABLE"
      : !a.hasKey
        ? `UNAVAILABLE (missing ${a.provider.envVar})`
        : `UNAVAILABLE (missing ${a.provider.sdkPackage} in target node_modules)`;
    lines.push(`- **${a.provider.name}**: ${status}`);
  }
  lines.push("");

  if (availableModels.length === 0) {
    lines.push(
      "**No cross-provider models available.** Only the target agent's current model can be used.",
    );
    lines.push(
      "To unlock model routing, install provider packages and set API keys.",
    );
    return lines.join("\n");
  }

  // Model table by tier
  const tiers: Array<{ name: string; key: ModelDef["tier"] }> = [
    {
      name: "Budget (simple steps: tool calls, classification, extraction)",
      key: "budget",
    },
    {
      name: "Mid-Tier (moderate steps: data gathering, analysis)",
      key: "mid-tier",
    },
    {
      name: "Frontier (complex steps: synthesis, multi-step reasoning)",
      key: "frontier",
    },
  ];

  for (const tier of tiers) {
    const tierModels = availableModels.filter((m) => m.tier === tier.key);
    if (tierModels.length === 0) continue;

    lines.push(`## ${tier.name}`);
    lines.push("");
    lines.push(
      "| Model ID | Provider | Input $/1M | Output $/1M | Context | Notes |",
    );
    lines.push(
      "|----------|----------|-----------|-------------|---------|-------|",
    );
    for (const m of tierModels) {
      lines.push(
        `| \`${m.id}\` | ${m.provider} | $${m.inputPer1M.toFixed(2)} | $${m.outputPer1M.toFixed(2)} | ${m.contextWindow} | ${m.notes} |`,
      );
    }
    lines.push("");
  }

  // Usage examples
  lines.push("## Usage in Code");
  lines.push("");
  for (const a of availability.filter((x) => x.available)) {
    const p = a.provider;
    const example = availableModels.find((m) => m.provider === p.name);
    if (example) {
      lines.push(
        `\`\`\`typescript\nimport { ${p.factoryName} } from '${p.importPath}';\nconst model = ${p.factoryName}('${example.id}');\n\`\`\``,
      );
      lines.push("");
    }
  }

  // Cross-provider caching note
  lines.push("## Caching Notes");
  lines.push("");
  lines.push(
    "- **Anthropic**: Requires explicit `cacheControl` breakpoints via `providerOptions`. 90% savings.",
  );
  lines.push(
    "- **OpenAI**: Automatic caching for prompts ≥1024 tokens. No setup needed. 50-90% savings.",
  );
  lines.push(
    "- **Google**: Implicit automatic caching. No setup needed. 75% savings.",
  );
  lines.push(
    "- When routing to non-Anthropic models, existing Anthropic cache markers are safely ignored.",
  );
  lines.push("");

  return lines.join("\n");
}

// ── Public API ──────────────────────────────────────────────────────

export interface ModelRegistryResult {
  /** Absolute path to the written available-models.md file. */
  filePath: string;
  /** Which providers are available. */
  availability: ProviderAvailability[];
  /** Count of available models. */
  modelCount: number;
}

/**
 * Generate and write `available-models.md` for the iteration agent.
 *
 * @param targetDir — the target agent directory (to check node_modules)
 * @param outputDir — where to write the file (e.g., .autoperf/ or runs/)
 */
export async function generateModelRegistry(
  targetDir: string,
  outputDir: string,
): Promise<ModelRegistryResult> {
  const availability = checkProviderAvailability(targetDir);
  const markdown = generateAvailableModelsMarkdown(availability);

  await mkdir(outputDir, { recursive: true });
  const filePath = resolve(outputDir, "available-models.md");
  await writeFile(filePath, markdown, "utf-8");

  const availableProviders = new Set(
    availability.filter((a) => a.available).map((a) => a.provider.name),
  );
  const modelCount = MODEL_CATALOG.filter((m) =>
    availableProviders.has(m.provider),
  ).length;

  console.error(
    `[autoperf] Model registry: ${modelCount} models across ${availableProviders.size} providers → ${filePath}`,
  );

  return { filePath, availability, modelCount };
}
