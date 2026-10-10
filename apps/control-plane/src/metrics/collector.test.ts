import type { MetricsSnapshot } from "@agent-runtime/database";
import type { ModelRelayStats, WorkspaceUsage } from "@agent-runtime/protocol";
import { describe, expect, it } from "vitest";

import { MetricsCollector } from "./collector.js";
import { PlatformMetrics } from "./platform-metrics.js";
import { UsageRegistry } from "./usage-registry.js";

const NOW = new Date("2026-10-10T08:00:00.000Z");
const RUNNING = "5b0f3a9e-2c4d-4e6f-8a1b-3c5d7e9f1a2b";
const STOPPED = "6c1f3a9e-2c4d-4e6f-8a1b-3c5d7e9f1a2b";
const OTHER = "7d2f3a9e-2c4d-4e6f-8a1b-3c5d7e9f1a2b";
const USER = "8e3f3a9e-2c4d-4e6f-8a1b-3c5d7e9f1a2b";

function snapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    workspaces: [
      { state: "RUNNING", workerId: "worker-a", count: 1 },
      { state: "STOPPED", workerId: "worker-a", count: 1 },
      { state: "CREATED", workerId: null, count: 2 },
    ],
    workers: [
      {
        workerId: "worker-a",
        status: "ONLINE",
        enabled: true,
        schedulable: true,
        lastHeartbeatAt: new Date(NOW.getTime() - 5_000),
        allocatedWorkspaces: 2,
        maxWorkspaces: 4,
        egressEnforced: true,
        storageEnforced: true,
        storageTotalBytes: 1_000,
        storageFreeBytes: 400,
        modelRelayEnabled: true,
        modelRelayListening: true,
        diskLimitAllocatedBytes: 40,
      },
      {
        workerId: "worker-b",
        status: "OFFLINE",
        enabled: true,
        schedulable: true,
        lastHeartbeatAt: null,
        allocatedWorkspaces: 0,
        maxWorkspaces: null,
        egressEnforced: false,
        storageEnforced: false,
        storageTotalBytes: null,
        storageFreeBytes: null,
        modelRelayEnabled: false,
        modelRelayListening: false,
        diskLimitAllocatedBytes: 0,
      },
    ],
    workspaceDisk: [
      {
        workspaceId: RUNNING,
        userId: USER,
        workerId: "worker-a",
        state: "RUNNING",
        dataUsedBytes: 19,
        dataLimitBytes: 20,
        dataUsedInodes: 7,
        piUsedBytes: 1,
        piLimitBytes: 2,
        sampledAt: new Date(NOW.getTime() - 30_000),
      },
      {
        workspaceId: STOPPED,
        userId: USER,
        workerId: "worker-a",
        state: "STOPPED",
        dataUsedBytes: null,
        dataLimitBytes: 20,
        dataUsedInodes: null,
        piUsedBytes: null,
        piLimitBytes: null,
        sampledAt: null,
      },
    ],
    activeSessions: 3,
    activeAuthLocks: [{ scope: "login_ip", count: 1 }],
    modelKeys: [
      { status: "active", count: 2 },
      { status: "revoking", count: 1 },
    ],
    oldestPendingRevocationSeconds: 42,
    ...overrides,
  };
}

function usage(workspaceId: string, overrides: Partial<WorkspaceUsage> = {}): WorkspaceUsage {
  return {
    workspaceId,
    sampledAt: new Date(NOW.getTime() - 2_000).toISOString(),
    cpuUsageNanos: 12_500_000_000,
    cpuCores: 0.5,
    cpuLimitCores: 2,
    memoryBytes: 1_024,
    memoryLimitBytes: 4_096,
    pids: 21,
    pidsLimit: 512,
    networkRxBytes: 100,
    networkTxBytes: 200,
    oomKills: 1,
    ...overrides,
  };
}

const RELAY: ModelRelayStats = {
  requests: {
    "2xx": 5, "4xx": 1, "5xx": 0, no_key: 0, gateway_unavailable: 2, rejected_path: 0,
    body_too_large: 0, concurrency_limited: 0,
  },
  rejectedConnections: 3,
  activeRequests: 1,
};

function setup(options: { fail?: boolean; connected?: string[]; modelGatewayEnabled?: boolean } = {}) {
  let current = snapshot();
  const metrics = new PlatformMetrics({ version: "test", protocolVersion: 5 });
  const connected = new Set(options.connected ?? ["worker-a"]);
  const registry = new UsageRegistry(35_000, (workerId) => connected.has(workerId), () => NOW);
  const collector = new MetricsCollector({
    metrics,
    store: {
      metricsSnapshot: async () => {
        if (options.fail === true) throw new Error("database down");
        return current;
      },
    },
    usage: registry,
    connectedWorkerIds: () => [...connected],
    modelGatewayEnabled: options.modelGatewayEnabled ?? true,
  });
  return {
    metrics,
    registry,
    collector,
    connected,
    setSnapshot: (next: MetricsSnapshot) => (current = next),
  };
}

function line(text: string, series: string): string | undefined {
  return text.split("\n").find((candidate) => candidate.startsWith(series));
}

describe("scrape-time metrics (Phase 17.4)", () => {
  it("exposes platform state from the database snapshot", async () => {
    const { collector } = setup();
    const text = await collector.collect();
    expect(line(text, 'agent_runtime_collector_up{collector="database"}')).toMatch(/ 1$/);
    expect(line(text, 'agent_runtime_workspaces{state="CREATED",worker_id="none"}')).toMatch(/ 2$/);
    expect(line(text, 'agent_runtime_worker_up{worker_id="worker-a"}')).toMatch(/ 1$/);
    expect(line(text, 'agent_runtime_worker_up{worker_id="worker-b"}')).toMatch(/ 0$/);
    expect(line(text, 'agent_runtime_worker_status{worker_id="worker-b",status="OFFLINE"}')).toMatch(/ 1$/);
    expect(line(text, 'agent_runtime_worker_connected{worker_id="worker-b"}')).toMatch(/ 0$/);
    expect(text).not.toContain('agent_runtime_worker_last_heartbeat_timestamp_seconds{worker_id="worker-b"}');
    expect(text).not.toContain('agent_runtime_worker_model_relay_listening{worker_id="worker-b"}');
    expect(line(text, 'agent_runtime_worker_filesystem_bytes{worker_id="worker-a",kind="free"}')).toMatch(/ 400$/);
    expect(line(text, `agent_runtime_workspace_disk_used_bytes{workspace_id="${RUNNING}",worker_id="worker-a",project="data"}`)).toMatch(/ 19$/);
    expect(line(text, `agent_runtime_workspace_disk_limit_bytes{workspace_id="${RUNNING}",worker_id="worker-a",project="pi"}`)).toMatch(/ 2$/);
    expect(text).not.toContain(`agent_runtime_workspace_disk_used_bytes{workspace_id="${STOPPED}"`);
    expect(line(text, `agent_runtime_workspace_info{workspace_id="${STOPPED}",worker_id="worker-a",user_id="${USER}"}`)).toMatch(/ 1$/);
    expect(line(text, "agent_runtime_sessions_active")).toMatch(/ 3$/);
    expect(line(text, 'agent_runtime_auth_active_locks{scope="login_ip"}')).toMatch(/ 1$/);
    expect(line(text, 'agent_runtime_model_keys{status="revoking"}')).toMatch(/ 1$/);
    expect(line(text, "agent_runtime_model_key_revocation_oldest_pending_seconds")).toMatch(/ 42$/);
  });

  it("omits database metrics but still answers when the snapshot fails", async () => {
    const { collector, metrics } = setup({ fail: true });
    metrics.recordLogin("local", "success");
    const text = await collector.collect();
    expect(line(text, 'agent_runtime_collector_up{collector="database"}')).toMatch(/ 0$/);
    expect(text).not.toMatch(/^agent_runtime_workspaces\{/m);
    expect(text).not.toMatch(/^agent_runtime_worker_up\{/m);
    expect(line(text, 'agent_runtime_auth_logins_total{protocol="local",result="success"}')).toMatch(/ 1$/);
  });

  it("does not report model key state without a model gateway", async () => {
    const text = await setup({ modelGatewayEnabled: false }).collector.collect();
    expect(text).not.toMatch(/^agent_runtime_model_keys\{/m);
    expect(text).not.toMatch(/^agent_runtime_model_key_revocation_oldest_pending_seconds /m);
  });

  it("exposes fresh usage of running assigned Workspaces only and rebuilds every scrape", async () => {
    const { collector, registry, connected, setSnapshot } = setup();
    registry.record({
      workerId: "worker-a",
      receivedAt: NOW,
      host: { cpuUtilization: 0.25, memoryTotalBytes: 16, memoryAvailableBytes: 8, load1: 1.5 },
      relay: RELAY,
      workspaces: [usage(RUNNING), usage(STOPPED), usage(OTHER)],
      assigned: new Set([RUNNING, STOPPED]),
    });
    let text = await collector.collect();
    const labels = `workspace_id="${RUNNING}",worker_id="worker-a"`;
    expect(line(text, `agent_runtime_workspace_cpu_seconds_total{${labels}}`)).toMatch(/ 12\.5$/);
    expect(line(text, `agent_runtime_workspace_memory_bytes{${labels}}`)).toMatch(/ 1024$/);
    expect(line(text, `agent_runtime_workspace_network_bytes_total{${labels},direction="tx"}`)).toMatch(/ 200$/);
    expect(line(text, `agent_runtime_workspace_oom_kills_total{${labels}}`)).toMatch(/ 1$/);
    // STOPPED in the database: its last sample is not shown; OTHER was never assigned.
    expect(text).not.toContain(`agent_runtime_workspace_memory_bytes{workspace_id="${STOPPED}"`);
    expect(text).not.toContain(OTHER);
    expect(line(text, 'agent_runtime_worker_host_cpu_utilization_ratio{worker_id="worker-a"}')).toMatch(/ 0\.25$/);
    expect(line(text, 'agent_runtime_model_relay_requests_total{worker_id="worker-a",result="gateway_unavailable"}')).toMatch(/ 2$/);
    expect(line(text, 'agent_runtime_model_relay_rejected_connections_total{worker_id="worker-a"}')).toMatch(/ 3$/);

    // The same cumulative value is reported again, not added up across scrapes.
    text = await collector.collect();
    expect(line(text, `agent_runtime_workspace_cpu_seconds_total{${labels}}`)).toMatch(/ 12\.5$/);

    // Deleted in the database: gone on the next scrape.
    setSnapshot(snapshot({ workspaceDisk: [] }));
    text = await collector.collect();
    expect(text).not.toContain(`workspace_id="${RUNNING}"`);

    // Worker disconnected: no host or usage series at all.
    setSnapshot(snapshot());
    connected.delete("worker-a");
    text = await collector.collect();
    expect(text).not.toMatch(/^agent_runtime_worker_host_/m);
    expect(text).not.toMatch(/^agent_runtime_workspace_cpu_seconds_total\{/m);
  });

  it("never puts names, emails, paths, addresses or tokens into the exposition", async () => {
    const { collector, metrics, registry } = setup();
    registry.record({
      workerId: "worker-a",
      receivedAt: NOW,
      host: { cpuUtilization: 0.1, memoryTotalBytes: 16, memoryAvailableBytes: 8, load1: 0 },
      relay: null,
      workspaces: [usage(RUNNING)],
      assigned: new Set([RUNNING]),
    });
    metrics.recordHttp("/api/workspaces/:id", "GET", 200, 0.01);
    metrics.recordHttp(undefined, "BREW", 404, 0.01);
    metrics.recordGatewayResponse("upstream", 200, 0.2);
    metrics.recordWorkerCommand("workspace.start", "timeout", 15);
    metrics.recordWorkerCommandError("workspace.start", "EGRESS_UNENFORCED");
    metrics.recordWorkerCommandError("workspace.start", "lower-case /etc/passwd");
    metrics.recordLoginFailure("oidc", "identity_not_bound");
    metrics.recordRateLimited("local_login", "local");
    metrics.recordLockout("login");
    const text = await collector.collect();
    for (const forbidden of ["@example", "alice", "/home/", "/etc/passwd", "192.168.", "Bearer", "BREW"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(line(text, 'agent_runtime_http_requests_total{route="unmatched",method="OTHER",status_class="4xx"}')).toMatch(/ 1$/);
    expect(line(text, 'agent_runtime_worker_command_errors_total{command="workspace.start",code="other"}')).toMatch(/ 1$/);
    const allowedLabels = new Set([
      "worker_id", "workspace_id", "user_id", "state", "status", "kind", "project", "direction",
      "scope", "collector", "route", "method", "status_class", "source", "result", "command", "code",
      "protocol", "category", "endpoint", "operation", "task", "version", "protocol_version", "le",
    ]);
    for (const series of text.split("\n").filter((entry) => entry.startsWith("agent_runtime_"))) {
      for (const match of series.matchAll(/([a-z_]+)="/g)) {
        expect(allowedLabels.has(match[1] ?? ""), `${match[1]} in ${series}`).toBe(true);
      }
    }
  });

  it("keeps concurrent scrapes independent", async () => {
    const { collector, registry } = setup();
    registry.record({
      workerId: "worker-a",
      receivedAt: NOW,
      host: { cpuUtilization: 0.1, memoryTotalBytes: 16, memoryAvailableBytes: 8, load1: 0 },
      relay: null,
      workspaces: [usage(RUNNING)],
      assigned: new Set([RUNNING]),
    });
    const outputs = await Promise.all([collector.collect(), collector.collect()]);
    for (const text of outputs) {
      const series = text.split("\n").filter((entry) => entry.startsWith("agent_runtime_workspace_memory_bytes{"));
      expect(series).toHaveLength(1);
      expect(text.match(/^# TYPE agent_runtime_workspaces gauge$/gm)).toHaveLength(1);
    }
  });
});

describe("usage registry (Phase 17.7)", () => {
  it("drops unassigned and future-dated samples and expires stale ones", () => {
    let now = NOW;
    const registry = new UsageRegistry(35_000, () => true, () => now);
    const { ignored } = registry.record({
      workerId: "worker-a",
      receivedAt: NOW,
      host: { cpuUtilization: 0.5, memoryTotalBytes: 16, memoryAvailableBytes: 8, load1: 0 },
      relay: null,
      workspaces: [
        usage(RUNNING),
        usage(OTHER),
        usage(STOPPED, { sampledAt: new Date(NOW.getTime() + 61_000).toISOString() }),
      ],
      assigned: new Set([RUNNING, STOPPED]),
    });
    expect(ignored).toBe(2);
    expect(registry.workspace(RUNNING, "worker-a")).toMatchObject({ cpuCores: 0.5, memoryBytes: 1_024 });
    expect(registry.workspace(RUNNING, "worker-b")).toBeNull();
    expect(registry.workspace(RUNNING, null)).toBeNull();
    expect(registry.worker("worker-a")).toMatchObject({
      hostCpuUtilization: 0.5,
      workspaceCpuCores: 0.5,
      workspaceMemoryBytes: 1_024,
      runningWorkspaces: 1,
    });
    now = new Date(NOW.getTime() + 36_000);
    expect(registry.workspace(RUNNING, "worker-a")).toBeNull();
    expect(registry.worker("worker-a")).toBeNull();
  });

  it("forgets a Worker and hides disconnected ones", () => {
    let connected = true;
    const registry = new UsageRegistry(35_000, () => connected, () => NOW);
    registry.record({
      workerId: "worker-a",
      receivedAt: NOW,
      host: { cpuUtilization: null, memoryTotalBytes: 16, memoryAvailableBytes: 8, load1: 0 },
      relay: null,
      workspaces: [usage(RUNNING)],
      assigned: new Set([RUNNING]),
    });
    connected = false;
    expect(registry.entries()).toEqual([]);
    connected = true;
    registry.forget("worker-a");
    expect(registry.entries()).toEqual([]);
  });
});
