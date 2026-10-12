import { describe, expect, it } from "vitest";

import { WorkspaceUsageSchema } from "@agent-runtime/protocol";

import { UsageReporter } from "./reporter.js";
import {
  cpuCores,
  HostUsageSampler,
  parseDockerStats,
  WorkspaceUsageSampler,
  type ContainerStatsSample,
  type UsageSource,
} from "./sampler.js";

const A = "5b0f3a9e-2c4d-4e6f-8a1b-3c5d7e9f1a2b";
const B = "6c1f3a9e-2c4d-4e6f-8a1b-3c5d7e9f1a2b";

/** The Q8B one-shot stats document measured in specs.md Phase 17.1 (trimmed). */
const DOCKER_STATS = {
  read: "2026-10-09T08:00:00Z",
  cpu_stats: { cpu_usage: { total_usage: 12_000_000_000 }, online_cpus: 8 },
  memory_stats: { usage: 170_041_344, limit: 4_294_967_296, stats: { inactive_file: 17_797_120 } },
  pids_stats: { current: 21, limit: 512 },
  networks: { eth0: { rx_bytes: 153_089, tx_bytes: 1_219_018 } },
};

function stats(overrides: Partial<ContainerStatsSample> = {}): ContainerStatsSample {
  return {
    cpuUsageNanos: 0,
    memoryUsageBytes: 2_000,
    memoryInactiveFileBytes: 500,
    memoryLimitBytes: 4_000,
    pids: 3,
    pidsLimit: 512,
    networkRxBytes: 10,
    networkTxBytes: 20,
    ...overrides,
  };
}

describe("Docker stats parsing (Phase 17.5)", () => {
  it("computes memory like docker stats: usage minus inactive file cache", () => {
    const parsed = parseDockerStats(DOCKER_STATS);
    expect(parsed).toEqual({
      cpuUsageNanos: 12_000_000_000,
      memoryUsageBytes: 170_041_344,
      memoryInactiveFileBytes: 17_797_120,
      memoryLimitBytes: 4_294_967_296,
      pids: 21,
      pidsLimit: 512,
      networkRxBytes: 153_089,
      networkTxBytes: 1_219_018,
    });
    // 145.2 MiB, what `docker stats` printed for the same container.
    expect(((parsed?.memoryUsageBytes ?? 0) - (parsed?.memoryInactiveFileBytes ?? 0)) / 2 ** 20)
      .toBeCloseTo(145.19, 2);
  });

  it("accepts cgroup v1 field names and sums every network interface", () => {
    const parsed = parseDockerStats({
      ...DOCKER_STATS,
      memory_stats: { usage: 1_000, limit: 4_000, stats: { total_inactive_file: 100 } },
      networks: { eth0: { rx_bytes: 1, tx_bytes: 2 }, eth1: { rx_bytes: 3, tx_bytes: 4 } },
    });
    expect(parsed?.memoryInactiveFileBytes).toBe(100);
    expect(parsed?.networkRxBytes).toBe(4);
    expect(parsed?.networkTxBytes).toBe(6);
  });

  it("rejects documents without CPU or memory usage and ignores bogus counters", () => {
    expect(parseDockerStats(null)).toBeNull();
    expect(parseDockerStats({ memory_stats: { usage: 1 } })).toBeNull();
    const parsed = parseDockerStats({
      cpu_stats: { cpu_usage: { total_usage: 5 } },
      memory_stats: { usage: 10, stats: { inactive_file: 50 } },
      pids_stats: { current: -1 },
      networks: { eth0: { rx_bytes: "x" } },
    });
    expect(parsed).toMatchObject({ memoryInactiveFileBytes: 0, pids: 0, networkRxBytes: 0 });
  });
});

describe("CPU cores from cumulative samples", () => {
  it("is null for the first sample, a counter reset or no elapsed time", () => {
    expect(cpuCores(undefined, 1, 1_000)).toBeNull();
    expect(cpuCores({ cpuUsageNanos: 5e9, at: 0 }, 1e9, 10_000)).toBeNull();
    expect(cpuCores({ cpuUsageNanos: 0, at: 1_000 }, 1e9, 1_000)).toBeNull();
  });

  it("is the CPU time used divided by the wall time between samples", () => {
    expect(cpuCores({ cpuUsageNanos: 0, at: 0 }, 20e9, 10_000)).toBeCloseTo(2);
    expect(cpuCores({ cpuUsageNanos: 1e9, at: 0 }, 1.5e9, 10_000)).toBeCloseTo(0.05);
  });
});

describe("Workspace usage sampler", () => {
  function source(
    containers: Array<{ workspaceId: string; containerId: string }>,
    readStats: (containerId: string) => Promise<ContainerStatsSample>,
  ): UsageSource {
    return { runningWorkspaceContainers: async () => containers, containerStats: readStats };
  }

  it("reports schema-valid samples with a cores delta from the second round on", async () => {
    let now = 0;
    let nanos = 0;
    const sampler = new WorkspaceUsageSampler({
      source: source([{ workspaceId: A, containerId: "c-a" }], async () => stats({ cpuUsageNanos: nanos })),
      oom: { count: (workspaceId) => (workspaceId === A ? 2 : 0) },
      cpuLimitCores: 2,
      now: () => now,
    });
    const [first] = await sampler.sample();
    expect(first).toMatchObject({ workspaceId: A, cpuCores: null, memoryBytes: 1_500, oomKills: 2 });
    expect(WorkspaceUsageSchema.safeParse(first).success).toBe(true);
    now = 10_000;
    nanos = 15e9;
    const [second] = await sampler.sample();
    expect(second?.cpuCores).toBeCloseTo(1.5);
    expect(second?.cpuLimitCores).toBe(2);
    expect(second?.sampledAt).toBe(new Date(10_000).toISOString());
  });

  it("leaves out containers whose stats fail or time out, without failing the round", async () => {
    const sampler = new WorkspaceUsageSampler({
      source: source(
        [
          { workspaceId: A, containerId: "slow" },
          { workspaceId: B, containerId: "ok" },
          { workspaceId: B, containerId: "broken" },
        ],
        async (containerId) => {
          if (containerId === "slow") return new Promise<ContainerStatsSample>(() => undefined);
          if (containerId === "broken") throw new Error("engine error");
          return stats();
        },
      ),
      oom: { count: () => 0 },
      cpuLimitCores: 2,
      timeoutMs: 20,
    });
    const samples = await sampler.sample();
    expect(samples.map((sample) => sample.workspaceId)).toEqual([B]);
  });

  it("restarts the delta for a Workspace that missed a round", async () => {
    let now = 0;
    let include = true;
    const sampler = new WorkspaceUsageSampler({
      source: {
        runningWorkspaceContainers: async () => (include ? [{ workspaceId: A, containerId: "c" }] : []),
        containerStats: async () => stats({ cpuUsageNanos: now * 1e6 }),
      },
      oom: { count: () => 0 },
      cpuLimitCores: 2,
      now: () => now,
    });
    await sampler.sample();
    include = false;
    now = 10_000;
    await sampler.sample();
    include = true;
    now = 20_000;
    const [sample] = await sampler.sample();
    expect(sample?.cpuCores).toBeNull();
  });
});

describe("host usage sampler", () => {
  it("reports the busy share between two calls and clamps memory", () => {
    const times = [
      { busy: 100, total: 1_000 },
      { busy: 600, total: 2_000 },
    ];
    const host = new HostUsageSampler(
      () => times.shift() ?? { busy: 0, total: 0 },
      () => ({ total: 100, available: 150 }),
      () => 0.5,
    );
    expect(host.sample()).toEqual({
      cpuUtilization: null,
      memoryTotalBytes: 100,
      memoryAvailableBytes: 100,
      load1: 0.5,
    });
    expect(host.sample().cpuUtilization).toBeCloseTo(0.5);
  });
});

describe("usage reporter", () => {
  it("keeps the latest sample, never overlaps rounds and survives sampler errors", async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const reporter = new UsageReporter({
      sample: async () => {
        calls += 1;
        if (calls === 2) throw new Error("docker down");
        await new Promise<void>((resolve) => (release = resolve));
        return [];
      },
    });
    expect(reporter.workspaces()).toBeNull();
    const first = reporter.refresh();
    await reporter.refresh();
    expect(calls).toBe(1);
    release();
    await first;
    expect(reporter.workspaces()).toEqual([]);
    await reporter.refresh();
    expect(reporter.workspaces()).toEqual([]);
    expect(reporter.host().memoryTotalBytes).toBeGreaterThan(0);
  });
});
