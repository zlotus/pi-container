import { describe, expect, it } from "vitest";

import { buildControlPlane } from "../app.js";
import { PlatformMetrics } from "../metrics/platform-metrics.js";
import {
  ADMIN_ID,
  answerEgressApply,
  createTestDependencies,
  emptyReconciliation,
  login,
  NOW,
  ORIGIN,
  TEST_WORKSPACE_DISK,
  USER_A_ID,
  USER_B_ID,
  WORKER_1_TOKEN,
  workerHello,
} from "./test-fixtures.js";

const OWN = "8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a21";
const STOPPED = "8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a22";
const FOREIGN = "8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a23";

async function value(metrics: PlatformMetrics, series: string): Promise<number> {
  const line = (await metrics.registry.metrics())
    .split("\n")
    .find((candidate) => candidate.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
}

function workspace(id: string, userId: string, workerId: string, state: "RUNNING" | "STOPPED") {
  return {
    id,
    userId,
    name: id.slice(-4),
    workerId,
    state,
    runtimeImage: "agent-runtime:test-unassigned",
    createdAt: NOW,
    updatedAt: NOW,
    lastActivityAt: NOW,
    previousRuntimeImage: null,
    runtimeChangedAt: null,
    lastAccessAt: null,
    lastStopReason: null,
    disk: TEST_WORKSPACE_DISK,
  };
}

function usage(workspaceId: string) {
  return {
    workspaceId,
    sampledAt: NOW.toISOString(),
    cpuUsageNanos: 5_000_000_000,
    cpuCores: 1.25,
    cpuLimitCores: 2,
    memoryBytes: 1024 ** 3,
    memoryLimitBytes: 4 * 1024 ** 3,
    pids: 30,
    pidsLimit: 512,
    networkRxBytes: 10,
    networkTxBytes: 20,
    oomKills: 1,
  };
}

describe("Portal API metrics (Phase 17.4)", () => {
  it("labels requests by route template and never serves /metrics on the Portal port", async () => {
    const metrics = new PlatformMetrics();
    const dependencies = await createTestDependencies([workspace(OWN, USER_A_ID, "worker-01", "RUNNING")]);
    const app = buildControlPlane({ ...dependencies, metrics });
    const { cookie } = await login(app, "a@example.test", "password-for-user-a");
    expect((await app.inject({ method: "GET", url: `/api/workspaces/${OWN}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
    const text = await metrics.registry.metrics();
    expect(text).toContain('agent_runtime_http_requests_total{route="/api/workspaces/:id",method="GET",status_class="2xx"} 1');
    expect(text).toContain('route="unmatched",method="GET",status_class="4xx"');
    expect(text).not.toContain(OWN);
    expect(text).not.toContain("a@example.test");
    await app.close();
  });

  it("counts logins, failures, lockouts and refusals while locked", async () => {
    const metrics = new PlatformMetrics();
    const app = buildControlPlane({ ...(await createTestDependencies()), metrics });
    await login(app, "a@example.test", "password-for-user-a");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: ORIGIN },
        payload: { login: "b@example.test", password: "wrong-password" },
      });
      expect(response.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "b@example.test", password: "password-for-user-b" },
    });
    expect(locked.statusCode).toBe(429);
    expect(await value(metrics, 'agent_runtime_auth_logins_total{protocol="local",result="success"}')).toBe(1);
    expect(await value(metrics, 'agent_runtime_auth_logins_total{protocol="local",result="failure"}')).toBe(5);
    expect(await value(metrics, 'agent_runtime_auth_login_failures_total{protocol="local",category="invalid_credentials"}')).toBe(5);
    expect(await value(metrics, 'agent_runtime_auth_lockouts_total{scope="login_ip"}')).toBe(1);
    expect(await value(metrics, 'agent_runtime_auth_rate_limited_total{endpoint="local_login"}')).toBe(1);
    expect(await value(metrics, 'agent_runtime_auth_logins_total{protocol="local",result="rate_limited"}')).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain("b@example.test");
    await app.close();
  });
});

describe("observed usage in the API (Phase 17.7)", () => {
  it("shows a running Workspace's fresh usage to its owner and admins only", async () => {
    const metrics = new PlatformMetrics();
    const dependencies = await createTestDependencies([
      workspace(OWN, USER_A_ID, "worker-01", "RUNNING"),
      workspace(STOPPED, USER_A_ID, "worker-01", "STOPPED"),
      workspace(FOREIGN, USER_B_ID, "worker-02", "RUNNING"),
    ]);
    const app = buildControlPlane({ ...dependencies, metrics });
    await app.ready();
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    worker.on("message", (data) => {
      if (answerEgressApply(worker, data)) return;
      const command = JSON.parse(data.toString()) as { requestId: string; type: string };
      if (command.type === "worker.reconcile") {
        worker.send(JSON.stringify(emptyReconciliation(command.requestId)));
      }
    });
    worker.send(JSON.stringify(workerHello("worker-01")));
    await expect.poll(() => dependencies.testState.workers[0]?.status).toBe("ONLINE");
    // The empty reconciliation report changes the fixtures' states; restore the scenario.
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const entry of dependencies.testState.workspaces) {
      entry.state = entry.id === STOPPED ? "STOPPED" : "RUNNING";
    }
    worker.send(
      JSON.stringify({
        version: 6,
        type: "worker.heartbeat",
        requestId: crypto.randomUUID(),
        payload: {
          workerId: "worker-01",
          allocatedWorkspaces: 2,
          egress: { enforced: true, revision: 0 },
          storage: { enforced: true, fsType: "xfs", totalBytes: 2 ** 40, freeBytes: 2 ** 39 },
          modelRelay: { enabled: false, port: null, listening: false },
          host: { cpuUtilization: 0.5, memoryTotalBytes: 16 * 1024 ** 3, memoryAvailableBytes: 8 * 1024 ** 3, load1: 2 },
          workspaceUsage: [usage(OWN), usage(STOPPED), usage(FOREIGN)],
          observedAt: NOW.toISOString(),
        },
      }),
    );
    await expect
      .poll(() => value(metrics, 'agent_runtime_worker_heartbeats_total{worker_id="worker-01",result="accepted"}'))
      .toBe(1);

    const owner = await login(app, "a@example.test", "password-for-user-a");
    const own = (await app.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: owner.cookie } }))
      .json<{ workspaces: Array<{ id: string; usage: unknown }> }>().workspaces;
    expect(own.find((entry) => entry.id === OWN)?.usage).toEqual({
      cpuCores: 1.25,
      cpuLimitCores: 2,
      memoryBytes: 1024 ** 3,
      memoryLimitBytes: 4 * 1024 ** 3,
      pids: 30,
      pidsLimit: 512,
      oomKills: 1,
      sampledAt: NOW.toISOString(),
    });
    // Stopped after the last heartbeat: the still-fresh sample is no longer shown.
    const ownRecord = dependencies.testState.workspaces.find((entry) => entry.id === OWN);
    if (ownRecord === undefined) throw new Error("fixture missing");
    ownRecord.state = "STOPPED";
    expect(
      (await app.inject({ method: "GET", url: `/api/workspaces/${OWN}`, headers: { cookie: owner.cookie } }))
        .json<{ workspace: { usage: unknown } }>().workspace.usage,
    ).toBeNull();
    ownRecord.state = "RUNNING";
    // The STOPPED Workspace was not running, so its sample was refused.
    expect(own.find((entry) => entry.id === STOPPED)?.usage).toBeNull();

    // Worker-01 claimed a sample for another Worker's Workspace; it is never shown.
    const other = await login(app, "b@example.test", "password-for-user-b");
    const foreign = (await app.inject({ method: "GET", url: `/api/workspaces/${FOREIGN}`, headers: { cookie: other.cookie } }))
      .json<{ workspace: { usage: unknown } }>();
    expect(foreign.workspace.usage).toBeNull();
    expect((await app.inject({ method: "GET", url: `/api/workspaces/${OWN}`, headers: { cookie: other.cookie } })).statusCode)
      .toBe(404);

    const admin = await login(app, "admin@example.test", "password-for-admin");
    const adminWorkspaces = (await app.inject({ method: "GET", url: "/api/admin/workspaces", headers: { cookie: admin.cookie } }))
      .json<{ workspaces: Array<{ id: string; usage: { cpuCores: number } | null }> }>().workspaces;
    expect(adminWorkspaces.find((entry) => entry.id === OWN)?.usage?.cpuCores).toBe(1.25);
    const workers = (await app.inject({ method: "GET", url: "/api/admin/workers", headers: { cookie: admin.cookie } }))
      .json<{ workers: Array<{ id: string; usage: Record<string, unknown> | null }> }>().workers;
    expect(workers.find((entry) => entry.id === "worker-01")?.usage).toMatchObject({
      hostCpuUtilization: 0.5,
      workspaceCpuCores: 1.25,
      workspaceMemoryBytes: 1024 ** 3,
      runningWorkspaces: 1,
    });
    expect(ADMIN_ID).toBeDefined();

    // Disconnected: no usage at all.
    worker.terminate();
    await expect
      .poll(async () =>
        (await app.inject({ method: "GET", url: `/api/workspaces/${OWN}`, headers: { cookie: owner.cookie } }))
          .json<{ workspace: { usage: unknown } }>().workspace.usage,
      )
      .toBeNull();
    await app.close();
  });
});
