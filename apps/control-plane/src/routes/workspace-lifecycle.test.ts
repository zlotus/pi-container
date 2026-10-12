import type { WorkspaceRecord } from "@agent-runtime/database";
import { describe, expect, it } from "vitest";

import { buildControlPlane } from "../app.js";
import {
  createTestDependencies,
  answerEgressApply,
  emptyReconciliation,
  login,
  NOW,
  ORIGIN,
  USER_A_ID,
  WORKER_1_TOKEN,
  WORKER_2_TOKEN,
  workerHello,
  TEST_WORKSPACE_DISK,
} from "./test-fixtures.js";

describe("Workspace Runtime lifecycle and Phase 5 placement", () => {
  it("binds only one eligible Worker and drives ensure, start, stop, and delete", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
    await app.ready();
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    const commands: string[] = [];
    worker.on("message", (data) => {
      if (answerEgressApply(worker, data)) return;
      const command = JSON.parse(data.toString()) as {
        requestId: string;
        type:
          | "worker.reconcile"
          | "workspace.ensure"
          | "workspace.start"
          | "workspace.stop"
          | "workspace.delete";
        payload: { workspaceId: string; assignments?: unknown[] };
      };
      if (command.type === "worker.reconcile") {
        worker.send(JSON.stringify(emptyReconciliation(command.requestId)));
        return;
      }
      commands.push(command.type);
      const state =
        command.type === "workspace.start"
          ? "RUNNING"
          : command.type === "workspace.ensure" || command.type === "workspace.stop"
            ? "STOPPED"
            : "CREATED";
      worker.send(
        JSON.stringify({
          version: 6,
          type: "response.ok",
          requestId: command.requestId,
          payload: {
            requestType: command.type,
            workspace: {
              workspaceId: command.payload.workspaceId,
              state,
              runtimeImage: "agent-runtime:test-unassigned",
              observedAt: NOW.toISOString(),
            },
          },
        }),
      );
    });
    worker.send(JSON.stringify(workerHello("worker-01")));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const owner = await login(app, "user-a", "password-for-user-a");
    const other = await login(app, "user-b", "password-for-user-b");
    const create = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: { name: "phase-3-runtime" },
    });
    const workspaceId = create.json<{ workspace: WorkspaceRecord }>().workspace.id;

    const foreignStart = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/start`,
      headers: {
        cookie: other.cookie,
        origin: ORIGIN,
        "x-csrf-token": other.csrfToken,
      },
      payload: {},
    });
    expect(foreignStart.statusCode).toBe(404);

    const start = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/start`,
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({
      workspace: { workerId: "worker-01", state: "RUNNING" },
    });

    const foreignOpen = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/open`,
      headers: {
        cookie: other.cookie,
        origin: ORIGIN,
        "x-csrf-token": other.csrfToken,
      },
      payload: {},
    });
    expect(foreignOpen.statusCode).toBe(404);

    const open = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/open`,
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: {},
    });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({
      exchangeUrl: `http://${workspaceId}.agent.test:3001/_platform/session`,
    });
    expect(open.json<{ code: string }>().code).toHaveLength(43);

    const ownerAudit = await app.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: { cookie: owner.cookie },
    });
    expect(ownerAudit.statusCode).toBe(200);
    expect(ownerAudit.json()).toMatchObject({
      events: [
        {
          eventType: "workspace.opened",
          workspaceId,
          workerId: "worker-01",
        },
      ],
    });
    const foreignAudit = await app.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: { cookie: other.cookie },
    });
    expect(foreignAudit.json()).toEqual({ events: [] });

    const foreignStop = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/stop`,
      headers: {
        cookie: other.cookie,
        origin: ORIGIN,
        "x-csrf-token": other.csrfToken,
      },
      payload: {},
    });
    expect(foreignStop.statusCode).toBe(404);

    const stop = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/stop`,
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: {},
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ workspace: { state: "STOPPED" } });

    const stoppedOpen = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/open`,
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: {},
    });
    expect(stoppedOpen.statusCode).toBe(409);

    const restart = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/start`,
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: {},
    });
    expect(restart.statusCode).toBe(200);
    expect(restart.json()).toMatchObject({
      workspace: { workerId: "worker-01", state: "RUNNING" },
    });

    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}`,
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
    });
    expect(deletion.statusCode).toBe(204);
    expect(commands).toEqual([
      "workspace.ensure",
      "workspace.start",
      "workspace.stop",
      "workspace.ensure",
      "workspace.start",
      "workspace.delete",
    ]);

    worker.close();
    await app.close();
  });

  it("selects deterministically when multiple equally loaded Workers are online", async () => {
    const app = buildControlPlane(await createTestDependencies());
    await app.ready();
    const worker1 = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    const worker2 = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_2_TOKEN}` },
    });
    const worker1Commands: string[] = [];
    const worker2Commands: string[] = [];
    worker1.on("message", (data) => {
      if (answerEgressApply(worker1, data)) return;
      const command = JSON.parse(data.toString()) as {
        requestId: string;
        type: "worker.reconcile" | "workspace.ensure" | "workspace.start";
        payload: { workspaceId: string };
      };
      if (command.type === "worker.reconcile") {
        worker1.send(JSON.stringify(emptyReconciliation(command.requestId)));
        return;
      }
      worker1Commands.push(command.type);
      worker1.send(
        JSON.stringify({
          version: 6,
          type: "response.ok",
          requestId: command.requestId,
          payload: {
            requestType: command.type,
            workspace: {
              workspaceId: command.payload.workspaceId,
              state: command.type === "workspace.start" ? "RUNNING" : "STOPPED",
              runtimeImage: "agent-runtime:test-unassigned",
              observedAt: NOW.toISOString(),
            },
          },
        }),
      );
    });
    worker2.on("message", (data) => {
      if (answerEgressApply(worker2, data)) return;
      const command = JSON.parse(data.toString()) as {
        requestId: string;
        type: "worker.reconcile" | "workspace.ensure" | "workspace.start";
        payload: { workspaceId: string };
      };
      if (command.type === "worker.reconcile") {
        worker2.send(JSON.stringify(emptyReconciliation(command.requestId)));
        return;
      }
      worker2Commands.push(command.type);
      worker2.send(
        JSON.stringify({
          version: 6,
          type: "response.ok",
          requestId: command.requestId,
          payload: {
            requestType: command.type,
            workspace: {
              workspaceId: command.payload.workspaceId,
              state: command.type === "workspace.start" ? "RUNNING" : "STOPPED",
              runtimeImage: "agent-runtime:test-unassigned",
              observedAt: NOW.toISOString(),
            },
          },
        }),
      );
    });
    worker1.send(JSON.stringify(workerHello("worker-01")));
    worker2.send(JSON.stringify(workerHello("worker-02")));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const owner = await login(app, "user-a", "password-for-user-a");
    const create = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: { name: "multi-worker-placement" },
    });
    const workspaceId = create.json<{ workspace: WorkspaceRecord }>().workspace.id;
    const start = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/start`,
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: {},
    });

    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({
      workspace: { workerId: "worker-01", state: "RUNNING" },
    });
    const secondCreate = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: { name: "multi-worker-placement-2" },
    });
    const secondWorkspaceId = secondCreate.json<{ workspace: WorkspaceRecord }>()
      .workspace.id;
    const secondStart = await app.inject({
      method: "POST",
      url: `/api/workspaces/${secondWorkspaceId}/start`,
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: {},
    });
    expect(secondStart.statusCode).toBe(200);
    expect(secondStart.json()).toMatchObject({
      workspace: { workerId: "worker-02", state: "RUNNING" },
    });
    expect(worker1Commands).toEqual(["workspace.ensure", "workspace.start"]);
    expect(worker2Commands).toEqual(["workspace.ensure", "workspace.start"]);
    worker1.close();
    worker2.close();
    await app.close();
  });

  it("never starts a Workspace on a Worker that cannot enforce the egress policy", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
    await app.ready();
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    const commands: string[] = [];
    let enforce = true;
    worker.on("message", (data) => {
      if (answerEgressApply(worker, data, enforce)) return;
      const command = JSON.parse(data.toString()) as { requestId: string; type: string };
      if (command.type === "worker.reconcile") {
        worker.send(JSON.stringify(emptyReconciliation(command.requestId)));
        return;
      }
      commands.push(command.type);
    });
    worker.send(JSON.stringify(workerHello("worker-01")));
    await expect
      .poll(() => dependencies.testState.workers[0]?.egress.enforced)
      .toBe(true);

    const owner = await login(app, "user-a", "password-for-user-a");
    const headers = { cookie: owner.cookie, origin: ORIGIN, "x-csrf-token": owner.csrfToken };
    const create = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers,
      payload: { name: "egress-gated" },
    });
    const workspaceId = create.json<{ workspace: WorkspaceRecord }>().workspace.id;

    enforce = false;
    const start = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/start`,
      headers,
      payload: {},
    });
    expect(start.statusCode).toBe(503);
    expect(start.json()).toMatchObject({ error: { code: "EGRESS_UNENFORCED" } });
    expect(commands).toEqual([]);
    expect(
      dependencies.testState.workspaces.find((workspace) => workspace.id === workspaceId),
    ).toMatchObject({ state: "ERROR", workerId: "worker-01" });

    // Once the Worker no longer reports enforcement, it gets no new placements either.
    const second = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers,
      payload: { name: "egress-unplaced" },
    });
    const secondId = second.json<{ workspace: WorkspaceRecord }>().workspace.id;
    const unplaced = await app.inject({
      method: "POST",
      url: `/api/workspaces/${secondId}/start`,
      headers,
      payload: {},
    });
    expect(unplaced.json()).toMatchObject({ error: { code: "NO_ELIGIBLE_WORKER" } });
    worker.terminate();
    await app.close();
  });

  it("marks running Workspaces ERROR when the Worker reports lost egress rules", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
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
    await expect
      .poll(() => dependencies.testState.workers[0]?.egress.enforced)
      .toBe(true);
    dependencies.testState.workspaces.push({
      id: "8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a10",
      userId: USER_A_ID,
      name: "running",
      workerId: "worker-01",
      state: "RUNNING",
      runtimeImage: "agent-runtime:test-unassigned",
      createdAt: NOW,
      updatedAt: NOW,
      lastActivityAt: NOW,
      previousRuntimeImage: null,
      runtimeChangedAt: null,
      lastAccessAt: null,
      lastStopReason: null,
      disk: TEST_WORKSPACE_DISK,
    });

    worker.send(
      JSON.stringify({
        version: 6,
        type: "worker.heartbeat",
        requestId: crypto.randomUUID(),
        payload: {
          workerId: "worker-01",
          allocatedWorkspaces: 1,
          egress: { enforced: false, revision: 0 },
          storage: { enforced: true, fsType: "xfs", totalBytes: 2 ** 40, freeBytes: 2 ** 39 },
          modelRelay: { enabled: false, port: null, listening: false },
          host: { cpuUtilization: null, memoryTotalBytes: 8, memoryAvailableBytes: 4, load1: 0 },
          observedAt: NOW.toISOString(),
        },
      }),
    );
    await expect
      .poll(() => dependencies.testState.workspaces.at(-1)?.state)
      .toBe("ERROR");
    worker.terminate();
    await app.close();
  });

  it("marks running Workspaces ERROR when the Worker loses disk quotas and keeps usage", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
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
    await expect
      .poll(() => dependencies.testState.workers[0]?.storage.enforced)
      .toBe(true);
    const ownId = "8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a11";
    const foreignId = "8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a12";
    for (const [id, workerId] of [
      [ownId, "worker-01"],
      [foreignId, "worker-02"],
    ] as const) {
      dependencies.testState.workspaces.push({
        id,
        userId: USER_A_ID,
        name: id.slice(-4),
        workerId,
        state: "RUNNING",
        runtimeImage: "agent-runtime:test-unassigned",
        createdAt: NOW,
        updatedAt: NOW,
        lastActivityAt: NOW,
        previousRuntimeImage: null,
        runtimeChangedAt: null,
        lastAccessAt: null,
        lastStopReason: null,
        disk: TEST_WORKSPACE_DISK,
      });
    }
    const usage = (workspaceId: string) => ({
      workspaceId,
      dataUsedBytes: 5 * 1024 ** 3,
      dataLimitBytes: 20 * 1024 ** 3,
      dataUsedInodes: 1234,
      piUsedBytes: 1024 ** 2,
      piLimitBytes: 2 * 1024 ** 3,
    });

    worker.send(
      JSON.stringify({
        version: 6,
        type: "worker.heartbeat",
        requestId: crypto.randomUUID(),
        payload: {
          workerId: "worker-01",
          allocatedWorkspaces: 1,
          egress: { enforced: true, revision: 0 },
          storage: { enforced: false, fsType: "ext4", totalBytes: null, freeBytes: null },
          modelRelay: { enabled: false, port: null, listening: false },
          host: { cpuUtilization: null, memoryTotalBytes: 8, memoryAvailableBytes: 4, load1: 0 },
          workspaceDisk: [usage(ownId), usage(foreignId)],
          observedAt: NOW.toISOString(),
        },
      }),
    );
    const own = () => dependencies.testState.workspaces.find((entry) => entry.id === ownId);
    const foreign = () => dependencies.testState.workspaces.find((entry) => entry.id === foreignId);
    await expect.poll(() => own()?.state).toBe("ERROR");
    expect(own()?.disk).toMatchObject({ usedBytes: 5 * 1024 ** 3, usedInodes: 1234 });
    // A Worker cannot report (or change) usage of a Workspace assigned elsewhere.
    expect(foreign()?.state).toBe("RUNNING");
    expect(foreign()?.disk.usedBytes).toBeNull();
    worker.terminate();
    await app.close();
  });
});
