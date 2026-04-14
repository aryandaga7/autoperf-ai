import type { Command } from "commander";
import { resolve, isAbsolute, basename } from "node:path";
import { existsSync } from "node:fs";
import { getAutoperfPaths } from "../infra/autoperf-dir.js";
import { generateReport } from "../report/generate-report.js";

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Generate a visual HTML report from existing autoperf data")
    .requiredOption(
      "--target <path>",
      "Path to agent directory (report reads from .autoperf/{target}/)",
    )
    .option("--no-open", "Don't auto-open the report in the browser")
    .action(async (opts) => {
      try {
        const targetPath = isAbsolute(opts.target)
          ? opts.target
          : resolve(process.cwd(), opts.target);
        const label = basename(targetPath);
        const repoRoot = process.cwd();
        const paths = getAutoperfPaths(repoRoot, label);

        if (!existsSync(paths.root)) {
          console.error(
            `Error: No autoperf data found at ${paths.root}\n` +
              `Run 'autoperf eval --target ${opts.target} --queries <queries.json>' first.`,
          );
          process.exit(1);
        }

        // Detect mode: if optimization.md has iterations, it's an optimize report
        const hasOptimizationMd = existsSync(paths.optimizationMd);
        const mode = hasOptimizationMd ? "optimize" : "eval";

        console.log(`\n[autoperf] Generating ${mode} report...`);

        const reportPath = await generateReport(paths.root, mode, {
          openBrowser: opts.open !== false,
        });

        console.log(`[autoperf] Report: ${reportPath}`);
      } catch (err) {
        console.error(
          `\nReport generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });
}
