import type { Command } from "commander";
import dotenv from "dotenv";
import { execa } from "execa";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PLUGINS = [
  {
    name: "typescript-lsp@claude-plugins-official",
    label: "typescript-lsp",
    description: "TypeScript diagnostics for optimization agents",
  },
  {
    name: "vercel@claude-plugins-official",
    label: "vercel",
    description: "Vercel AI SDK knowledge (25 skills)",
  },
];

interface SetupResult {
  label: string;
  description: string;
  status: "installed" | "skipped" | "failed";
  reason?: string;
}

async function checkClaudeCode(): Promise<string | null> {
  try {
    const { stdout } = await execa("npx", [
      "@anthropic-ai/claude-code",
      "--version",
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function installPlugins(): Promise<SetupResult[]> {
  const results: SetupResult[] = [];

  for (const plugin of PLUGINS) {
    try {
      await execa("npx", [
        "@anthropic-ai/claude-code",
        "plugin",
        "install",
        plugin.name,
        "--scope",
        "project",
      ]);
      results.push({
        label: plugin.label,
        description: plugin.description,
        status: "installed",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({
        label: plugin.label,
        description: plugin.description,
        status: "failed",
        reason: message,
      });
    }
  }

  return results;
}

async function getConfiguredMcpServers(): Promise<Set<string>> {
  try {
    const { stdout } = await execa("npx", [
      "@anthropic-ai/claude-code",
      "mcp",
      "list",
    ]);
    const names = new Set<string>();
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(?:❯\s+)?(\S+?):/);
      if (match) {
        names.add(match[1]);
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

async function configureMcpServers(): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  const existing = await getConfiguredMcpServers();

  // Context7 — free, no key required for basic use
  if (existing.has("context7")) {
    results.push({
      label: "context7",
      description: "Documentation lookup (free)",
      status: "skipped",
      reason: "already configured",
    });
  } else {
    try {
      const args = [
        "@anthropic-ai/claude-code",
        "mcp",
        "add",
        "context7",
        "--scope",
        "project",
      ];

      const context7Key = process.env.CONTEXT7_API_KEY;
      if (context7Key) {
        args.push("-e", `CONTEXT7_API_KEY=${context7Key}`);
      }

      args.push("--", "npx", "-y", "@upstash/context7-mcp");

      await execa("npx", args);
      results.push({
        label: "context7",
        description: "Documentation lookup (free)",
        status: "installed",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({
        label: "context7",
        description: "Documentation lookup (free)",
        status: "failed",
        reason: message,
      });
    }
  }

  // Nia — requires NIA_API_KEY
  const niaKey = process.env.NIA_API_KEY;
  if (existing.has("nia")) {
    results.push({
      label: "nia",
      description: "AI research agent",
      status: "skipped",
      reason: "already configured",
    });
  } else if (!niaKey) {
    results.push({
      label: "nia",
      description: "AI research agent",
      status: "skipped",
      reason: "set NIA_API_KEY to enable",
    });
  } else {
    try {
      const niaConfig = JSON.stringify({
        type: "http",
        url: "https://apigcp.trynia.ai/mcp",
        headers: {
          Authorization: `Bearer ${niaKey}`,
        },
      });
      await execa("npx", [
        "@anthropic-ai/claude-code",
        "mcp",
        "add-json",
        "nia",
        niaConfig,
        "--scope",
        "project",
      ]);
      results.push({
        label: "nia",
        description: "AI research agent",
        status: "installed",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({
        label: "nia",
        description: "AI research agent",
        status: "failed",
        reason: message,
      });
    }
  }

  return results;
}

const NIA_DOCS = [
  {
    url: "https://docs.anthropic.com/en/docs",
    resourceType: "documentation",
    label: "Anthropic API docs",
    query: "anthropic",
    match: "docs.anthropic.com",
  },
  {
    url: "https://platform.openai.com/docs",
    resourceType: "documentation",
    label: "OpenAI API docs",
    query: "openai",
    match: "platform.openai.com",
  },
  {
    url: "https://github.com/vercel/ai",
    resourceType: "repository",
    label: "Vercel AI SDK",
    query: "vercel/ai",
    match: "vercel/ai",
  },
];

async function indexNiaDocs(niaKey: string): Promise<SetupResult[]> {
  const results: SetupResult[] = [];

  let client: Client | null = null;
  try {
    const transport = new StreamableHTTPClientTransport(
      new URL("https://apigcp.trynia.ai/mcp"),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${niaKey}`,
          },
        },
      },
    );

    client = new Client({ name: "autoperf", version: "0.1.0" });
    await client.connect(transport);

    for (const doc of NIA_DOCS) {
      try {
        // Check if already indexed
        const listResult = await client.callTool({
          name: "manage_resource",
          arguments: { action: "list", query: doc.query, view: "compact" },
        });

        const contentArr = listResult.content as Array<{
          type: string;
          text?: string;
        }>;
        const resultText = contentArr
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("");

        if (resultText.includes(doc.match)) {
          results.push({
            label: doc.label,
            description: "already indexed",
            status: "skipped",
            reason: "already indexed",
          });
          continue;
        }

        // Index the doc
        await client.callTool({
          name: "index",
          arguments: {
            url: doc.url,
            resource_type: doc.resourceType,
          },
        });
        results.push({
          label: doc.label,
          description: "indexed",
          status: "installed",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        results.push({
          label: doc.label,
          description: "indexing failed",
          status: "failed",
          reason: message,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.log(`  Warning: Could not connect to Nia (${message})`);
    console.log("  Skipping documentation indexing.");
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore close errors
      }
    }
  }

  return results;
}

function formatResultLine(r: SetupResult, skipIsSuccess = true): string {
  const icon =
    r.status === "failed" ||
    (r.status === "skipped" && !skipIsSuccess && r.reason !== "already indexed")
      ? "x"
      : "+";
  const suffix =
    r.status === "skipped"
      ? ` (${r.reason})`
      : r.status === "failed"
        ? ` (FAILED: ${r.reason})`
        : "";
  return `  [${icon}] ${r.label}  — ${r.description}${suffix}`;
}

function printReport(
  ccVersion: string,
  pluginResults: SetupResult[],
  mcpResults: SetupResult[],
  niaIndexResults: SetupResult[],
): void {
  console.log("");
  console.log("AutoPerf Setup Complete");
  console.log(`Claude Code: v${ccVersion}`);
  console.log("");

  console.log("Plugins:");
  for (const r of pluginResults) {
    console.log(formatResultLine(r));
  }
  console.log("");

  console.log("MCP Research Tools:");
  for (const r of mcpResults) {
    const icon =
      r.status === "failed" ||
      (r.status === "skipped" && r.reason !== "already configured")
        ? "x"
        : "+";
    const suffix =
      r.status === "skipped"
        ? ` (${r.reason})`
        : r.status === "failed"
          ? ` (FAILED: ${r.reason})`
          : "";
    console.log(`  [${icon}] ${r.label}  — ${r.description}${suffix}`);
  }
  console.log("");

  if (niaIndexResults.length > 0) {
    console.log("Nia Indexed Documentation:");
    for (const r of niaIndexResults) {
      console.log(formatResultLine(r));
    }
    console.log("");
  }

  console.log("These tools make the optimization agent more effective.");
  console.log("Without them, the agent still works using bundled knowledge.");
  console.log("");
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Install Claude Code plugins and configure MCP research tools")
    .action(async () => {
      // Load .env so NIA_API_KEY / CONTEXT7_API_KEY are available
      dotenv.config();

      // 1. Check Claude Code is available
      console.log("Checking Claude Code availability...");
      const ccVersion = await checkClaudeCode();
      if (!ccVersion) {
        console.error(
          "Error: Claude Code is not available.\n\n" +
            "Install and authenticate Claude Code first:\n" +
            "  npx @anthropic-ai/claude-code auth login\n\n" +
            "For more info: https://docs.anthropic.com/en/docs/claude-code",
        );
        process.exit(1);
      }
      console.log(`Found Claude Code v${ccVersion}`);
      console.log("");

      // 2. Install plugins (project scope)
      console.log("Installing plugins...");
      const pluginResults = await installPlugins();

      // 3. Configure MCP servers (project scope)
      console.log("Configuring MCP research tools...");
      const mcpResults = await configureMcpServers();

      // 4. Index essential docs into Nia (if NIA_API_KEY is available)
      let niaIndexResults: SetupResult[] = [];
      const niaKey = process.env.NIA_API_KEY;
      if (niaKey) {
        console.log("Indexing documentation into Nia...");
        niaIndexResults = await indexNiaDocs(niaKey);
      }

      // 5. Print report
      printReport(ccVersion, pluginResults, mcpResults, niaIndexResults);

      // Exit with error if any plugin or MCP server failed (indexing failures are warnings)
      const anyFailed = [...pluginResults, ...mcpResults].some(
        (r) => r.status === "failed",
      );
      if (anyFailed) {
        process.exit(1);
      }
    });
}
