import { getRepoRoot, getRepoName } from "../compose/detect.js";
import { getNonMainWorktrees, getWorktreeByIndex } from "../git/worktree.js";
import { resolveStableIndices, removeIndex } from "../state.js";
import { composeProjectName } from "../utils/sanitize.js";
import { exec, execSafe } from "../utils/exec.js";
import * as log from "../utils/log.js";

export function deleteCommand(indices: number[]): void {
  const repoRoot = getRepoRoot();
  const repoName = getRepoName(repoRoot);
  const worktrees = getNonMainWorktrees(repoRoot);
  const stableIndices = resolveStableIndices(repoRoot, worktrees);

  if (indices.length === 0) {
    log.error("Specify at least one worktree index to delete.");
    process.exit(1);
  }

  const currentWt = execSafe("git rev-parse --show-toplevel") ?? repoRoot;

  for (const idx of indices) {
    const wt = getWorktreeByIndex(repoRoot, idx, stableIndices);
    if (!wt) {
      log.warn(`No worktree found at index ${idx}, skipping.`);
      continue;
    }

    const project = composeProjectName(repoName, idx, wt.branch);

    // Stop containers
    log.info(`Stopping containers for ${wt.branch}...`);
    try {
      exec(`docker compose -p "${project}" down -v`, { cwd: wt.path });
    } catch {
      // already stopped, try without cwd in case worktree path is stale
      execSafe(`docker compose -p "${project}" down -v`);
    }

    // Clean up any stale docker resources for this specific worktree
    const staleContainers = execSafe(
      `docker ps -aq --filter "label=com.docker.compose.project=${project}"`,
    );
    if (staleContainers) {
      execSafe(`docker rm -f ${staleContainers}`);
    }

    const staleNetworks = execSafe(
      `docker network ls -q --filter "name=${project}"`,
    );
    if (staleNetworks) {
      execSafe(`docker network rm ${staleNetworks}`);
    }

    // Remove git worktree
    if (wt.path === currentWt) {
      log.warn(
        `Can't remove worktree ${idx} (${wt.branch}) — you're currently in it. cd out first.`,
      );
      continue;
    }

    log.info(`Removing worktree: ${wt.path}`);
    try {
      exec(`git -C "${repoRoot}" worktree remove "${wt.path}" --force`);
    } catch {
      log.warn(`Could not remove ${wt.path}`);
    }

    // Remove the index from persistent state so ports are freed
    removeIndex(repoRoot, wt.branch);

    log.success(`Deleted worktree ${idx} (${wt.branch})`);
  }

  execSafe(`git -C "${repoRoot}" worktree prune`);
}
