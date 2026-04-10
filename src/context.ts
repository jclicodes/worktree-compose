import { getRepoRoot, getRepoName, detectComposeFile } from "./compose/detect.js";
import { parseComposeFile } from "./compose/parse.js";
import { extractPortMappings } from "./ports/extract.js";
import { loadConfig } from "./config.js";
import { getNonMainWorktrees } from "./git/worktree.js";
import { resolveStableIndices } from "./state.js";
import type { ComposeFile } from "./compose/types.js";
import type { PortMapping } from "./ports/types.js";
import type { WtcConfig } from "./config.js";
import type { WorktreeInfo } from "./git/worktree.js";

export interface WtcContext {
  repoRoot: string;
  repoName: string;
  /** Compose file from the main worktree root (used as fallback) */
  composeFile: ComposeFile;
  portMappings: PortMapping[];
  config: WtcConfig;
  worktrees: WorktreeInfo[];
  /** Stable index per worktree branch, persisted across runs */
  stableIndices: Map<string, number>;
}

/**
 * Resolve compose file and port mappings for a specific directory.
 * Used to read compose from a worktree's own working tree.
 */
export function resolveCompose(dir: string): { composeFile: ComposeFile; portMappings: PortMapping[] } | null {
  const composePath = detectComposeFile(dir);
  if (!composePath) return null;
  const composeFile = parseComposeFile(composePath);
  const portMappings = extractPortMappings(composeFile.services);
  return { composeFile, portMappings };
}

export function buildContext(): WtcContext {
  const repoRoot = getRepoRoot();
  const repoName = getRepoName(repoRoot);

  const resolved = resolveCompose(repoRoot);
  if (!resolved) {
    throw new Error(
      `No compose file found in ${repoRoot}. Expected one of: compose.yaml, compose.yml, docker-compose.yaml, docker-compose.yml`,
    );
  }

  const { composeFile, portMappings } = resolved;
  const config = loadConfig(repoRoot);
  const worktrees = getNonMainWorktrees(repoRoot);
  const stableIndices = resolveStableIndices(repoRoot, worktrees);

  return { repoRoot, repoName, composeFile, portMappings, config, worktrees, stableIndices };
}

export function filterWorktrees(
  worktrees: WorktreeInfo[],
  indices: number[],
  stableIndices: Map<string, number>,
): WorktreeInfo[] {
  if (indices.length === 0) return worktrees;

  const indexToWorktree = new Map<number, WorktreeInfo>();
  for (const wt of worktrees) {
    const idx = stableIndices.get(wt.branch);
    if (idx !== undefined) indexToWorktree.set(idx, wt);
  }

  return indices.map((i) => {
    const wt = indexToWorktree.get(i);
    if (!wt) throw new Error(`Worktree index ${i} not found. Run 'wtc list' to see available worktrees.`);
    return wt;
  });
}
