import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { WorkspaceRecord } from "@agent-runtime/database";
import { describe, expect, it } from "vitest";

import { buildControlPlane } from "../app.js";
import {
  createTestDependencies,
  emptyReconciliation,
  login,
  NOW,
  ORIGIN,
  USER_A_ID,
  WORKER_1_TOKEN,
  WORKER_2_TOKEN,
  workerHello,
} from "./test-fixtures.js";

describe("Phase 2 worker control channel", () => {
  it("rejects an unknown Worker credential during the WebSocket handshake", async () => {
    const app = buildControlPlane(await createTestDependencies());
    await app.ready();

    await expect(
      app.injectWS("/api/workers/connect", {
        headers: {
          authorization:
            "Bearer unknownworker0123456789abcdef0123456789abcdef",
        },
      }),
    ).rejects.toThrow();
    await app.close();
  });

  it("binds credentials to Worker IDs and accepts two concurrent Workers", async () => {
    const app = buildControlPlane(await createTestDependencies());
    await app.ready();
    const worker1 = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    const worker2 = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_2_TOKEN}` },
    });
    worker1.send(JSON.stringify(workerHello("worker-01")));
    worker2.send(JSON.stringify(workerHello("worker-02")));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const admin = await login(app, "admin", "password-for-admin");
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/workers",
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workers: [
        { id: "worker-01", status: "ONLINE", architecture: "arm64" },
        { id: "worker-02", status: "ONLINE", architecture: "arm64" },
      ],
    });

    worker1.close();
    worker2.close();
    await app.close();
  });

  it("closes a credential that claims another pre-registered Worker ID", async () => {
    const app = buildControlPlane(await createTestDependencies());
    await app.ready();
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    const closed = once(worker, "close");
    worker.send(JSON.stringify(workerHello("worker-02")));

    const [code] = await closed;
    expect(code).toBe(1008);
    await app.close();
  });

  it("revokes an established channel on its next message after rotation", async () => {
    const dependencies = await createTestDependencies();
    const findCredential =
      dependencies.workerStore.findWorkerByCredentialHash;
    let credentialRotated = false;
    dependencies.workerStore.findWorkerByCredentialHash = async (
      credentialHash,
    ) => (credentialRotated ? null : findCredential(credentialHash));
    const app = buildControlPlane(dependencies);
    await app.ready();
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    worker.send(JSON.stringify(workerHello("worker-01")));
    await new Promise<void>((resolve) => setImmediate(resolve));
    credentialRotated = true;
    const closed = once(worker, "close");
    worker.send(
      JSON.stringify({
        version: 1,
        type: "worker.heartbeat",
        requestId: randomUUID(),
        payload: {
          workerId: "worker-01",
          allocatedWorkspaces: 0,
          observedAt: NOW.toISOString(),
        },
      }),
    );

    const [code] = await closed;
    expect(code).toBe(1008);
    await app.close();
  });

  it("restricts the Worker inventory to admins and derives Offline by age", async () => {
    const dependencies = await createTestDependencies();
    const workers = dependencies.testState.workers;
    const first = workers[0];
    const second = workers[1];
    if (first === undefined || second === undefined) throw new Error("fixture missing");
    first.lastHeartbeatAt = NOW;
    second.lastHeartbeatAt = new Date(NOW.getTime() - 35_000);
    const app = buildControlPlane(dependencies);
    const user = await login(app, "user-a", "password-for-user-a");
    const admin = await login(app, "admin", "password-for-admin");

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/workers",
      headers: { cookie: user.cookie },
    });
    const allowed = await app.inject({
      method: "GET",
      url: "/api/admin/workers",
      headers: { cookie: admin.cookie },
    });

    expect(forbidden.statusCode).toBe(403);
    expect(allowed.json()).toMatchObject({
      workers: [
        { id: "worker-01", status: "ONLINE" },
        { id: "worker-02", status: "OFFLINE" },
      ],
    });
    await app.close();
  });

  it("lets only an admin pause or resume Worker scheduling with Origin, CSRF, and audit", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
    const user = await login(app, "user-a", "password-for-user-a");
    const admin = await login(app, "admin", "password-for-admin");
    const patch = (
      session: { cookie: string; csrfToken: string },
      url: string,
      payload: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.inject({
        method: "PATCH",
        url,
        headers: {
          cookie: session.cookie,
          origin: ORIGIN,
          "x-csrf-token": session.csrfToken,
          ...headers,
        },
        payload: payload as Record<string, unknown>,
      });

    expect((await patch(user, "/api/admin/workers/worker-01", { schedulable: false })).statusCode)
      .toBe(403);
    expect(
      (await patch(admin, "/api/admin/workers/worker-01", { schedulable: false }, {
        "x-csrf-token": "wrong",
      })).statusCode,
    ).toBe(403);
    expect(
      (await patch(admin, "/api/admin/workers/worker-01", { schedulable: false }, {
        origin: "https://attacker.test",
      })).statusCode,
    ).toBe(403);
    expect((await patch(admin, "/api/admin/workers/worker-01", { schedulable: "no" })).statusCode)
      .toBe(400);
    expect(
      (await patch(admin, "/api/admin/workers/worker-01", { schedulable: false, enabled: false }))
        .statusCode,
    ).toBe(400);
    expect((await patch(admin, "/api/admin/workers/Bad..ID", { schedulable: false })).statusCode)
      .toBe(400);
    expect((await patch(admin, "/api/admin/workers/worker-99", { schedulable: false })).json())
      .toMatchObject({ error: { code: "WORKER_NOT_FOUND" } });
    expect(dependencies.testState.workers[0]?.schedulable).toBe(true);

    const paused = await patch(admin, "/api/admin/workers/worker-01", { schedulable: false });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({
      worker: { id: "worker-01", schedulable: false, enabled: true },
    });
    // Repeating the same state is idempotent and does not add another audit event.
    await patch(admin, "/api/admin/workers/worker-01", { schedulable: false });
    await patch(admin, "/api/admin/workers/worker-01", { schedulable: true });

    const audit = await app.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: { cookie: admin.cookie },
    });
    const schedulingEvents = audit
      .json<{ events: Array<{ eventType: string; workerId: string | null; actorUserId: string | null }> }>()
      .events.filter((event) => event.eventType.startsWith("worker.scheduling_"));
    expect(schedulingEvents.map((event) => event.eventType)).toEqual([
      "worker.scheduling_resumed",
      "worker.scheduling_paused",
    ]);
    expect(schedulingEvents[0]).toMatchObject({ workerId: "worker-01" });
    expect(schedulingEvents[0]?.actorUserId).not.toBeNull();
    await app.close();
  });

  it("keeps a paused Worker out of new placements while its sticky Workspace still starts", async () => {
    const stickyWorkspaceId = "44444444-4444-4444-8444-444444444444";
    const dependencies = await createTestDependencies([
      {
        id: stickyWorkspaceId,
        userId: USER_A_ID,
        name: "sticky-on-paused-worker",
        workerId: "worker-01",
        state: "STOPPED",
        runtimeImage: "agent-runtime:test-unassigned",
        createdAt: NOW,
        updatedAt: NOW,
        lastActivityAt: NOW,
      },
    
      {
        // Balances the load so worker-01 would win the ID tie-break if it were schedulable.
        id: "55555555-5555-4555-8555-555555555555",
        userId: USER_A_ID,
        name: "load-on-worker-02",
        workerId: "worker-02",
        state: "STOPPED",
        runtimeImage: "agent-runtime:test-unassigned",
        createdAt: NOW,
        updatedAt: NOW,
        lastActivityAt: NOW,
      },
    ]);
    const app = buildControlPlane(dependencies);
    await app.ready();
    const commands: Record<string, string[]> = { "worker-01": [], "worker-02": [] };
    const connect = async (token: string, workerId: string) => {
      const socket = await app.injectWS("/api/workers/connect", {
        headers: { authorization: `Bearer ${token}` },
      });
      socket.on("message", (data) => {
        const command = JSON.parse(data.toString()) as {
          requestId: string;
          type: "worker.reconcile" | "workspace.ensure" | "workspace.start";
          payload: { workspaceId: string };
        };
        if (command.type === "worker.reconcile") {
          socket.send(JSON.stringify(emptyReconciliation(command.requestId)));
          return;
        }
        commands[workerId]?.push(`${command.type}:${command.payload.workspaceId}`);
        socket.send(JSON.stringify({
          version: 1,
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
        }));
      });
      socket.send(JSON.stringify(workerHello(workerId)));
      return socket;
    };
    const worker1 = await connect(WORKER_1_TOKEN, "worker-01");
    const worker2 = await connect(WORKER_2_TOKEN, "worker-02");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const sticky = dependencies.testState.workspaces.find(
      (workspace) => workspace.id === stickyWorkspaceId,
    );
    // Force a startable state regardless of how reconciliation classified the empty inventory.
    if (sticky !== undefined) sticky.state = "STOPPED";

    const admin = await login(app, "admin", "password-for-admin");
    const pause = await app.inject({
      method: "PATCH",
      url: "/api/admin/workers/worker-01",
      headers: { cookie: admin.cookie, origin: ORIGIN, "x-csrf-token": admin.csrfToken },
      payload: { schedulable: false },
    });
    expect(pause.statusCode).toBe(200);

    const owner = await login(app, "user-a", "password-for-user-a");
    const ownerHeaders = {
      cookie: owner.cookie,
      origin: ORIGIN,
      "x-csrf-token": owner.csrfToken,
    };
    const create = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: ownerHeaders,
      payload: { name: "placed-after-pause" },
    });
    const newWorkspaceId = create.json<{ workspace: WorkspaceRecord }>().workspace.id;
    const newStart = await app.inject({
      method: "POST",
      url: `/api/workspaces/${newWorkspaceId}/start`,
      headers: ownerHeaders,
      payload: {},
    });
    expect(newStart.json()).toMatchObject({
      workspace: { workerId: "worker-02", state: "RUNNING" },
    });

    const stickyStart = await app.inject({
      method: "POST",
      url: `/api/workspaces/${stickyWorkspaceId}/start`,
      headers: ownerHeaders,
      payload: {},
    });
    expect(stickyStart.json()).toMatchObject({
      workspace: { workerId: "worker-01", state: "RUNNING" },
    });
    expect(commands["worker-01"]?.every((entry) => entry.endsWith(stickyWorkspaceId))).toBe(true);
    expect(commands["worker-02"]?.every((entry) => entry.endsWith(newWorkspaceId))).toBe(true);
    worker1.close();
    worker2.close();
    await app.close();
  });
});
