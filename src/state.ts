import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorktreeInfo } from "./git/worktree.js";

interface ProjectState {
  /** Maps worktree branch name → stable index */
  indices: Record<string, number>;
}

interface GlobalState {
  /** Maps repo root path → project state */
  projects: Record<string, ProjectState>;
}

function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return path.join(xdg, "wtc");

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "wtc", "state");
  }

  return path.join(os.homedir(), ".local", "state", "wtc");
}

function stateFilePath(): string {
  return path.join(stateDir(), "state.json");
}

function loadGlobalState(): GlobalState {
  const p = stateFilePath();
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as GlobalState;
  }
  return { projects: {} };
}

function saveGlobalState(state: GlobalState): void {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2) + "\n");
}

/**
 * Returns a stable index for each worktree. Indices are persisted so they
 * don't shift when worktrees are added or removed.
 *
 * - Existing worktrees keep their previously assigned index.
 * - New worktrees fill the lowest available gap.
 * - Stale entries (worktrees that no longer exist) are pruned.
 */
export function resolveStableIndices(
  repoRoot: string,
  worktrees: WorktreeInfo[],
): Map<string, number> {
  const global = loadGlobalState();
  const project = global.projects[repoRoot] ?? { indices: {} };
  const activeBranches = new Set(worktrees.map((wt) => wt.branch));

  // Prune entries for worktrees that no longer exist
  for (const branch of Object.keys(project.indices)) {
    if (!activeBranches.has(branch)) {
      delete project.indices[branch];
    }
  }

  // Assign indices to new worktrees, filling gaps left by removed ones
  const usedIndices = new Set(Object.values(project.indices));
  for (const wt of worktrees) {
    if (!(wt.branch in project.indices)) {
      let idx = 1;
      while (usedIndices.has(idx)) idx++;
      project.indices[wt.branch] = idx;
      usedIndices.add(idx);
    }
  }

  global.projects[repoRoot] = project;
  saveGlobalState(global);

  return new Map(
    worktrees.map((wt) => [wt.branch, project.indices[wt.branch]]),
  );
}
