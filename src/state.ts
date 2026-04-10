import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSafe } from "./utils/exec.js";
import * as log from "./utils/log.js";
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

function getDockerOccupiedIndices(repoName: string): Map<number, string> {
  const occupied = new Map<number, string>();
  const prefix = `${repoName}-wt-`;
  const output = execSafe("docker compose ls -q");
  if (!output) return occupied;
  for (const project of output.split("\n")) {
    if (project.startsWith(prefix)) {
      const rest = project.slice(prefix.length);
      const dashIdx = rest.indexOf("-");
      const numStr = dashIdx === -1 ? rest : rest.slice(0, dashIdx);
      const num = Number(numStr);
      if (!isNaN(num)) occupied.set(num, project);
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
  const repoName = sanitize(path.basename(repoRoot));
  const dockerIndices = getDockerOccupiedIndices(repoName);

  // Stop orphaned containers whose worktree no longer exists, then prune
  for (const branch of Object.keys(project.indices)) {
    if (!activeBranches.has(branch)) {
      const idx = project.indices[branch];
      const projectName = dockerIndices.get(idx);
      if (projectName) {
        log.warn(`Stopping orphaned containers for removed worktree "${branch}" (index ${idx})`);
        execSafe(`docker compose -p "${projectName}" down`);
        dockerIndices.delete(idx);
      }
      delete project.indices[branch];
    }
  }

  // Stop docker projects at indices not claimed by any active worktree or state entry
  const claimedIndices = new Set(Object.values(project.indices));
  for (const [idx, projectName] of dockerIndices) {
    if (!claimedIndices.has(idx)) {
      log.warn(`Stopping orphaned docker project "${projectName}" at unclaimed index ${idx}`);
      execSafe(`docker compose -p "${projectName}" down`);
      dockerIndices.delete(idx);
    }
  }

  // Assign indices to new worktrees, filling gaps left by removed ones
  const usedIndices = new Set([...Object.values(project.indices), ...dockerIndices.keys()]);
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

/**
 * Remove a branch's index from persistent state so its ports can be reused.
 */
export function removeIndex(repoRoot: string, branch: string): void {
  const global = loadGlobalState();
  const project = global.projects[repoRoot];
  if (!project) return;

  delete project.indices[branch];
  saveGlobalState(global);
}
