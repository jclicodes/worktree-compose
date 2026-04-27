import { buildContext, filterWorktrees } from "../context.js";
import { composeProjectName } from "../utils/sanitize.js";
import { execLive } from "../utils/exec.js";
import * as log from "../utils/log.js";
import { stopCommand } from "./stop.js";
import { startCommand, type StartOptions } from "./start.js";

export function restartCommand(
  indices: number[],
  services: string[] = [],
  opts: StartOptions = {},
): void {
  if (services.length === 0) {
    // Full restart: stop, re-sync, rebuild, start
    stopCommand(indices);
    startCommand(indices, opts);
    return;
  }

  // Lightweight restart of specific services
  const ctx = buildContext();

  if (ctx.worktrees.length === 0) {
    log.warn("No worktrees to restart.");
    return;
  }

  const targets = filterWorktrees(ctx.worktrees, indices, ctx.stableIndices);
  const serviceList = services.join(" ");
  const needsRecreate = opts.build || opts.forceRecreate;

  for (const wt of targets) {
    const idx = ctx.stableIndices.get(wt.branch)!;
    const project = composeProjectName(ctx.repoName, idx, wt.branch);

    log.info(`Restarting ${serviceList} in ${project}...`);

    try {
      if (needsRecreate) {
        const flagParts: string[] = ["--no-deps"];
        if (opts.build) flagParts.push("--build");
        if (opts.forceRecreate) flagParts.push("--force-recreate");
        const flags = flagParts.join(" ");
        execLive(`docker compose -p "${project}" up -d ${flags} ${serviceList}`, {
          cwd: wt.path,
        });
      } else {
        execLive(`docker compose -p "${project}" restart ${serviceList}`, {
          cwd: wt.path,
        });
      }
      log.success(
        `Restarted ${serviceList} in worktree ${idx} (${wt.branch})`,
      );
    } catch {
      log.warn(
        `Could not restart ${serviceList} in ${project}`,
      );
    }
  }
}
