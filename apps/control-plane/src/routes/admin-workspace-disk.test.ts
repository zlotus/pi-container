import { describe, expect, it } from "vitest";

import { buildControlPlane } from "../app.js";
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
  WORKER_1_TOKEN,
  workerHello,
} from "./test-fixtures.js";

const GIB = 1024 ** 3;
const WORKSPACE_ID = "6a8c2f9e-3a8f-4c7e-9a64-0f5d2b1c4e01";

async function setup() {
  const dependencies = await createTestDependencies([
    {
      id: WORKSPACE_ID,
      userId: USER_A_ID,
      name: "disk",
      workerId: "worker-01",
      state: "STOPPED",
      runtimeImage: "agent-runtime:test-unassigned",
      createdAt: NOW,
      updatedAt: NOW,
      lastActivityAt: NOW,
      previousRuntimeImage: null,
      runtimeChangedAt: null,
      lastAccessAt: null,
      lastStopReason: null,
      disk: { ...TEST_WORKSPACE_DISK, usedBytes: 3 * GIB, sampledAt: NOW },
    },
  ]);
  const app = buildControlPlane(dependencies);
  const admin = await login(app, "admin", "password-for-admin");
  const patch = (diskLimitBytes: unknown, session = admin, id = WORKSPACE_ID) =>
    app.inject({
      method: "PATCH",
      url: `/api/admin/workspaces/${id}`,
      headers: { cookie: session.cookie, origin: ORIGIN, "x-csrf-token": session.csrfToken },
      payload: { diskLimitBytes },
    });
  return { dependencies, app, admin, patch };
}

describe("Workspace disk limits", () => {
  it("shows the owner the limit and the latest usage sample", async () => {
    const { app } = await setup();
    const user = await login(app, "user-a", "password-for-user-a");
    const listed = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: user.cookie },
    });
    expect(listed.json<{ workspaces: unknown[] }>().workspaces).toEqual([
      expect.objectContaining({
        id: WORKSPACE_ID,
        disk: {
          limitBytes: 20 * GIB,
          usedBytes: 3 * GIB,
          usedInodes: null,
          piUsedBytes: null,
          piLimitBytes: null,
          sampledAt: NOW.toISOString(),
        },
      }),
    ]);
    // Nothing about the Worker's filesystem, paths or quota projects reaches users.
    expect(listed.body).not.toMatch(/projectId|\/var\/lib|fsType/);
    await app.close();
  });

  it("lets only administrators change a limit, within range and with CSRF", async () => {
    const { app, patch } = await setup();
    const user = await login(app, "user-a", "password-for-user-a");
    expect((await patch(30 * GIB, user)).statusCode).toBe(403);
    const anonymous = await app.inject({
      method: "PATCH",
      url: `/api/admin/workspaces/${WORKSPACE_ID}`,
      headers: { origin: ORIGIN },
      payload: { diskLimitBytes: 30 * GIB },
    });
    expect(anonymous.statusCode).toBe(401);
    const admin = await login(app, "admin", "password-for-admin");
    const noCsrf = await app.inject({
      method: "PATCH",
      url: `/api/admin/workspaces/${WORKSPACE_ID}`,
      headers: { cookie: admin.cookie, origin: ORIGIN },
      payload: { diskLimitBytes: 30 * GIB },
    });
    expect(noCsrf.statusCode).toBe(403);
    for (const invalid of [GIB - 1, 1025 * GIB]) {
      const response = await patch(invalid);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "DISK_LIMIT_OUT_OF_RANGE" } });
    }
    expect((await patch(GIB + 0.5)).statusCode).toBe(400);
    expect((await patch("30G")).statusCode).toBe(400);
    expect(
      (await patch(30 * GIB, admin, "6a8c2f9e-3a8f-4c7e-9a64-0f5d2b1c4eff")).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("stores the limit and records it even when the Worker is offline", async () => {
    const { dependencies, app, patch } = await setup();
    const response = await patch(2 * GIB);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workspace: { id: WORKSPACE_ID, disk: { limitBytes: 2 * GIB } },
      applied: false,
    });
    const events = await dependencies.store.listAuditEvents({
      userId: ADMIN_ID,
      includeAllUsers: true,
      limit: 10,
      beforeId: null,
    });
    expect(events[0]).toMatchObject({
      eventType: "workspace.storage_limit_changed",
      actorUserId: ADMIN_ID,
      ownerUserId: USER_A_ID,
      workspaceId: WORKSPACE_ID,
      details: { previousLimitBytes: 20 * GIB, limitBytes: 2 * GIB },
    });
    await app.close();
  });

  it("applies the limit on a connected Worker without restarting the Workspace", async () => {
    const { app, patch } = await setup();
    await app.ready();
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    const commands: Array<{ type: string; payload: unknown }> = [];
    worker.on("message", (data) => {
      if (answerEgressApply(worker, data)) return;
      const command = JSON.parse(data.toString()) as {
        requestId: string;
        type: string;
        payload: { workspaceId: string; diskLimitBytes: number };
      };
      commands.push(command);
      if (command.type === "worker.reconcile") {
        worker.send(JSON.stringify(emptyReconciliation(command.requestId)));
      } else if (command.type === "workspace.storage.set") {
        worker.send(
          JSON.stringify({
            version: 6,
            type: "response.ok",
            requestId: command.requestId,
            payload: {
              requestType: "workspace.storage.set",
              storage: {
                workspaceId: command.payload.workspaceId,
                dataLimitBytes: command.payload.diskLimitBytes,
                dataUsedBytes: 3 * GIB,
              },
            },
          }),
        );
      }
    });
    worker.send(JSON.stringify(workerHello("worker-01")));
    await expect.poll(() => commands.some((entry) => entry.type === "worker.reconcile")).toBe(true);

    const response = await patch(50 * GIB);
    expect(response.json()).toMatchObject({ applied: true });
    expect(commands.filter((entry) => entry.type.startsWith("workspace."))).toEqual([
      {
        type: "workspace.storage.set",
        payload: { workspaceId: WORKSPACE_ID, diskLimitBytes: 50 * GIB },
        requestId: expect.any(String),
        version: 6,
      },
    ]);
    worker.terminate();
    await app.close();
  });
});
