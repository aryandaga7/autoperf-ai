import { resolve, join } from "node:path";
import { execa } from "execa";
import { realpath, rm } from "node:fs/promises";

export interface CommitInfo {
  hash: string;
  message: string;
}

// ── Worktree types ──────────────────────────────────────────────────

/** Directory name under repoRoot where worktrees are created. */
const WORKTREE_DIR = ".autoperf/worktrees";

/** Branch namespace for autoperf worktrees. */
const BRANCH_PREFIX = "autoperf/";

export interface WorktreeInfo {
  /** Identifier passed to createWorktree (e.g., "iter-1"). */
  id: string;
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name (e.g., "autoperf/iter-1"). */
  branch: string;
  /** Commit hash the worktree HEAD points to. */
  head: string;
}

export interface WorktreeResult {
  /** Absolute path to the created worktree directory. */
  worktreePath: string;
  /** Branch name created for this worktree. */
  branchName: string;
}

// ── Worktree operations ─────────────────────────────────────────────

/**
 * Create a new worktree for an iteration experiment.
 *
 * Branches from the current HEAD of `mainBranch` (default "main") so the
 * worktree starts with all previously accepted changes. The worktree
 * directory is placed at `{repoRoot}/.autoperf/worktrees/{worktreeId}/`.
 *
 * Uses string `worktreeId` (not just a number) so callers can use
 * "iter-1" for sequential or "explore-cache-A" for future parallel experiments.
 */
export async function createWorktree(
  repoRoot: string,
  worktreeId: string,
  mainBranch = "main",
): Promise<WorktreeResult> {
  const branchName = `${BRANCH_PREFIX}${worktreeId}`;
  const worktreePath = join(repoRoot, WORKTREE_DIR, worktreeId);

  // Create the worktree with a new branch based on main
  await execa(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath, mainBranch],
    { cwd: repoRoot },
  );

  // Resolve symlinks so returned path matches git's internal path
  // (e.g., macOS /var → /private/var)
  const realWorktreePath = await realpath(worktreePath);

  return { worktreePath: realWorktreePath, branchName };
}

/**
 * Merge a worktree's branch into main (accept path).
 *
 * Uses --ff-only because in sequential mode main hasn't advanced since the
 * worktree branched. Failure means main moved unexpectedly — an error the
 * orchestrator should reason about, not silently resolve.
 *
 * After merge: removes the worktree directory but KEEPS the branch for
 * traceability (`git log autoperf/iter-N` shows what was accepted).
 */
export async function mergeWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  mainBranch = "main",
): Promise<void> {
  // Save current branch to restore after merge
  const originalBranch = await getCurrentBranch(repoRoot);

  try {
    // Switch to main, merge, switch back
    await execa("git", ["checkout", mainBranch], { cwd: repoRoot });
    await execa("git", ["merge", "--ff-only", branchName], { cwd: repoRoot });
  } finally {
    // Restore original branch if we were on something other than main
    if (originalBranch && originalBranch !== mainBranch) {
      await execa("git", ["checkout", originalBranch], {
        cwd: repoRoot,
      }).catch(() => {
        // Best-effort restore — if this fails, we're on main which is fine
      });
    }
  }

  // Remove worktree directory (keep branch for traceability)
  await execa("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
  }).catch(async () => {
    // Fallback: manual removal if git worktree remove fails
    await rm(worktreePath, { recursive: true, force: true });
    await execa("git", ["worktree", "prune"], { cwd: repoRoot });
  });
}

/**
 * Remove a worktree directory (reject path or cleanup).
 *
 * Removes the worktree directory but KEEPS the branch so rejected iteration
 * commits remain inspectable via `git log {branchName}` or `git diff`.
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  await execa("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
  }).catch(async () => {
    // Fallback: manual removal if git worktree remove fails
    await rm(worktreePath, { recursive: true, force: true });
    await execa("git", ["worktree", "prune"], { cwd: repoRoot });
  });
}

/**
 * List active autoperf worktrees.
 *
 * Parses `git worktree list --porcelain` and filters to entries under
 * the `.autoperf/worktrees/` directory.
 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const result = await execa("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
  });

  const worktrees: WorktreeInfo[] = [];
  // Resolve symlinks so we match git's real paths
  // (e.g., macOS /var → /private/var)
  let worktreeDir: string;
  try {
    worktreeDir = await realpath(join(repoRoot, WORKTREE_DIR));
  } catch {
    // Directory doesn't exist yet → no worktrees
    return [];
  }

  // Porcelain format: blocks separated by blank lines
  // Each block: "worktree <path>\nHEAD <hash>\nbranch refs/heads/<name>\n"
  const blocks = result.stdout.split("\n\n").filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    const headLine = lines.find((l) => l.startsWith("HEAD "));
    const branchLine = lines.find((l) => l.startsWith("branch "));

    if (!pathLine || !headLine || !branchLine) continue;

    const wtPath = pathLine.slice("worktree ".length);
    const head = headLine.slice("HEAD ".length);
    const fullBranch = branchLine.slice("branch ".length);
    // fullBranch is "refs/heads/autoperf/iter-1" → extract "autoperf/iter-1"
    const branch = fullBranch.replace("refs/heads/", "");

    // Only include worktrees under our managed directory
    if (!wtPath.startsWith(worktreeDir)) continue;
    if (!branch.startsWith(BRANCH_PREFIX)) continue;

    // Extract the id from the branch name
    const id = branch.slice(BRANCH_PREFIX.length);

    worktrees.push({ id, path: wtPath, branch, head });
  }

  return worktrees;
}

/**
 * Clean up orphaned autoperf worktrees (crash recovery).
 *
 * Called at orchestrator startup. Removes worktree directories for any
 * autoperf worktrees that are still on disk (indicates a prior crash).
 * Branches are KEPT for traceability — rejected/crashed iteration commits
 * remain inspectable via `git log autoperf/iter-N`.
 *
 * Returns the IDs of cleaned-up worktrees.
 */
export async function cleanupOrphanedWorktrees(
  repoRoot: string,
): Promise<string[]> {
  const orphans = await listWorktrees(repoRoot);
  const cleanedIds: string[] = [];

  for (const wt of orphans) {
    await removeWorktree(repoRoot, wt.path);
    cleanedIds.push(wt.id);
  }

  return cleanedIds;
}

/** Get the latest commit hash and message. */
export async function getLatestCommit(cwd: string): Promise<CommitInfo> {
  const result = await execa("git", ["log", "-1", "--format=%H%n%s"], { cwd });
  const [hash, message] = result.stdout.split("\n");
  return { hash, message };
}

/** Revert the last commit (keeps it in history via git revert). */
export async function revertLastCommit(cwd: string): Promise<void> {
  await execa("git", ["revert", "HEAD", "--no-edit"], { cwd });
}

/** Check if working directory is clean (no uncommitted changes). */
export async function isWorkingDirClean(cwd: string): Promise<boolean> {
  const result = await execa("git", ["status", "--porcelain"], { cwd });
  return result.stdout.trim() === "";
}

/** Get the current branch name. */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const result = await execa("git", ["branch", "--show-current"], { cwd });
  return result.stdout.trim();
}

/** Get the git repository root directory. */
export async function getRepoRoot(cwd: string): Promise<string> {
  const result = await execa("git", ["rev-parse", "--show-toplevel"], { cwd });
  return result.stdout.trim();
}

/**
 * Get the list of files changed in the last commit (via git diff HEAD~1).
 * When targetDir is provided, only returns files within that directory
 * (relative to the git root). Always excludes build artifacts like .tsbuildinfo.
 */
export async function getChangedFiles(
  cwd: string,
  targetDir?: string,
): Promise<string[]> {
  const result = await execa("git", ["diff", "HEAD~1", "--name-only"], { cwd });
  let files = result.stdout.trim().split("\n").filter(Boolean);

  // Exclude build artifacts
  files = files.filter((f) => !f.endsWith(".tsbuildinfo"));

  // If a target directory is specified, only include files within it
  if (targetDir) {
    // Get the git root so we can compute the relative target prefix
    const rootResult = await execa("git", ["rev-parse", "--show-toplevel"], {
      cwd,
    });
    const gitRoot = rootResult.stdout.trim();
    const resolvedTarget = resolve(targetDir);
    const prefix = resolvedTarget.startsWith(gitRoot)
      ? resolvedTarget.slice(gitRoot.length + 1) + "/"
      : "";
    if (prefix) {
      files = files.filter((f) => f.startsWith(prefix));
    }
  }

  return files;
}

/**
 * Discard all uncommitted changes (tracked modifications + untracked files).
 * Used after CC timeout/error/budget-exhaustion to reset to last committed state.
 * Returns true if changes were discarded, false if working dir was already clean.
 */
export async function cleanWorkingDirectory(cwd: string): Promise<boolean> {
  const clean = await isWorkingDirClean(cwd);
  if (clean) return false;
  await execa("git", ["reset", "HEAD"], { cwd });
  await execa("git", ["checkout", "."], { cwd });
  await execa("git", ["clean", "-fd"], { cwd });
  return true;
}
