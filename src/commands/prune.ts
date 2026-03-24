import { getRepoRoot, getRepoName } from "../compose/detect.js";
import { getNonMainWorktrees } from "../git/worktree.js";
import { resolveStableIndices } from "../state.js";
import { composeProjectName } from "../utils/sanitize.js";
import { exec, execSafe } from "../utils/exec.js";
import * as log from "../utils/log.js";

/**
 * Get the set of branch names that have been merged into main,
 * by checking which local branches are fully merged.
 */
function getMergedBranches(repoRoot: string, mainBranch: string): Set<string> {
  const output = execSafe(
    `git -C "${repoRoot}" branch --merged ${mainBranch} --format="%(refname:short)"`,
  );
  if (!output) return new Set();

  return new Set(
    output
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b && b !== mainBranch),
  );
}

/**
 * Detect the main branch name (main or master).
 */
function getMainBranch(repoRoot: string): string {
  const branch = execSafe(
    `git -C "${repoRoot}" rev-parse --abbrev-ref HEAD`,
  );
  // If we're on main/master, use that. Otherwise check which exists.
  if (branch === "main" || branch === "master") return branch;

  const hasMain = execSafe(`git -C "${repoRoot}" rev-parse --verify main`);
  if (hasMain) return "main";

  const hasMaster = execSafe(`git -C "${repoRoot}" rev-parse --verify master`);
  if (hasMaster) return "master";

  return "main";
}

export function pruneCommand(): void {
  const repoRoot = getRepoRoot();
  const repoName = getRepoName(repoRoot);
  const mainBranch = getMainBranch(repoRoot);

  // Step 1: Pull latest main
  log.info(`Fetching and pulling ${mainBranch}...`);
  execSafe(`git -C "${repoRoot}" fetch origin ${mainBranch}`);
  const currentBranch = execSafe(
    `git -C "${repoRoot}" rev-parse --abbrev-ref HEAD`,
  );

  if (currentBranch === mainBranch) {
    execSafe(`git -C "${repoRoot}" pull --ff-only origin ${mainBranch}`);
  } else {
    // Update main ref without checking it out
    execSafe(
      `git -C "${repoRoot}" fetch origin ${mainBranch}:${mainBranch}`,
    );
  }

  // Step 2: Find merged branches
  const mergedBranches = getMergedBranches(repoRoot, mainBranch);
  if (mergedBranches.size === 0) {
    log.info("No merged branches found.");
    return;
  }

  // Step 3: Cross-reference with active worktrees
  const worktrees = getNonMainWorktrees(repoRoot);
  const stableIndices = resolveStableIndices(repoRoot, worktrees);
  const mergedWorktrees = worktrees.filter((wt) =>
    mergedBranches.has(wt.branch),
  );

  if (mergedWorktrees.length === 0) {
    log.info(
      `Found ${mergedBranches.size} merged branch(es), but none have active worktrees.`,
    );
    return;
  }

  const currentWt = execSafe("git rev-parse --show-toplevel") ?? repoRoot;

  log.info(
    `Found ${mergedWorktrees.length} worktree(s) with merged branches:`,
  );
  for (const wt of mergedWorktrees) {
    const idx = stableIndices.get(wt.branch)!;
    console.log(`  ${idx}. ${wt.branch} → ${wt.path}`);
  }
  console.log();

  // Step 4: Stop containers and remove worktrees
  for (const wt of mergedWorktrees) {
    const idx = stableIndices.get(wt.branch)!;
    const project = composeProjectName(repoName, idx, wt.branch);

    log.info(`Stopping containers for ${wt.branch}...`);
    try {
      exec(`docker compose -p "${project}" down`, { cwd: wt.path });
    } catch {
      // already stopped
    }

    if (wt.path === currentWt) {
      log.warn(
        `Skipping removal of current worktree (${wt.branch}). cd out and run again to remove it.`,
      );
      continue;
    }

    log.info(`Removing worktree: ${wt.path}`);
    try {
      exec(`git -C "${repoRoot}" worktree remove "${wt.path}" --force`);
    } catch {
      log.warn(`Could not remove ${wt.path}`);
    }
  }

  // Step 5: Prune git worktree state
  execSafe(`git -C "${repoRoot}" worktree prune`);

  log.success(
    `Pruned ${mergedWorktrees.length} merged worktree(s). Branches were kept.`,
  );
}
