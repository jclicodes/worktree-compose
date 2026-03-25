import { buildContext, filterWorktrees } from "../context.js";
import { composeProjectName } from "../utils/sanitize.js";
import { execLive } from "../utils/exec.js";
import * as log from "../utils/log.js";

export function logsCommand(indices: number[], follow: boolean): void {
  const ctx = buildContext();

  if (ctx.worktrees.length === 0) {
    log.warn("No worktrees found.");
    return;
  }

  const targets = filterWorktrees(ctx.worktrees, indices, ctx.stableIndices);

  for (const wt of targets) {
    const idx = ctx.stableIndices.get(wt.branch)!;
    const project = composeProjectName(ctx.repoName, idx, wt.branch);
    const followFlag = follow ? " -f" : "";

    log.header(`Worktree ${idx}: ${wt.branch}`);
    execLive(`docker compose -p "${project}" logs${followFlag}`, {
      cwd: wt.path,
    });
  }
}
