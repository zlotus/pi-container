import type { MetricsSnapshot } from "@agent-runtime/database";
import { ModelRelayResultSchema } from "@agent-runtime/protocol";
import { Counter, Gauge, Registry } from "prom-client";

import type { PlatformMetrics } from "./platform-metrics.js";
import type { UsageRegistry } from "./usage-registry.js";

/**
 * Scrape-time metrics (specs.md Phase 17.4): platform state from one PostgreSQL snapshot and
 * the latest Worker-reported usage. Every scrape builds these series in a fresh registry, so
 * deleted Workspaces, stopped containers and offline Workers disappear instead of going
 * stale, and a series that cannot be read is absent rather than a misleading 0.
 */

const ACTIVE_STATES = new Set(["RUNNING", "STARTING"]);

function seconds(date: Date | string): number {
  return (typeof date === "string" ? Date.parse(date) : date.getTime()) / 1_000;
}

type Labels = Record<string, string>;

/** One scrape's series, registered on first use. */
class ScrapeSeries {
  readonly registry = new Registry();
  readonly #gauges = new Map<string, Gauge<string>>();
  readonly #counters = new Map<string, Counter<string>>();

  gauge(name: string, help: string, labels: Labels, value: number): void {
    let gauge = this.#gauges.get(name);
    if (gauge === undefined) {
      gauge = new Gauge({ name, help, labelNames: Object.keys(labels), registers: [this.registry] });
      this.#gauges.set(name, gauge);
    }
    gauge.set(labels, value);
  }

  /**
   * Worker-reported counters are cumulative values that reset with the Worker or the
   * container; they are exposed as reported (`counter` type, so `rate()` handles resets).
   */
  counter(name: string, help: string, labels: Labels, value: number): void {
    let counter = this.#counters.get(name);
    if (counter === undefined) {
      counter = new Counter({ name, help, labelNames: Object.keys(labels), registers: [this.registry] });
      this.#counters.set(name, counter);
    }
    counter.inc(labels, value);
  }
}

export interface MetricsSnapshotStore {
  metricsSnapshot(timeoutMs?: number): Promise<MetricsSnapshot>;
}

export class MetricsCollector {
  readonly #metrics: PlatformMetrics;
  readonly #store: MetricsSnapshotStore;
  readonly #usage: UsageRegistry;
  readonly #connected: () => readonly string[];
  readonly #modelGatewayEnabled: boolean;

  constructor(options: {
    metrics: PlatformMetrics;
    store: MetricsSnapshotStore;
    usage: UsageRegistry;
    connectedWorkerIds: () => readonly string[];
    modelGatewayEnabled: boolean;
  }) {
    this.#metrics = options.metrics;
    this.#store = options.store;
    this.#usage = options.usage;
    this.#connected = options.connectedWorkerIds;
    this.#modelGatewayEnabled = options.modelGatewayEnabled;
  }

  /** The complete exposition text: process instruments plus this scrape's series. */
  async collect(): Promise<string> {
    const series = new ScrapeSeries();
    const startedAt = performance.now();
    const snapshot = await this.#store.metricsSnapshot().catch(() => null);
    const collector = { collector: "database" };
    series.gauge("agent_runtime_collector_up", "Whether the scrape-time collector succeeded.", collector, snapshot === null ? 0 : 1);
    series.gauge(
      "agent_runtime_collector_duration_seconds",
      "Scrape-time collector duration.",
      collector,
      (performance.now() - startedAt) / 1_000,
    );
    if (snapshot !== null) this.#platform(series, snapshot);
    this.#observedUsage(series, snapshot);
    return Registry.merge([this.#metrics.registry, series.registry]).metrics();
  }

  #platform(series: ScrapeSeries, snapshot: MetricsSnapshot): void {
    for (const row of snapshot.workspaces) {
      series.gauge(
        "agent_runtime_workspaces",
        "Workspaces by state and assigned Worker.",
        { state: row.state, worker_id: row.workerId ?? "none" },
        row.count,
      );
    }
    const connected = new Set(this.#connected());
    for (const worker of snapshot.workers) {
      const id = { worker_id: worker.workerId };
      series.gauge("agent_runtime_worker_up", "1 when the Worker is ONLINE.", id, worker.status === "ONLINE" ? 1 : 0);
      series.gauge("agent_runtime_worker_status", "The Worker's current status (one-hot).", { ...id, status: worker.status }, 1);
      series.gauge("agent_runtime_worker_enabled", "1 unless the Worker credential is revoked.", id, worker.enabled ? 1 : 0);
      series.gauge("agent_runtime_worker_schedulable", "1 when new Workspaces may be placed on the Worker.", id, worker.schedulable ? 1 : 0);
      series.gauge("agent_runtime_worker_connected", "1 while the Worker control channel is connected.", id, connected.has(worker.workerId) ? 1 : 0);
      if (worker.lastHeartbeatAt !== null) {
        series.gauge("agent_runtime_worker_last_heartbeat_timestamp_seconds", "Time of the Worker's last heartbeat.", id, seconds(worker.lastHeartbeatAt));
      }
      series.gauge("agent_runtime_worker_egress_enforced", "1 when the Worker enforces the egress rules.", id, worker.egressEnforced ? 1 : 0);
      series.gauge("agent_runtime_worker_storage_enforced", "1 when the Worker enforces disk quotas.", id, worker.storageEnforced ? 1 : 0);
      if (worker.modelRelayEnabled) {
        series.gauge("agent_runtime_worker_model_relay_listening", "1 when the Worker's model relay listens.", id, worker.modelRelayListening ? 1 : 0);
      }
      series.gauge("agent_runtime_worker_workspaces_allocated", "Workspace containers allocated on the Worker.", id, worker.allocatedWorkspaces);
      if (worker.maxWorkspaces !== null) {
        series.gauge("agent_runtime_worker_workspaces_max", "The Worker's Workspace capacity.", id, worker.maxWorkspaces);
      }
      const filesystem = "The Worker's managed-root filesystem size and free space.";
      if (worker.storageTotalBytes !== null) {
        series.gauge("agent_runtime_worker_filesystem_bytes", filesystem, { ...id, kind: "total" }, worker.storageTotalBytes);
      }
      if (worker.storageFreeBytes !== null) {
        series.gauge("agent_runtime_worker_filesystem_bytes", filesystem, { ...id, kind: "free" }, worker.storageFreeBytes);
      }
      series.gauge(
        "agent_runtime_worker_disk_limit_allocated_bytes",
        "Sum of Workspace data limits assigned to the Worker.",
        id,
        worker.diskLimitAllocatedBytes,
      );
    }
    for (const disk of snapshot.workspaceDisk) {
      const labels = { workspace_id: disk.workspaceId, worker_id: disk.workerId ?? "none" };
      series.gauge("agent_runtime_workspace_info", "Workspace ownership, for joins (value 1).", { ...labels, user_id: disk.userId }, 1);
      if (disk.sampledAt === null) continue;
      const used = "Workspace disk usage by quota project.";
      const limit = "Workspace disk limit by quota project.";
      if (disk.dataUsedBytes !== null) {
        series.gauge("agent_runtime_workspace_disk_used_bytes", used, { ...labels, project: "data" }, disk.dataUsedBytes);
        series.gauge("agent_runtime_workspace_disk_limit_bytes", limit, { ...labels, project: "data" }, disk.dataLimitBytes);
      }
      if (disk.piUsedBytes !== null) {
        series.gauge("agent_runtime_workspace_disk_used_bytes", used, { ...labels, project: "pi" }, disk.piUsedBytes);
      }
      if (disk.piLimitBytes !== null) {
        series.gauge("agent_runtime_workspace_disk_limit_bytes", limit, { ...labels, project: "pi" }, disk.piLimitBytes);
      }
      if (disk.dataUsedInodes !== null) {
        series.gauge("agent_runtime_workspace_disk_used_inodes", "Inodes used by the Workspace data project.", labels, disk.dataUsedInodes);
      }
      series.gauge(
        "agent_runtime_workspace_disk_sampled_timestamp_seconds",
        "When the Workspace disk usage was sampled.",
        labels,
        seconds(disk.sampledAt),
      );
    }
    series.gauge("agent_runtime_sessions_active", "Platform sessions that are neither revoked nor expired.", {}, snapshot.activeSessions);
    for (const lock of snapshot.activeAuthLocks) {
      series.gauge("agent_runtime_auth_active_locks", "Active login throttle locks by scope.", { scope: lock.scope }, lock.count);
    }
    if (this.#modelGatewayEnabled) {
      for (const key of snapshot.modelKeys) {
        series.gauge("agent_runtime_model_keys", "Model gateway virtual keys by status.", { status: key.status }, key.count);
      }
      series.gauge(
        "agent_runtime_model_key_revocation_oldest_pending_seconds",
        "Age of the oldest pending model key revocation.",
        {},
        snapshot.oldestPendingRevocationSeconds,
      );
    }
  }

  #observedUsage(series: ScrapeSeries, snapshot: MetricsSnapshot | null): void {
    // With the database snapshot, only Workspaces still running on that Worker are shown.
    const assignment =
      snapshot === null ? null : new Map(snapshot.workspaceDisk.map((row) => [row.workspaceId, row]));
    for (const entry of this.#usage.entries()) {
      const id = { worker_id: entry.workerId };
      if (entry.host.cpuUtilization !== null) {
        series.gauge("agent_runtime_worker_host_cpu_utilization_ratio", "Busy share of the Worker host CPUs.", id, entry.host.cpuUtilization);
      }
      const memory = "Worker host memory total and available.";
      series.gauge("agent_runtime_worker_host_memory_bytes", memory, { ...id, kind: "total" }, entry.host.memoryTotalBytes);
      series.gauge("agent_runtime_worker_host_memory_bytes", memory, { ...id, kind: "available" }, entry.host.memoryAvailableBytes);
      series.gauge("agent_runtime_worker_host_load1", "Worker host 1-minute load average.", id, entry.host.load1);
      if (entry.relay !== null) {
        for (const result of ModelRelayResultSchema.options) {
          series.counter(
            "agent_runtime_model_relay_requests_total",
            "Worker model relay requests by result.",
            { ...id, result },
            entry.relay.requests[result],
          );
        }
        series.counter(
          "agent_runtime_model_relay_rejected_connections_total",
          "Model relay connections dropped because the source is not a running Workspace.",
          id,
          entry.relay.rejectedConnections,
        );
        series.gauge("agent_runtime_model_relay_active_requests", "Model relay requests in progress.", id, entry.relay.activeRequests);
      }
      for (const sample of entry.workspaces) {
        if (assignment !== null) {
          const row = assignment.get(sample.workspaceId);
          if (row === undefined || row.workerId !== entry.workerId || !ACTIVE_STATES.has(row.state)) continue;
        }
        const labels = { workspace_id: sample.workspaceId, ...id };
        series.counter("agent_runtime_workspace_cpu_seconds_total", "Cumulative Workspace container CPU time.", labels, sample.cpuUsageNanos / 1e9);
        series.gauge("agent_runtime_workspace_cpu_limit_cores", "Workspace container CPU limit.", labels, sample.cpuLimitCores);
        series.gauge(
          "agent_runtime_workspace_memory_bytes",
          "Workspace container memory (usage minus inactive file cache).",
          labels,
          sample.memoryBytes,
        );
        series.gauge("agent_runtime_workspace_memory_limit_bytes", "Workspace container memory limit.", labels, sample.memoryLimitBytes);
        series.gauge("agent_runtime_workspace_pids", "Processes in the Workspace container.", labels, sample.pids);
        series.gauge("agent_runtime_workspace_pids_limit", "Workspace container process limit.", labels, sample.pidsLimit);
        const network = "Cumulative Workspace container network bytes.";
        series.counter("agent_runtime_workspace_network_bytes_total", network, { ...labels, direction: "rx" }, sample.networkRxBytes);
        series.counter("agent_runtime_workspace_network_bytes_total", network, { ...labels, direction: "tx" }, sample.networkTxBytes);
        series.counter(
          "agent_runtime_workspace_oom_kills_total",
          "OOM events observed for the Workspace container (lower bound).",
          labels,
          sample.oomKills,
        );
        series.gauge(
          "agent_runtime_workspace_usage_sampled_timestamp_seconds",
          "When the Workspace container usage was sampled.",
          labels,
          seconds(sample.sampledAt),
        );
      }
    }
  }
}
