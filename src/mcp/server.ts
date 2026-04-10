import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildContext, filterWorktrees, resolveCompose } from "../context.js";
import { allocateWorktreePorts } from "../ports/allocate.js";
import { composeProjectName } from "../utils/sanitize.js";
import { exec, execSafe } from "../utils/exec.js";
import { syncWorktreeFiles } from "../sync/files.js";
import { copyBaseEnv, injectPortOverrides } from "../sync/env.js";
import { getWorktreeByIndex, getWorktreeBranch } from "../git/worktree.js";
import {
  getChangedFiles,
  getLocalDirtyFiles,
  findConflicts,
  promoteFiles,
} from "../git/promote.js";

function startWorktrees(indices: number[]): string {
  const ctx = buildContext();
  if (ctx.worktrees.length === 0) return "No worktrees found.";

  const targets = filterWorktrees(ctx.worktrees, indices, ctx.stableIndices);
  const results: string[] = [];

  for (const wt of targets) {
    const idx = ctx.stableIndices.get(wt.branch)!;
    const project = composeProjectName(ctx.repoName, idx, wt.branch);
    const wtCompose = resolveCompose(wt.path) ?? { composeFile: ctx.composeFile, portMappings: ctx.portMappings };
    const allocations = allocateWorktreePorts(wtCompose.portMappings, idx);

    syncWorktreeFiles(ctx.repoRoot, wt.path, wtCompose.composeFile, ctx.config.sync);
    copyBaseEnv(ctx.repoRoot, wt.path);
    injectPortOverrides(
      `${wt.path}/.env`,
      allocations,
      ctx.config.envOverrides,
    );

    exec(`docker compose -p "${project}" up -d --build`, { cwd: wt.path });

    const ports = allocations.map((a) => `${a.envVar}=${a.port}`).join(", ");
    results.push(`Worktree ${idx} (${wt.branch}): started [${ports}]`);
  }

  return results.join("\n");
}

function stopWorktrees(indices: number[]): string {
  const ctx = buildContext();
  if (ctx.worktrees.length === 0) return "No worktrees found.";

  const targets = filterWorktrees(ctx.worktrees, indices, ctx.stableIndices);
  const results: string[] = [];

  for (const wt of targets) {
    const idx = ctx.stableIndices.get(wt.branch)!;
    const project = composeProjectName(ctx.repoName, idx, wt.branch);

    try {
      exec(`docker compose -p "${project}" down`, { cwd: wt.path });
      results.push(`Worktree ${idx} (${wt.branch}): stopped`);
    } catch {
      results.push(`Worktree ${idx} (${wt.branch}): already stopped`);
    }
  }

  return results.join("\n");
}

function listWorktrees(): object {
  const ctx = buildContext();
  return ctx.worktrees.map((wt) => {
    const idx = ctx.stableIndices.get(wt.branch)!;
    const project = composeProjectName(ctx.repoName, idx, wt.branch);
    const wtCompose = resolveCompose(wt.path);
    const mappings = wtCompose?.portMappings ?? ctx.portMappings;
    const allocations = allocateWorktreePorts(mappings, idx);
    const result = execSafe(
      `docker ps -q --filter "label=com.docker.compose.project=${project}"`,
    );
    const up = result !== null && result.length > 0;

    return {
      index: idx,
      branch: wt.branch,
      path: wt.path,
      project,
      status: up ? "up" : "down",
      ports: Object.fromEntries(allocations.map((a) => [a.envVar, a.port])),
    };
  });
}

function promoteWorktree(index: number): string {
  const ctx = buildContext();
  const wt = getWorktreeByIndex(ctx.repoRoot, index, ctx.stableIndices);
  if (!wt) return `Worktree index ${index} not found.`;

  const currentBranch = getWorktreeBranch(ctx.repoRoot);
  const files = getChangedFiles(ctx.repoRoot, wt.path, currentBranch, wt.branch);

  if (files.length === 0) return "No changes to promote.";

  const dirtyFiles = getLocalDirtyFiles(ctx.repoRoot);
  const conflicts = findConflicts(files, dirtyFiles);

  if (conflicts.length > 0) {
    return `Abort: ${conflicts.length} file(s) have uncommitted changes: ${conflicts.join(", ")}`;
  }

  promoteFiles(ctx.repoRoot, wt.path, files);
  return `Promoted ${files.length} file(s) from worktree ${index} (${wt.branch}) into ${currentBranch}:\n${files.join("\n")}`;
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "worktree-compose",
    version: "0.1.0",
  });

  server.tool(
    "wtc_start",
    "Start Docker Compose stacks for worktrees. Syncs files, injects isolated ports, runs docker compose up.",
    { indices: z.array(z.number()).optional().describe("Worktree indices to start. Omit for all.") },
    async ({ indices }) => ({
      content: [{ type: "text", text: startWorktrees(indices ?? []) }],
    }),
  );

  server.tool(
    "wtc_stop",
    "Stop Docker Compose stacks for worktrees.",
    { indices: z.array(z.number()).optional().describe("Worktree indices to stop. Omit for all.") },
    async ({ indices }) => ({
      content: [{ type: "text", text: stopWorktrees(indices ?? []) }],
    }),
  );

  server.tool(
    "wtc_restart",
    "Restart Docker Compose stacks for worktrees. Use after DB migrations, Dockerfile changes, or config updates.",
    { indices: z.array(z.number()).optional().describe("Worktree indices to restart. Omit for all.") },
    async ({ indices }) => {
      stopWorktrees(indices ?? []);
      const result = startWorktrees(indices ?? []);
      return { content: [{ type: "text", text: result }] };
    },
  );

  server.tool(
    "wtc_list",
    "List all worktrees with branch, status, ports, and URLs.",
    {},
    async () => ({
      content: [
        { type: "text", text: JSON.stringify(listWorktrees(), null, 2) },
      ],
    }),
  );

  server.tool(
    "wtc_promote",
    "Copy changed files from a worktree into the current branch as uncommitted changes.",
    { index: z.number().describe("Worktree index to promote.") },
    async ({ index }) => ({
      content: [{ type: "text", text: promoteWorktree(index) }],
    }),
  );

  server.tool(
    "wtc_clean",
    "Stop all worktree containers, remove all worktrees, prune everything.",
    {},
    async () => {
      const { cleanCommand } = await import("../commands/clean.js");
      try {
        cleanCommand();
        return {
          content: [{ type: "text", text: "Cleanup complete." }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "wtc_prune",
    "Pull main, find worktrees whose branches have been merged, stop their containers and remove the worktrees. Keeps branches.",
    {},
    async () => {
      const { pruneCommand } = await import("../commands/prune.js");
      try {
        pruneCommand();
        return {
          content: [{ type: "text", text: "Prune complete." }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Prune failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
