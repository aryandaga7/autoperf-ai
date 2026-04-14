import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";

// Track temp MCP config files for cleanup on process exit.
const tempFilesToCleanup: string[] = [];
let exitHandlerRegistered = false;

function registerExitCleanup(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on("exit", () => {
    for (const dir of tempFilesToCleanup) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup — process is exiting.
      }
    }
  });
}

type McpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> };

// ── Iteration Agent MCP Config ─────────────────────────────────────
// Research tools for the iteration agent. Gated on API keys in .env.
// Both Context7 and Nia are optional — if neither key is present,
// the agent relies on bundled meta-knowledge for research.

/**
 * Build the MCP config for iteration agent subprocesses.
 * Includes Context7 (if CONTEXT7_API_KEY set) and Nia (if NIA_API_KEY set).
 * Returns null when no research tools are available.
 */
export function buildIterationAgentMcpConfig(): {
  mcpServers: Record<string, McpServerConfig>;
} | null {
  const servers: Record<string, McpServerConfig> = {};

  const ctx7Key = process.env.CONTEXT7_API_KEY;
  if (ctx7Key) {
    servers.context7 = {
      type: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: ctx7Key },
    };
  }

  const niaKey = process.env.NIA_API_KEY;
  if (niaKey) {
    servers.nia = {
      type: "http",
      url: "https://apigcp.trynia.ai/mcp",
      headers: {
        Authorization: `Bearer ${niaKey}`,
      },
    };
  }

  if (Object.keys(servers).length === 0) return null;
  return { mcpServers: servers };
}

/**
 * Write the iteration agent MCP config to a temp file and return the path.
 * Returns null if no research tools are available (no keys set).
 * Call once at startup, reuse the returned path for all subprocess invocations.
 */
export function writeIterationAgentMcpConfig(): string | null {
  const config = buildIterationAgentMcpConfig();
  if (!config) return null;

  const dir = mkdtempSync(join(tmpdir(), "autoperf-mcp-"));
  const filePath = join(dir, "mcp-iteration-agent.json");
  writeFileSync(filePath, JSON.stringify(config, null, 2));

  // Schedule cleanup of the temp directory (contains API keys) on process exit.
  tempFilesToCleanup.push(dir);
  registerExitCleanup();

  return filePath;
}

// ── Orchestrator MCP Config ────────────────────────────────────────
// The orchestrator CC connects ONLY to the autoperf MCP server
// (runEval, compareResults, spawnOptimizer, acceptIteration, rejectIteration).
// Used by the optimize command via --mcp-config + --strict-mcp-config.

/**
 * Build the MCP config for the orchestrator CC subprocess.
 * Points to the autoperf MCP server only — no user MCP servers leak in.
 */
export function buildOrchestratorMcpConfig(mcpServerEntrypoint: string): {
  mcpServers: Record<string, McpServerConfig>;
} {
  return {
    mcpServers: {
      autoperf: {
        type: "stdio",
        command: "node",
        args: [mcpServerEntrypoint],
      },
    },
  };
}

// ── Plugin Settings (D9 Isolation) ─────────────────────────────────
// Both CCs need controlled plugin environments. Query `plugin list`
// to discover all installed plugins, then selectively enable/disable.

const ITERATION_AGENT_PLUGIN_WHITELIST = new Set([
  "typescript-lsp@claude-plugins-official",
  "vercel@claude-plugins-official",
]);

/** Known official plugins — fallback when `plugin list` fails. */
const KNOWN_OFFICIAL_PLUGINS = [
  "typescript-lsp@claude-plugins-official",
  "vercel@claude-plugins-official",
  "superpowers@claude-plugins-official",
  "frontend-design@claude-plugins-official",
  "playwright@claude-plugins-official",
  "clangd-lsp@claude-plugins-official",
];

/** Cached plugin list — discovered once per process. */
let cachedPlugins: string[] | null = null;

/**
 * Discover all installed CC plugins by parsing `plugin list` output.
 * Falls back to known official list if the command fails.
 */
export async function discoverInstalledPlugins(): Promise<string[]> {
  if (cachedPlugins) return cachedPlugins;

  try {
    const result = await execa(
      "npx",
      ["@anthropic-ai/claude-code", "plugin", "list"],
      { timeout: 30_000 },
    );
    const names = new Set<string>();
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/❯\s+(\S+@\S+)/);
      if (match) names.add(match[1]);
    }
    cachedPlugins = names.size > 0 ? [...names] : KNOWN_OFFICIAL_PLUGINS;
  } catch {
    cachedPlugins = KNOWN_OFFICIAL_PLUGINS;
  }

  return cachedPlugins;
}

/**
 * Build .claude/settings.json content for the iteration agent worktree.
 * D9: Only typescript-lsp and vercel enabled. Everything else disabled.
 */
export async function buildIterationAgentSettings(): Promise<{
  enabledPlugins: Record<string, boolean>;
}> {
  const allPlugins = await discoverInstalledPlugins();
  const enabledPlugins: Record<string, boolean> = {};
  for (const name of allPlugins) {
    enabledPlugins[name] = ITERATION_AGENT_PLUGIN_WHITELIST.has(name);
  }
  return { enabledPlugins };
}

/**
 * Build .claude/settings.json content for the orchestrator CC.
 * The orchestrator makes decisions — it doesn't write code. No plugins needed.
 * The optimize command consumes this.
 */
export async function buildOrchestratorSettings(): Promise<{
  enabledPlugins: Record<string, boolean>;
}> {
  const allPlugins = await discoverInstalledPlugins();
  const enabledPlugins: Record<string, boolean> = {};
  for (const name of allPlugins) {
    enabledPlugins[name] = false;
  }
  return { enabledPlugins };
}

// ── D10: Available Tools Manifest ──────────────────────────────────
// Tells the prompt generator which research tools are configured.
// Prompts should NOT reference tools that aren't available.

export interface AvailableToolsManifest {
  context7: boolean;
  nia: boolean;
}

/**
 * Report which research MCP tools are available for iteration agents.
 * Based on API key presence in environment.
 */
export function getAvailableToolsManifest(): AvailableToolsManifest {
  return {
    context7: !!process.env.CONTEXT7_API_KEY,
    nia: !!process.env.NIA_API_KEY,
  };
}
