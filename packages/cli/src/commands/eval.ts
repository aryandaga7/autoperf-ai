import type { Command } from "commander";
import { resolve, isAbsolute, join, basename } from "node:path";
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { config } from "dotenv";

import { runEval } from "../eval/run-eval.js";
import { generateProfile } from "../eval/profile-generator.js";
import { resolveJudgeModel } from "../eval/provider-detect.js";
import type { EvalQuery, EvalRunResult, JudgeConfig } from "../eval/types.js";
import { ensureAutoperfDir, getAutoperfPaths } from "../infra/autoperf-dir.js";
import { generateReport } from "../report/generate-report.js";

// ── Formatting helpers ──────────────────────────────────────────────────────

function fmtCost(n: number): string {
  if (n < 0.0001) return `$${n.toFixed(6)}`;
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

// ── Output rendering ────────────────────────────────────────────────────────

function printResultsTable(result: EvalRunResult): void {
  const colWidths = {
    num: 4,
    query: 42,
    quality: 10,
    cost: 12,
    tokens: 10,
    latency: 10,
    steps: 5,
  };
  const totalWidth = Object.values(colWidths).reduce((a, b) => a + b, 0) + 6; // 6 for spacing

  console.log("\nPer-Query Results");
  console.log("\u2500".repeat(totalWidth));
  console.log(
    padRight("#", colWidths.num) +
      padRight("Query", colWidths.query) +
      padRight("Quality", colWidths.quality) +
      padRight("Cost", colWidths.cost) +
      padRight("Tokens", colWidths.tokens) +
      padRight("Latency", colWidths.latency) +
      padRight("Steps", colWidths.steps),
  );
  console.log("\u2500".repeat(totalWidth));

  for (let i = 0; i < result.queries.length; i++) {
    const q = result.queries[i];
    const num = String(i + 1);
    const queryText = truncate(q.query, colWidths.query - 2);
    const quality = q.error ? "ERR" : `${q.quality.overall.toFixed(1)}/5`;
    const cost = fmtCost(q.cost);
    const tokens = fmtTokens(q.totalTokens);
    const latency = fmtLatency(q.totalLatencyMs);
    const steps = String(q.steps.length);

    console.log(
      padRight(num, colWidths.num) +
        padRight(queryText, colWidths.query) +
        padRight(quality, colWidths.quality) +
        padRight(cost, colWidths.cost) +
        padRight(tokens, colWidths.tokens) +
        padRight(latency, colWidths.latency) +
        padRight(steps, colWidths.steps),
    );
  }
}

function printAggregateSummary(result: EvalRunResult): void {
  const { aggregate, queries } = result;
  const successful = queries.filter((q) => !q.error);

  console.log("\nAggregate Summary");
  console.log("\u2500".repeat(40));
  console.log(`  Total cost:     ${fmtCost(aggregate.totalCost)}`);
  console.log(`  Avg cost/query: ${fmtCost(aggregate.avgCost)}`);
  console.log(`  Avg quality:    ${aggregate.avgQuality.toFixed(2)}/5`);
  console.log(`  Avg latency:    ${fmtLatency(aggregate.avgLatencyMs)}`);
  console.log(`  Total tokens:   ${fmtTokens(aggregate.totalTokens)}`);
  console.log(
    `  Queries:        ${successful.length}/${queries.length} successful`,
  );
}

// ── Command registration ────────────────────────────────────────────────────

export function registerEvalCommand(program: Command): void {
  program
    .command("eval")
    .description("Run evaluation against an AI agent")
    .requiredOption(
      "--target <path>",
      "Path to agent directory containing agent.ts",
    )
    .requiredOption("--queries <path>", "Path to queries JSON file")
    .option("--concurrency <n>", "Number of concurrent eval runs", "3")
    .option("--runs-per-query <n>", "Number of runs per query", "1")
    .option(
      "--judge-model <model>",
      "Judge model ID (default: claude-sonnet-4-6). Requires the provider's API key.",
    )
    .option("--no-report", "Skip HTML report generation")
    .addHelpText(
      "after",
      `
Examples:
  $ autoperf eval --target ./my-agent --queries ./queries.json
  $ autoperf eval --target ./my-agent --queries ./queries.json --concurrency 5
  $ autoperf eval --target ./my-agent --queries ./queries.json --runs-per-query 3
  $ autoperf eval --target ./my-agent --queries ./queries.json --judge-model gpt-5.4-mini
`,
    )
    .action(async (opts) => {
      try {
        // Register tsx so dynamic import() of .ts agent files works.
        // Must use tsx's own register() which sets up the loader with
        // the correct port/data — Node's built-in register() doesn't work.
        const tsx = await import("tsx/esm/api");
        tsx.register();

        // Load .env from user's cwd
        config();

        // Validate judge model provider is available (API key + SDK)
        try {
          const judgeResult = await resolveJudgeModel(opts.judgeModel);
          console.error(
            `[autoperf] Judge model: ${judgeResult.modelId} (${judgeResult.providerName})`,
          );
        } catch (err) {
          console.error(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }

        // Resolve paths relative to cwd
        const targetPath = isAbsolute(opts.target)
          ? opts.target
          : resolve(process.cwd(), opts.target);
        const queriesPath = isAbsolute(opts.queries)
          ? opts.queries
          : resolve(process.cwd(), opts.queries);

        // Ensure .autoperf/{target}/ directory structure exists
        const autoperfPaths = await ensureAutoperfDir(
          process.cwd(),
          basename(targetPath),
        );

        // Validate target directory has agent.ts
        try {
          await access(join(targetPath, "agent.ts"));
        } catch {
          console.error(`Error: ${targetPath}/agent.ts not found.`);
          console.error(
            "The target directory must contain an agent.ts that exports createAgent().",
          );
          process.exit(1);
        }

        // Validate queries file exists
        try {
          await access(queriesPath);
        } catch {
          console.error(`Error: Queries file not found: ${queriesPath}`);
          process.exit(1);
        }

        // Load queries — support both bare array and wrapped {queries: [...]} format
        const raw = await readFile(queriesPath, "utf-8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          console.error(
            `Error: Failed to parse ${queriesPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
        const queries: EvalQuery[] = Array.isArray(parsed)
          ? parsed
          : ((parsed as Record<string, unknown>).queries as EvalQuery[]);

        if (!Array.isArray(queries) || queries.length === 0) {
          console.error(
            "Error: Queries file must contain a non-empty array of queries.\n" +
              'Expected format: [{"query": "...", "expectedBehavior": "..."}]\n' +
              'Or: {"queries": [{"query": "...", "expectedBehavior": "..."}]}',
          );
          process.exit(1);
        }

        const concurrency = parseInt(opts.concurrency, 10);
        const runsPerQuery = parseInt(opts.runsPerQuery, 10);

        if (isNaN(concurrency) || concurrency < 1) {
          console.error("Error: --concurrency must be a positive integer.");
          process.exit(1);
        }
        if (isNaN(runsPerQuery) || runsPerQuery < 1) {
          console.error("Error: --runs-per-query must be a positive integer.");
          process.exit(1);
        }

        // Build judge config
        const judgeConfig: JudgeConfig = {
          rubricType: "generic",
          ...(opts.judgeModel ? { judgeModel: opts.judgeModel } : {}),
        };

        // Print run configuration
        console.log("\nAutoPerf Eval");
        console.log("\u2500".repeat(65));
        console.log(`Target:      ${targetPath}`);
        console.log(`Queries:     ${queries.length}`);
        console.log(`Concurrency: ${concurrency}`);
        console.log(`Runs/query:  ${runsPerQuery}`);
        console.log(
          `Judge:       ${opts.judgeModel ?? "claude-sonnet-4-6 (default)"}`,
        );
        console.log();

        // Graceful SIGINT — let in-flight queries finish, then exit
        let interrupted = false;
        const onSigint = () => {
          if (interrupted) {
            console.error("\nForce quit.");
            process.exit(130);
          }
          interrupted = true;
          console.error(
            "\nInterrupted. Waiting for in-flight queries to finish...",
          );
        };
        process.on("SIGINT", onSigint);

        try {
          // Run eval (core pipeline — no MCP layer)
          const result = await runEval(
            targetPath,
            queries,
            { concurrency, runsPerQuery },
            judgeConfig,
          );

          // Print results
          printResultsTable(result);
          printAggregateSummary(result);

          // Write profile and details to .autoperf/{target}/profiles/
          const profileDir = autoperfPaths.profiles;
          await mkdir(profileDir, { recursive: true });
          const safeTimestamp = result.timestamp.replace(/[:.]/g, "-");

          const profile = generateProfile(result);
          const profilePath = join(profileDir, `eval-${safeTimestamp}.md`);
          await writeFile(profilePath, profile, "utf-8");

          const detailsPath = join(
            profileDir,
            `eval-${safeTimestamp}-details.json`,
          );
          await writeFile(
            detailsPath,
            JSON.stringify(result, null, 2),
            "utf-8",
          );

          console.log(`\nProfile: ${profilePath}`);
          console.log(`Details: ${detailsPath}`);

          // Generate HTML report
          if (opts.report !== false) {
            try {
              const reportPath = await generateReport(
                autoperfPaths.root,
                "eval",
              );
              console.log(`Report:  ${reportPath}`);
            } catch (reportErr) {
              console.error(
                `[autoperf] Warning: report generation failed: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`,
              );
            }
          }
        } finally {
          process.removeListener("SIGINT", onSigint);
        }

        if (interrupted) {
          process.exit(130);
        }
      } catch (err) {
        console.error(
          `\nEval failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (err instanceof Error && err.stack) {
          console.error(err.stack);
        }
        process.exit(1);
      }
    });
}
