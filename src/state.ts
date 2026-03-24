import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "./utils/exec.js";
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
 * Resolve the canonical (main worktree) root for a repo, so that all
 * worktrees share the same state key regardless of which one you're in.
 */
function canonicalRepoRoot(repoRoot: string): string {
  // git-common-dir points to the shared .git dir; for worktrees it's
  // something like /path/to/main/.git/worktrees/<name>, but the common
  // dir itself is /path/to/main/.git — its parent is the main worktree.
  const commonDir = exec("git rev-parse --git-common-dir", { cwd: repoRoot });
  const resolved = path.resolve(repoRoot, commonDir);
  // For the main worktree, commonDir is just ".git", resolved parent is repoRoot.
  // For linked worktrees, commonDir is "/abs/path/to/main/.git", parent is main root.
  return path.dirname(resolved);
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
  const canonical = canonicalRepoRoot(repoRoot);

  // Migrate: if state exists under the old (non-canonical) key, merge it in
  if (repoRoot !== canonical && global.projects[repoRoot]) {
    const old = global.projects[repoRoot];
    const existing = global.projects[canonical] ?? { indices: {} };
    for (const [branch, idx] of Object.entries(old.indices)) {
      if (!(branch in existing.indices)) {
        existing.indices[branch] = idx;
      }
    }
    global.projects[canonical] = existing;
    delete global.projects[repoRoot];
  }

  const project = global.projects[canonical] ?? { indices: {} };
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

  global.projects[canonical] = project;
  saveGlobalState(global);

  return new Map(
    worktrees.map((wt) => [wt.branch, project.indices[wt.branch]]),
  );
}
