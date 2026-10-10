import { cpus, freemem, loadavg, totalmem } from "node:os";

import type { WorkerHostUsage, WorkspaceUsage } from "@agent-runtime/protocol";

/**
 * Observed resource usage for the heartbeat (specs.md Phase 17.5). Sampling never changes
 * Workspace state: a container that cannot be sampled is simply left out of this round.
 */

/** The fields of a Docker Engine one-shot stats response that usage is computed from. */
export interface ContainerStatsSample {
  cpuUsageNanos: number;
  memoryUsageBytes: number;
  memoryInactiveFileBytes: number;
  memoryLimitBytes: number;
  pids: number;
  pidsLimit: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export interface RunningWorkspaceContainer {
  workspaceId: string;
  containerId: string;
}

/** What the sampler needs from the Docker runtime; it only ever sees managed containers. */
export interface UsageSource {
  runningWorkspaceContainers(): Promise<RunningWorkspaceContainer[]>;
  containerStats(containerId: string): Promise<ContainerStatsSample>;
}

export interface OomCounts {
  count(workspaceId: string): number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Reads the Docker stats document the way `docker stats` does: memory is `usage` minus the
 * inactive file cache (`inactive_file` on cgroup v2, `total_inactive_file` on v1).
 */
export function parseDockerStats(raw: unknown): ContainerStatsSample | null {
  if (typeof raw !== "object" || raw === null) return null;
  const stats = raw as {
    cpu_stats?: { cpu_usage?: { total_usage?: unknown } };
    memory_stats?: { usage?: unknown; limit?: unknown; stats?: Record<string, unknown> };
    pids_stats?: { current?: unknown; limit?: unknown };
    networks?: Record<string, { rx_bytes?: unknown; tx_bytes?: unknown }>;
  };
  const cpuUsage = stats.cpu_stats?.cpu_usage?.total_usage;
  const memoryUsage = stats.memory_stats?.usage;
  if (typeof cpuUsage !== "number" || typeof memoryUsage !== "number") return null;
  const memoryStats = stats.memory_stats?.stats ?? {};
  const inactive = count(memoryStats.inactive_file ?? memoryStats.total_inactive_file);
  let rx = 0;
  let tx = 0;
  for (const network of Object.values(stats.networks ?? {})) {
    rx += count(network.rx_bytes);
    tx += count(network.tx_bytes);
  }
  return {
    cpuUsageNanos: count(cpuUsage),
    memoryUsageBytes: count(memoryUsage),
    memoryInactiveFileBytes: inactive < count(memoryUsage) ? inactive : 0,
    memoryLimitBytes: count(stats.memory_stats?.limit),
    pids: count(stats.pids_stats?.current),
    pidsLimit: count(stats.pids_stats?.limit),
    networkRxBytes: Math.min(rx, Number.MAX_SAFE_INTEGER),
    networkTxBytes: Math.min(tx, Number.MAX_SAFE_INTEGER),
  };
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    task,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("container stats timed out")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

const MAX_CPU_CORES = 1_024;

export interface WorkspaceUsageSamplerOptions {
  source: UsageSource;
  oom: OomCounts;
  cpuLimitCores: number;
  now?: () => number;
  timeoutMs?: number;
  concurrency?: number;
}

export class WorkspaceUsageSampler {
  readonly #source: UsageSource;
  readonly #oom: OomCounts;
  readonly #cpuLimitCores: number;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #concurrency: number;
  /** The previous CPU sample per Workspace, for the cores-used delta. */
  #previous = new Map<string, { cpuUsageNanos: number; at: number }>();

  constructor(options: WorkspaceUsageSamplerOptions) {
    this.#source = options.source;
    this.#oom = options.oom;
    this.#cpuLimitCores = options.cpuLimitCores;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 2_000;
    this.#concurrency = options.concurrency ?? 4;
  }

  async sample(): Promise<WorkspaceUsage[]> {
    const containers = (await this.#source.runningWorkspaceContainers()).slice(0, 10_000);
    const samples: WorkspaceUsage[] = [];
    const next = new Map<string, { cpuUsageNanos: number; at: number }>();
    let index = 0;
    const work = async (): Promise<void> => {
      while (index < containers.length) {
        const container = containers[index++];
        if (container === undefined) return;
        let stats: ContainerStatsSample;
        try {
          stats = await withTimeout(this.#source.containerStats(container.containerId), this.#timeoutMs);
        } catch {
          continue;
        }
        const at = this.#now();
        const previous = this.#previous.get(container.workspaceId);
        next.set(container.workspaceId, { cpuUsageNanos: stats.cpuUsageNanos, at });
        samples.push({
          workspaceId: container.workspaceId,
          sampledAt: new Date(at).toISOString(),
          cpuUsageNanos: stats.cpuUsageNanos,
          cpuCores: cpuCores(previous, stats.cpuUsageNanos, at),
          cpuLimitCores: this.#cpuLimitCores,
          memoryBytes: stats.memoryUsageBytes - stats.memoryInactiveFileBytes,
          memoryLimitBytes: stats.memoryLimitBytes,
          pids: stats.pids,
          pidsLimit: stats.pidsLimit,
          networkRxBytes: stats.networkRxBytes,
          networkTxBytes: stats.networkTxBytes,
          oomKills: this.#oom.count(container.workspaceId),
        });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.#concurrency) }, work));
    // Workspaces that were not sampled this round start over (no stale delta later).
    this.#previous = next;
    return samples;
  }
}

/** Cores used since the previous sample; null without a usable previous sample. */
export function cpuCores(
  previous: { cpuUsageNanos: number; at: number } | undefined,
  cpuUsageNanos: number,
  at: number,
): number | null {
  if (previous === undefined) return null;
  const elapsedMs = at - previous.at;
  const usedNanos = cpuUsageNanos - previous.cpuUsageNanos;
  // A recreated container restarts its counter; the next sample gives a valid figure.
  if (elapsedMs <= 0 || usedNanos < 0) return null;
  return Math.min(MAX_CPU_CORES, usedNanos / 1e9 / (elapsedMs / 1_000));
}

interface CpuTimes {
  busy: number;
  total: number;
}

function readCpuTimes(): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const { user, nice, sys, irq, idle } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total };
}

/**
 * Host CPU busy share between two calls, memory (`os.freemem()` is `MemAvailable` on Linux)
 * and the 1-minute load average. Needs no privilege.
 */
export class HostUsageSampler {
  #previous: CpuTimes | null = null;

  constructor(
    readonly readTimes: () => CpuTimes = readCpuTimes,
    readonly memory: () => { total: number; available: number } = () => ({
      total: totalmem(),
      available: freemem(),
    }),
    readonly load1: () => number = () => loadavg()[0] ?? 0,
  ) {}

  sample(): WorkerHostUsage {
    const times = this.readTimes();
    const previous = this.#previous;
    this.#previous = times;
    let cpuUtilization: number | null = null;
    if (previous !== null) {
      const total = times.total - previous.total;
      const busy = times.busy - previous.busy;
      if (total > 0 && busy >= 0) cpuUtilization = Math.min(1, busy / total);
    }
    const memory = this.memory();
    const memoryTotalBytes = Math.max(0, Math.floor(memory.total));
    return {
      cpuUtilization,
      memoryTotalBytes,
      memoryAvailableBytes: Math.min(memoryTotalBytes, Math.max(0, Math.floor(memory.available))),
      load1: Math.max(0, this.load1()),
    };
  }
}
