import type { PortMapping, PortAllocation } from "./types.js";

const BASE_OFFSET = 20000;
/**
 * Each worktree gets a dedicated band of 1000 ports so that services
 * within a worktree can never collide with services in another worktree,
 * regardless of how close their default ports are.
 *
 * Formula: BASE_OFFSET + (worktreeIndex * BLOCK_SIZE) + (defaultPort % BLOCK_SIZE)
 *
 * Example with api:3000, stats:3001, pg:5432, frontend:8080 at index 2:
 *   api:       20000 + 2000 + 0   = 22000
 *   stats:     20000 + 2000 + 1   = 22001
 *   pg:        20000 + 2000 + 432 = 22432
 *   frontend:  20000 + 2000 + 80  = 22080
 */
const BLOCK_SIZE = 1000;

export function allocatePort(
  defaultPort: number,
  worktreeIndex: number,
): number {
  let port =
    BASE_OFFSET + worktreeIndex * BLOCK_SIZE + (defaultPort % BLOCK_SIZE);

  if (port > 65535) {
    port = defaultPort + 100 * worktreeIndex;
  }

  if (port > 65535 || port < 1024) {
    throw new Error(
      `Cannot allocate port for default ${defaultPort} at worktree index ${worktreeIndex}. ` +
        `Computed port ${port} is out of valid range (1024-65535).`,
    );
  }

  return port;
}

export function allocateWorktreePorts(
  mappings: PortMapping[],
  worktreeIndex: number,
): PortAllocation[] {
  const overridable = mappings.filter((m) => m.envVar !== null);

  const used = new Set<number>();
  const allocations: PortAllocation[] = [];

  for (const m of overridable) {
    let port = allocatePort(m.defaultPort, worktreeIndex);

    // Resolve collisions by bumping to the next available port in the block
    while (used.has(port)) {
      port++;
    }

    if (port > 65535 || port < 1024) {
      throw new Error(
        `Cannot allocate port for service "${m.serviceName}" at worktree index ${worktreeIndex}. ` +
          `Computed port ${port} is out of valid range (1024-65535).`,
      );
    }

    used.add(port);
    allocations.push({
      serviceName: m.serviceName,
      envVar: m.envVar!,
      port,
      containerPort: m.containerPort,
    });
  }

  return allocations;
}
