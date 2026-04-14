import { join } from "node:path";
import {
  mkdir,
  copyFile,
  readdir,
  readFile,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";

// ── Path constants ─────────────────────────────────────────────────────────

export interface AutoperfPaths {
  /** .autoperf/{target}/ — root for this target's metadata */
  root: string;
  /** .autoperf/{target}/optimization.md */
  optimizationMd: string;
  /** .autoperf/{target}/iteration-reasoning/ */
  reasoning: string;
  /** .autoperf/{target}/profiles/ */
  profiles: string;
  /** .autoperf/{target}/traces/ */
  traces: string;
  /** .autoperf/{target}/autoperf-events.jsonl */
  events: string;
}

/**
 * Pure function — returns the canonical paths for a given repo root + target name.
 * No I/O. Safe to call before ensureAutoperfDir.
 */
export function getAutoperfPaths(
  repoRoot: string,
  targetName: string,
): AutoperfPaths {
  const root = join(repoRoot, ".autoperf", targetName);
  return {
    root,
    optimizationMd: join(root, "optimization.md"),
    reasoning: join(root, "iteration-reasoning"),
    profiles: join(root, "profiles"),
    traces: join(root, "traces"),
    events: join(root, "autoperf-events.jsonl"),
  };
}

/**
 * Ensure the .autoperf/{target}/ directory structure exists.
 *
 * Creates:
 *   .autoperf/{target}/
 *   .autoperf/{target}/iteration-reasoning/
 *   .autoperf/{target}/profiles/
 *   .autoperf/{target}/traces/
 *   .autoperf/.gitignore  (content: "*", self-ignoring safety net)
 *
 * Also appends `.autoperf/` to repo root .gitignore if not already present.
 *
 * Idempotent — safe to call multiple times.
 */
export async function ensureAutoperfDir(
  repoRoot: string,
  targetName: string,
): Promise<AutoperfPaths> {
  const paths = getAutoperfPaths(repoRoot, targetName);

  // Create target subdirectories
  await mkdir(paths.reasoning, { recursive: true });
  await mkdir(paths.profiles, { recursive: true });
  await mkdir(paths.traces, { recursive: true });

  // Write .autoperf/.gitignore (self-ignoring safety net)
  const autoperfGitignore = join(repoRoot, ".autoperf", ".gitignore");
  if (!existsSync(autoperfGitignore)) {
    await writeFile(
      autoperfGitignore,
      "# AutoPerf metadata — managed by autoperf, not committed\n*\n",
      "utf-8",
    );
  }

  // Append .autoperf/ to repo root .gitignore if not present
  const rootGitignore = join(repoRoot, ".gitignore");
  const entry = ".autoperf/";
  let needsAppend = true;
  if (existsSync(rootGitignore)) {
    const content = await readFile(rootGitignore, "utf-8");
    // Check for exact entry or without trailing slash
    if (
      content.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed === entry || trimmed === ".autoperf";
      })
    ) {
      needsAppend = false;
    }
  }
  if (needsAppend) {
    await appendFile(rootGitignore, `\n${entry}\n`, "utf-8");
    console.error(`[autoperf] Added ${entry} to ${rootGitignore}`);
  }

  return paths;
}

/**
 * Copy metadata from .autoperf/{target}/ into a worktree so the iteration
 * agent has access to prior context.
 *
 * Copies:
 *   .autoperf/{target}/optimization.md   → {worktreeTargetPath}/optimization.md
 *   .autoperf/{target}/iteration-reasoning/ → {worktreeTargetPath}/iteration-reasoning/
 *   .autoperf/{target}/profiles/         → {worktreeTargetPath}/profiles/
 *
 * Best-effort — logs warnings, does not throw on failure.
 */
export async function copyMetadataToWorktree(
  repoRoot: string,
  targetName: string,
  worktreeTargetPath: string,
): Promise<void> {
  const paths = getAutoperfPaths(repoRoot, targetName);

  // Copy optimization.md
  if (existsSync(paths.optimizationMd)) {
    try {
      await mkdir(worktreeTargetPath, { recursive: true });
      await copyFile(
        paths.optimizationMd,
        join(worktreeTargetPath, "optimization.md"),
      );
      console.error(`[autoperf] Copied optimization.md to worktree`);
    } catch (err) {
      console.error(
        `[autoperf] Warning: could not copy optimization.md to worktree: ${err}`,
      );
    }
  }

  // Copy iteration-reasoning/ recursively
  if (existsSync(paths.reasoning)) {
    try {
      const destReasoningDir = join(worktreeTargetPath, "iteration-reasoning");
      await mkdir(destReasoningDir, { recursive: true });
      await copyDirContents(paths.reasoning, destReasoningDir);
      console.error(`[autoperf] Copied iteration-reasoning/ to worktree`);
    } catch (err) {
      console.error(
        `[autoperf] Warning: could not copy iteration-reasoning/ to worktree: ${err}`,
      );
    }
  }

  // Copy profiles/ recursively
  if (existsSync(paths.profiles)) {
    try {
      const destProfilesDir = join(worktreeTargetPath, "profiles");
      await mkdir(destProfilesDir, { recursive: true });
      await copyDirContents(paths.profiles, destProfilesDir);
      console.error(`[autoperf] Copied profiles/ to worktree`);
    } catch (err) {
      console.error(
        `[autoperf] Warning: could not copy profiles/ to worktree: ${err}`,
      );
    }
  }
}

/**
 * Recursively copy the contents of srcDir into destDir.
 * Only copies files (not subdirectories) to keep it simple — our metadata
 * directories are flat (no nested subdirs in profiles/ or iteration-reasoning/).
 */
async function copyDirContents(srcDir: string, destDir: string): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      await copyFile(join(srcDir, entry.name), join(destDir, entry.name));
    } else if (entry.isDirectory()) {
      const subDest = join(destDir, entry.name);
      await mkdir(subDest, { recursive: true });
      await copyDirContents(join(srcDir, entry.name), subDest);
    }
  }
}
