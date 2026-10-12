import type { ModelRelayStats, WorkerHostUsage, WorkspaceUsage } from "@agent-runtime/protocol";

/**
 * The latest observed usage each Worker reported with its heartbeat (specs.md Phase 17.5,
 * 17.7). Kept in memory only: a Control Plane restart is repopulated by the next heartbeat.
 * Readers only ever see fresh samples, so stopped Workspaces and offline Workers disappear.
 */

export interface WorkerUsageEntry {
  workerId: string;
  receivedAt: Date;
  host: WorkerHostUsage;
  relay: ModelRelayStats | null;
  workspaces: WorkspaceUsage[];
}

export interface WorkspaceUsageView {
  cpuCores: number | null;
  cpuLimitCores: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  pids: number;
  pidsLimit: number;
  oomKills: number;
  sampledAt: string;
}

export interface WorkerUsageView {
  hostCpuUtilization: number | null;
  hostMemoryTotalBytes: number;
  hostMemoryAvailableBytes: number;
  load1: number;
  workspaceCpuCores: number;
  workspaceMemoryBytes: number;
  runningWorkspaces: number;
  sampledAt: string;
}

/** Samples dated more than this far after their arrival are rejected as implausible. */
const MAX_FUTURE_SKEW_MS = 60_000;

export class UsageRegistry {
  readonly #entries = new Map<string, WorkerUsageEntry>();

  constructor(
    /** A sample older than this is stale (the Worker offline cut-off, Phase 17.4). */
    readonly staleAfterMs: number,
    readonly isConnected: (workerId: string) => boolean = () => true,
    readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Stores one heartbeat. `assigned` is the set of Workspaces that are assigned to this
   * Worker and running; samples for any other Workspace are dropped and counted.
   */
  record(input: {
    workerId: string;
    receivedAt: Date;
    host: WorkerHostUsage;
    relay: ModelRelayStats | null;
    workspaces: readonly WorkspaceUsage[];
    assigned: ReadonlySet<string>;
  }): { ignored: number } {
    const latest = input.receivedAt.getTime() + MAX_FUTURE_SKEW_MS;
    const accepted: WorkspaceUsage[] = [];
    let ignored = 0;
    for (const sample of input.workspaces) {
      if (!input.assigned.has(sample.workspaceId) || Date.parse(sample.sampledAt) > latest) {
        ignored += 1;
        continue;
      }
      accepted.push(sample);
    }
    this.#entries.set(input.workerId, {
      workerId: input.workerId,
      receivedAt: input.receivedAt,
      host: input.host,
      relay: input.relay,
      workspaces: accepted,
    });
    return { ignored };
  }

  forget(workerId: string): void {
    this.#entries.delete(workerId);
  }

  #fresh(time: number): boolean {
    return this.now().getTime() - time <= this.staleAfterMs;
  }

  /** Fresh entries of connected Workers, each with only its fresh Workspace samples. */
  entries(): WorkerUsageEntry[] {
    const fresh: WorkerUsageEntry[] = [];
    for (const entry of this.#entries.values()) {
      if (!this.isConnected(entry.workerId) || !this.#fresh(entry.receivedAt.getTime())) continue;
      fresh.push({
        ...entry,
        workspaces: entry.workspaces.filter((sample) => this.#fresh(Date.parse(sample.sampledAt))),
      });
    }
    return fresh.sort((left, right) => left.workerId.localeCompare(right.workerId));
  }

  /** A Workspace's usage when its assigned Worker reported a fresh sample for it. */
  workspace(workspaceId: string, workerId: string | null): WorkspaceUsageView | null {
    if (workerId === null) return null;
    const entry = this.entries().find((candidate) => candidate.workerId === workerId);
    const sample = entry?.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
    if (sample === undefined) return null;
    return {
      cpuCores: sample.cpuCores,
      cpuLimitCores: sample.cpuLimitCores,
      memoryBytes: sample.memoryBytes,
      memoryLimitBytes: sample.memoryLimitBytes,
      pids: sample.pids,
      pidsLimit: sample.pidsLimit,
      oomKills: sample.oomKills,
      sampledAt: sample.sampledAt,
    };
  }

  worker(workerId: string): WorkerUsageView | null {
    const entry = this.entries().find((candidate) => candidate.workerId === workerId);
    if (entry === undefined) return null;
    let cpu = 0;
    let memory = 0;
    for (const sample of entry.workspaces) {
      cpu += sample.cpuCores ?? 0;
      memory += sample.memoryBytes;
    }
    return {
      hostCpuUtilization: entry.host.cpuUtilization,
      hostMemoryTotalBytes: entry.host.memoryTotalBytes,
      hostMemoryAvailableBytes: entry.host.memoryAvailableBytes,
      load1: entry.host.load1,
      workspaceCpuCores: cpu,
      workspaceMemoryBytes: memory,
      runningWorkspaces: entry.workspaces.length,
      sampledAt: entry.receivedAt.toISOString(),
    };
  }
}
