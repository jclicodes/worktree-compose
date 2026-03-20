import fs from "node:fs";
import path from "node:path";
import type { WorktreeInfo } from "./git/worktree.js";

interface WtcState {
  /** Maps worktree branch name → stable index */
  indices: Record<string, number>;
}

const STATE_FILE = ".wtc-state.json";

function statePath(repoRoot: string): string {
  return path.join(repoRoot, STATE_FILE);
}

function loadState(repoRoot: string): WtcState {
  const p = statePath(repoRoot);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as WtcState;
  }
  return { indices: {} };
}

function saveState(repoRoot: string, state: WtcState): void {
  fs.writeFileSync(statePath(repoRoot), JSON.stringify(state, null, 2) + "\n");
}

/**
 * Returns a stable index for each worktree. Indices are persisted so they
 * don't shift when worktrees are added or removed.
 *
 * - Existing worktrees keep their previously assigned index.
 * - New worktrees get the next available index (max + 1).
 * - Stale entries (worktrees that no longer exist) are pruned.
 */
export function resolveStableIndices(
  repoRoot: string,
  worktrees: WorktreeInfo[],
): Map<string, number> {
  const state = loadState(repoRoot);
  const activeBranches = new Set(worktrees.map((wt) => wt.branch));

  // Prune entries for worktrees that no longer exist
  for (const branch of Object.keys(state.indices)) {
    if (!activeBranches.has(branch)) {
      delete state.indices[branch];
    }
  }

  // Assign indices to new worktrees, filling gaps left by removed ones
  const usedIndices = new Set(Object.values(state.indices));
  for (const wt of worktrees) {
    if (!(wt.branch in state.indices)) {
      let idx = 1;
      while (usedIndices.has(idx)) idx++;
      state.indices[wt.branch] = idx;
      usedIndices.add(idx);
    }
  }

  saveState(repoRoot, state);

  return new Map(
    worktrees.map((wt) => [wt.branch, state.indices[wt.branch]]),
  );
}
