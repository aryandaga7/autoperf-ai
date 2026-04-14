import { rmSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { getAutoperfPaths } from "./autoperf-dir.js";

/**
 * Clean stale optimization state from a prior run.
 * Must be called BEFORE the orchestrator starts a new optimization run.
 *
 * Deletes:
 * - .autoperf/{target}/optimization.md — stale state file
 * - .autoperf/{target}/iteration-reasoning/*.md — stale reasoning docs
 *
 * Accepts either:
 *   cleanRunState(repoRoot, targetName) — new style
 *   cleanRunState(targetDir)            — legacy: targetDir is used as both
 *                                         the target dir AND to derive name
 *
 * Git history preserves all prior run artifacts — no separate archival needed.
 */
export function cleanRunState(
  repoRootOrTargetDir: string,
  targetName?: string,
): { cleaned: string[] } {
  const cleaned: string[] = [];

  const repoRoot = repoRootOrTargetDir;
  const name = targetName ?? basename(repoRootOrTargetDir);
  const paths = getAutoperfPaths(repoRoot, name);

  // Remove stale optimization state file
  if (existsSync(paths.optimizationMd)) {
    rmSync(paths.optimizationMd);
    cleaned.push(paths.optimizationMd);
  }

  // Remove stale reasoning docs (keep the directory itself)
  if (existsSync(paths.reasoning)) {
    for (const file of readdirSync(paths.reasoning)) {
      if (file.endsWith(".md")) {
        const filePath = join(paths.reasoning, file);
        unlinkSync(filePath);
        cleaned.push(filePath);
      }
    }
  }

  if (cleaned.length > 0) {
    console.error(
      `[autoperf] cleanRunState: removed ${cleaned.length} stale file(s) from .autoperf/${name}/`,
    );
  }

  return { cleaned };
}
