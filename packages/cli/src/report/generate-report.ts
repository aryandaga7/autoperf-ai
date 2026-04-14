import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { platform } from "node:os";
import { parseTargetDirectory } from "./parse-target.js";

/** Package root: from dist/report/ → packages/cli/ */
const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Generate a self-contained report.html from .autoperf/{target}/ data.
 *
 * @param targetDir - Absolute path to .autoperf/{target}/ directory
 * @param mode - "optimize" for full report, "eval" for baseline-only
 * @param options - openBrowser: auto-open in browser (default true)
 * @returns Path to the generated report.html
 */
export async function generateReport(
  targetDir: string,
  mode: "optimize" | "eval" = "optimize",
  options: { openBrowser?: boolean } = {},
): Promise<string> {
  const { openBrowser = true } = options;

  // Parse target directory data
  const data = await parseTargetDirectory(targetDir, mode);

  // Read the report template
  const templatePath = resolveTemplate();
  const template = await readFile(templatePath, "utf-8");

  // Inject data into template
  const dataScript = `<script>window.__AUTOPERF_DATA__ = ${JSON.stringify(data)};</script>`;
  const html = template.replace(
    "const DATA = window.__AUTOPERF_DATA__;",
    `</script>${dataScript}<script>const DATA = window.__AUTOPERF_DATA__;`,
  );

  // Write report.html
  const reportPath = join(targetDir, "report.html");
  await writeFile(reportPath, html, "utf-8");

  // Auto-open in browser
  if (openBrowser) {
    openInBrowser(reportPath);
  }

  return reportPath;
}

/**
 * Resolve the report template file path.
 * Checks both the installed package location and the dev source location.
 */
function resolveTemplate(): string {
  // Installed package: dist/report/ → ../../data/
  const installed = resolve(PACKAGE_ROOT, "data/report-template.html");
  if (existsSync(installed)) return installed;

  throw new Error(
    `Report template not found: ${installed}\n` +
      "Ensure the package is properly installed.",
  );
}

/**
 * Open a file in the default browser. Best-effort, never throws.
 */
function openInBrowser(filePath: string): void {
  const os = platform();
  let cmd: string;

  switch (os) {
    case "darwin":
      cmd = `open "${filePath}"`;
      break;
    case "win32":
      cmd = `start "" "${filePath}"`;
      break;
    default:
      // Linux and others
      cmd = `xdg-open "${filePath}"`;
      break;
  }

  exec(cmd, (err) => {
    if (err) {
      // Non-fatal — user can open the file manually
      console.error(`[autoperf] Could not open browser: ${err.message}`);
      console.error(`[autoperf] Open manually: ${filePath}`);
    }
  });
}
