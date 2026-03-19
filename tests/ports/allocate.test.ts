import {
  allocatePort,
  allocateWorktreePorts,
} from "../../src/ports/allocate.js";
import type { PortMapping } from "../../src/ports/types.js";

describe("allocatePort", () => {
  it("computes BASE + (index * 1000) + (default % 1000)", () => {
    // 20000 + 1*1000 + (8000 % 1000) = 21000
    expect(allocatePort(8000, 1)).toBe(21000);
    // 20000 + 2*1000 + (5173 % 1000) = 22173
    expect(allocatePort(5173, 2)).toBe(22173);
    // 20000 + 1*1000 + (5434 % 1000) = 21434
    expect(allocatePort(5434, 1)).toBe(21434);
    // 20000 + 3*1000 + (6380 % 1000) = 23380
    expect(allocatePort(6380, 3)).toBe(23380);
  });

  it("never collides for adjacent default ports across worktrees", () => {
    // This was the original bug: api:3000 in wt2 collided with stats:3001 in wt1
    const apiWt1 = allocatePort(3000, 1);
    const apiWt2 = allocatePort(3000, 2);
    const statsWt1 = allocatePort(3001, 1);
    const statsWt2 = allocatePort(3001, 2);

    const all = [apiWt1, apiWt2, statsWt1, statsWt2];
    expect(new Set(all).size).toBe(4); // all unique
  });

  it("falls back for high default ports", () => {
    // 20000 + 46*1000 + 0 = 66000 > 65535, so fallback: 50000 + 100*1 = 50100
    expect(allocatePort(50000, 46)).toBe(54600);
  });

  it("throws for impossible ports", () => {
    expect(() => allocatePort(60000, 100)).toThrow(/out of valid range/);
  });
});

describe("allocateWorktreePorts", () => {
  const mappings: PortMapping[] = [
    {
      serviceName: "postgres",
      envVar: "POSTGRES_PORT",
      defaultPort: 5434,
      containerPort: 5432,
      raw: "${POSTGRES_PORT:-5434}:5432",
    },
    {
      serviceName: "backend",
      envVar: "BACKEND_PORT",
      defaultPort: 8000,
      containerPort: 8000,
      raw: "${BACKEND_PORT:-8000}:8000",
    },
    {
      serviceName: "nginx",
      envVar: null,
      defaultPort: 8080,
      containerPort: 80,
      raw: "8080:80",
    },
  ];

  it("allocates ports for overridable services only", () => {
    const result = allocateWorktreePorts(mappings, 1);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      serviceName: "postgres",
      envVar: "POSTGRES_PORT",
      port: 21434, // 20000 + 1*1000 + (5434 % 1000)
      containerPort: 5432,
    });
    expect(result[1]).toEqual({
      serviceName: "backend",
      envVar: "BACKEND_PORT",
      port: 21000, // 20000 + 1*1000 + (8000 % 1000)
      containerPort: 8000,
    });
  });

  it("skips raw port mappings (no envVar)", () => {
    const result = allocateWorktreePorts(mappings, 1);
    const names = result.map((a) => a.serviceName);
    expect(names).not.toContain("nginx");
  });

  it("produces different ports for different worktree indices", () => {
    const r1 = allocateWorktreePorts(mappings, 1);
    const r2 = allocateWorktreePorts(mappings, 2);

    expect(r1[0].port).not.toBe(r2[0].port);
    expect(r1[1].port).not.toBe(r2[1].port);
  });
});
