import fs from "node:fs";
import path from "node:path";
import { exec } from "../utils/exec.js";

const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

/** Resolves to the main worktree root via git-common-dir, not the current worktree. */
export function getRepoRoot(cwd?: string): string {
  const effectiveCwd = cwd ?? process.cwd();
  const commonDir = exec("git rev-parse --git-common-dir", { cwd: effectiveCwd });
  return path.dirname(path.resolve(effectiveCwd, commonDir));
}

export function getRepoName(repoRoot: string): string {
  return path.basename(repoRoot);
}

export function detectComposeFile(repoRoot: string): string | null {
  for (const name of COMPOSE_FILENAMES) {
    const full = path.join(repoRoot, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}
