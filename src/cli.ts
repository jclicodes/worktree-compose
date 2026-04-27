#!/usr/bin/env node
import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { listCommand } from "./commands/list.js";
import { promoteCommand } from "./commands/promote.js";
import { cleanCommand } from "./commands/clean.js";
import { pruneCommand } from "./commands/prune.js";
import { deleteCommand } from "./commands/delete.js";
import { logsCommand } from "./commands/logs.js";
import { startMcpServer } from "./mcp/server.js";
import { error } from "./utils/log.js";

const program = new Command();

program
  .name("wtc")
  .description("Zero-config Docker Compose isolation for git worktrees")
  .version("0.1.0");

program
  .command("start")
  .description("Start Docker Compose stacks for worktrees")
  .argument("[indices...]", "Worktree indices to start (omit for all)")
  .option("--build", "Rebuild images before starting (default: only rebuild if context changed)")
  .option(
    "-p, --profile <name>",
    "Compose profile to activate (repeatable; sets COMPOSE_PROFILES)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .action((indices: string[], opts: { build?: boolean; profile: string[] }) => {
    wrap(() =>
      startCommand(indices.map(Number), {
        build: opts.build,
        profiles: opts.profile,
      }),
    );
  });

program
  .command("stop")
  .description("Stop Docker Compose stacks for worktrees")
  .argument("[indices...]", "Worktree indices to stop (omit for all)")
  .action((indices: string[]) => {
    wrap(() => stopCommand(indices.map(Number)));
  });

program
  .command("restart")
  .description("Restart Docker Compose stacks for worktrees")
  .argument("[args...]", "Worktree indices and optional service names to restart")
  .option("--force-recreate", "Force recreate containers even if config hasn't changed")
  .option("--build", "Rebuild images before restarting (default: only rebuild if context changed)")
  .option(
    "-p, --profile <name>",
    "Compose profile to activate on full restart (repeatable)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .action(
    (
      args: string[],
      opts: { forceRecreate?: boolean; build?: boolean; profile: string[] },
    ) => {
      const indices: number[] = [];
      const services: string[] = [];
      for (const arg of args) {
        if (/^\d+$/.test(arg)) {
          indices.push(Number(arg));
        } else {
          services.push(arg);
        }
      }
      wrap(() =>
        restartCommand(indices, services, {
          forceRecreate: opts.forceRecreate,
          build: opts.build,
          profiles: opts.profile,
        }),
      );
    },
  );

program
  .command("list")
  .alias("ls")
  .description("List all worktrees with ports and URLs")
  .action(() => {
    wrap(() => listCommand());
  });

program
  .command("promote")
  .description("Copy changed files from a worktree into the current branch")
  .argument("<index>", "Worktree index to promote")
  .action((index: string) => {
    wrap(() => promoteCommand(Number(index)));
  });

program
  .command("clean")
  .description("Stop all containers, remove all worktrees, prune everything")
  .action(() => {
    wrap(() => cleanCommand());
  });

program
  .command("logs")
  .description("Show Docker Compose logs for worktrees")
  .argument("[indices...]", "Worktree indices to show logs for (omit for all)")
  .option("-f, --follow", "Follow log output")
  .action((indices: string[], opts: { follow?: boolean }) => {
    wrap(() => logsCommand(indices.map(Number), opts.follow ?? false));
  });

program
  .command("delete")
  .alias("rm")
  .description("Delete worktrees by index, stopping containers and freeing ports")
  .argument("<indices...>", "Worktree indices to delete")
  .action((indices: string[]) => {
    wrap(() => deleteCommand(indices.map(Number)));
  });

program
  .command("prune")
  .description("Remove worktrees whose branches have been merged into main")
  .action(() => {
    wrap(() => pruneCommand());
  });

program
  .command("mcp")
  .description("Start the MCP server (stdio transport)")
  .action(() => {
    startMcpServer().catch((err) => {
      error(String(err));
      process.exit(1);
    });
  });

function wrap(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

program.parse();
