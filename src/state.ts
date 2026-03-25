import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSafe } from "./utils/exec.js";
import { sanitize } from "./utils/sanitize.js";
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

function getDockerOccupiedIndices(repoName: string): Set<number> {
  const occupied = new Set<number>();
  const prefix = `${repoName}-wt-`;
  const output = execSafe("docker compose ls -q");
  if (!output) return occupied;
  for (const project of output.split("\n")) {
    if (project.startsWith(prefix)) {
      const rest = project.slice(prefix.length);
      const dashIdx = rest.indexOf("-");
      const numStr = dashIdx === -1 ? rest : rest.slice(0, dashIdx);
      const num = Number(numStr);
      if (!isNaN(num)) occupied.add(num);
    }
  }
  return occupied;
}

/**
 * Returns a stable index for each worktree. Indices are persisted so they
 * don't shift when worktrees are added or removed.
 *
 * - Existing worktrees keep their previously assigned index.
 * - New worktrees fill the lowest available gap.
 * - Stale entries (worktrees that no longer exist) are pruned.
 *
 * NOTE: repoRoot must be the canonical (main worktree) root — getRepoRoot()
 * already ensures this via git-common-dir resolution.
 */
export function resolveStableIndices(
  repoRoot: string,
  worktrees: WorktreeInfo[],
): Map<string, number> {
  const global = loadGlobalState();
  const project = global.projects[repoRoot] ?? { indices: {} };
  const activeBranches = new Set(worktrees.map((wt) => wt.branch));

  // Single docker scan: find all indices with running containers for this repo.
  // Used both for pruning (keep stale entries if containers still running) and
  // for assignment (avoid collisions with orphaned containers not in state).
  const repoName = sanitize(path.basename(repoRoot));
  const dockerIndices = getDockerOccupiedIndices(repoName);

  // Prune stale entries only if their containers are not still running
  for (const branch of Object.keys(project.indices)) {
    if (!activeBranches.has(branch) && !dockerIndices.has(project.indices[branch])) {
      delete project.indices[branch];
    }
  }

  // Assign indices to new worktrees, filling gaps left by removed ones
  const usedIndices = new Set([...Object.values(project.indices), ...dockerIndices]);
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
