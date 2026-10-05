import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { WorkspaceRecord } from "@agent-runtime/database";
import { describe, expect, it, vi } from "vitest";

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

describe("Phase 6 Worker recovery reconciliation", () => {
  it("keeps an assigned Workspace closed until full inventory confirms its Runtime", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
    await app.ready();
    const firstWorker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    firstWorker.on("message", (data) => {
      const command = JSON.parse(data.toString()) as {
        requestId: string;
        type: "worker.reconcile" | "workspace.ensure" | "workspace.start";
        payload: { workspaceId: string };
      };
      if (command.type === "worker.reconcile") {
        firstWorker.send(JSON.stringify(emptyReconciliation(command.requestId)));
        return;
      }
      firstWorker.send(
        JSON.stringify({
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
        }),
      );
    });
    firstWorker.send(JSON.stringify(workerHello("worker-01")));
    await vi.waitFor(() => {
      expect(dependencies.testState.workers[0]?.status).toBe("ONLINE");
    });
    const otherWorker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_2_TOKEN}` },
    });
    const otherWorkerCommands: string[] = [];
    otherWorker.on("message", (data) => {
      const command = JSON.parse(data.toString()) as {
        requestId: string;
        type: string;
      };
      if (command.type === "worker.reconcile") {
        otherWorker.send(JSON.stringify(emptyReconciliation(command.requestId)));
      } else {
        otherWorkerCommands.push(command.type);
      }
    });
    otherWorker.send(JSON.stringify(workerHello("worker-02")));
    await vi.waitFor(() => {
      expect(dependencies.testState.workers[1]?.status).toBe("ONLINE");
    });

    const owner = await login(app, "user-a", "password-for-user-a");
    const create = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: { name: "reconnect-running" },
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
    expect(start.json()).toMatchObject({ workspace: { state: "RUNNING" } });

    const firstClosed = once(firstWorker, "close");
    firstWorker.close();
    await firstClosed;
    const assignedWorker = dependencies.testState.workers[0];
    if (assignedWorker === undefined) throw new Error("Worker fixture missing");
    assignedWorker.lastHeartbeatAt = new Date(NOW.getTime() - 35_000);
    expect(
      dependencies.testState.markWorkersOffline(new Date(NOW.getTime() - 1)),
    ).toBe(1);
    expect(dependencies.testState.workspaces[0]?.state).toBe("WORKER_OFFLINE");
    expect(dependencies.testState.workspaces[0]?.workerId).toBe("worker-01");

    const reconnectedWorker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    let reconcileCommand:
      | {
          requestId: string;
          assignments: Array<{ workspaceId: string; desiredState: string }>;
        }
      | undefined;
    const reconnectCommands: string[] = [];
    reconnectedWorker.on("message", (data) => {
      const command = JSON.parse(data.toString()) as {
        requestId: string;
        type: "worker.reconcile";
        payload: {
          assignments: Array<{ workspaceId: string; desiredState: string }>;
        };
      };
      reconnectCommands.push(command.type);
      reconcileCommand = {
        requestId: command.requestId,
        assignments: command.payload.assignments,
      };
    });
    reconnectedWorker.send(JSON.stringify(workerHello("worker-01")));
    await vi.waitFor(() => {
      expect(reconcileCommand?.assignments).toEqual([
        expect.objectContaining({ workspaceId, desiredState: "RUNNING" }),
      ]);
    });

    const whileReconciling = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/open`,
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        "x-csrf-token": owner.csrfToken,
      },
      payload: {},
    });
    expect(whileReconciling.statusCode).toBe(409);
    expect(dependencies.testState.workspaces[0]?.state).toBe("WORKER_OFFLINE");

    if (reconcileCommand === undefined) {
      throw new Error("reconcile command missing");
    }
    reconnectedWorker.send(
      JSON.stringify({
        version: 1,
        type: "response.ok",
        requestId: reconcileCommand.requestId,
        payload: {
          requestType: "worker.reconcile",
          reconciliation: {
            workspaces: [
              {
                status: "OBSERVED",
                workspace: {
                  workspaceId,
                  state: "RUNNING",
                  runtimeImage: "agent-runtime:test-unassigned",
                  observedAt: NOW.toISOString(),
                },
              },
            ],
            issues: [],
            observedAt: NOW.toISOString(),
          },
        },
      }),
    );
    await vi.waitFor(() => {
      expect(dependencies.testState.workspaces[0]?.state).toBe("RUNNING");
    });

    const afterReconciliation = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: owner.cookie },
    });
    expect(afterReconciliation.json()).toMatchObject({
      workspaces: [
        { id: workspaceId, workerId: "worker-01", state: "RUNNING" },
      ],
    });
    expect(reconnectCommands).toEqual(["worker.reconcile"]);
    expect(otherWorkerCommands).toEqual([]);

    reconnectedWorker.close();
    otherWorker.close();
    await app.close();
  });

  it.each([
    ["STOPPED", "STOPPED", "STOPPED"],
    ["RUNNING", "STOPPED", "ERROR"],
    ["UNKNOWN", "RUNNING", "RUNNING"],
  ] as const)(
    "reconciles desired %s with observed %s to %s",
    async (desiredState, observedState, expectedState) => {
      const workspaceId = randomUUID();
      const dependencies = await createTestDependencies([
        {
          id: workspaceId,
          userId: USER_A_ID,
          name: `reconcile-${observedState.toLowerCase()}`,
          workerId: "worker-01",
          state: "WORKER_OFFLINE",
          runtimeImage: "agent-runtime:test-unassigned",
          createdAt: NOW,
          updatedAt: NOW,
          lastActivityAt: NOW,
        },
      ]);
      dependencies.testState.setDesiredState(workspaceId, desiredState);
      const app = buildControlPlane(dependencies);
      await app.ready();
      const worker = await app.injectWS("/api/workers/connect", {
        headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
      });
      worker.on("message", (data) => {
        const command = JSON.parse(data.toString()) as {
          requestId: string;
          type: "worker.reconcile";
        };
        worker.send(
          JSON.stringify({
            version: 1,
            type: "response.ok",
            requestId: command.requestId,
            payload: {
              requestType: "worker.reconcile",
              reconciliation: {
                workspaces: [
                  {
                    status: "OBSERVED",
                    workspace: {
                      workspaceId,
                      state: observedState,
                      runtimeImage: "agent-runtime:test-unassigned",
                      observedAt: NOW.toISOString(),
                    },
                  },
                ],
                issues: [],
                observedAt: NOW.toISOString(),
              },
            },
          }),
        );
      });
      worker.send(JSON.stringify(workerHello("worker-01")));

      await vi.waitFor(() => {
        expect(dependencies.testState.workspaces[0]?.state).toBe(expectedState);
      });

      worker.close();
      await app.close();
    },
  );

  it.each([
    {
      code: "RUNTIME_ENGINE_ERROR",
      retryable: true,
      expectedState: "WORKER_OFFLINE",
    },
    {
      code: "WORKSPACE_METADATA_MISMATCH",
      retryable: false,
      expectedState: "ERROR",
    },
  ] as const)(
    "maps inventory error $code to $expectedState",
    async ({ code, retryable, expectedState }) => {
      const workspaceId = randomUUID();
      const dependencies = await createTestDependencies([
        {
          id: workspaceId,
          userId: USER_A_ID,
          name: "reconcile-unconfirmed",
          workerId: "worker-01",
          state: "WORKER_OFFLINE",
          runtimeImage: "agent-runtime:test-unassigned",
          createdAt: NOW,
          updatedAt: NOW,
          lastActivityAt: NOW,
        },
      ]);
      const app = buildControlPlane(dependencies);
      await app.ready();
      const worker = await app.injectWS("/api/workers/connect", {
        headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
      });
      worker.on("message", (data) => {
        const command = JSON.parse(data.toString()) as {
          requestId: string;
          type: "worker.reconcile";
        };
        worker.send(
          JSON.stringify({
            version: 1,
            type: "response.ok",
            requestId: command.requestId,
            payload: {
              requestType: "worker.reconcile",
              reconciliation: {
                workspaces: [
                  {
                    status: "INVALID",
                    workspaceId,
                    code,
                    retryable,
                  },
                ],
                issues: [],
                observedAt: NOW.toISOString(),
              },
            },
          }),
        );
      });
      worker.send(JSON.stringify(workerHello("worker-01")));

      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(dependencies.testState.workspaces[0]?.state).toBe(expectedState);

      worker.close();
      await app.close();
    },
  );

  it("reports managed orphans without deleting or reassigning them", async () => {
    const issues: Array<{
      classification: string;
      workspaceId?: string | undefined;
    }> = [];
    const orphanId = randomUUID();
    const dependencies = await createTestDependencies();
    dependencies.reportRecoveryIssue = (issue) => issues.push(issue);
    const app = buildControlPlane(dependencies);
    await app.ready();
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    worker.on("message", (data) => {
      const command = JSON.parse(data.toString()) as { requestId: string };
      const response = emptyReconciliation(command.requestId);
      response.payload.reconciliation.issues.push({
        classification: "MANAGED_ORPHAN",
        resource: "DIRECTORY",
        workspaceId: orphanId,
        code: "UNASSIGNED_LOCAL_RESOURCE",
      });
      worker.send(JSON.stringify(response));
    });
    worker.send(JSON.stringify(workerHello("worker-01")));

    await vi.waitFor(() => {
      expect(issues).toEqual([
        expect.objectContaining({
          classification: "MANAGED_ORPHAN",
          workspaceId: orphanId,
          workerId: "worker-01",
        }),
      ]);
    });
    expect(dependencies.testState.workspaces).toEqual([]);

    worker.close();
    await app.close();
  });

  it("finalizes an interrupted delete only after inventory confirms every local resource is absent", async () => {
    const workspaceId = randomUUID();
    const dependencies = await createTestDependencies([
      {
        id: workspaceId,
        userId: USER_A_ID,
        name: "recover-delete",
        workerId: "worker-01",
        state: "DELETING",
        runtimeImage: "agent-runtime:test-unassigned",
        createdAt: NOW,
        updatedAt: NOW,
        lastActivityAt: NOW,
      },
    ]);
    const app = buildControlPlane(dependencies);
    await app.ready();
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    worker.on("message", (data) => {
      const command = JSON.parse(data.toString()) as { requestId: string };
      worker.send(
        JSON.stringify({
          version: 1,
          type: "response.ok",
          requestId: command.requestId,
          payload: {
            requestType: "worker.reconcile",
            reconciliation: {
              workspaces: [{ status: "MISSING", workspaceId }],
              issues: [],
              observedAt: NOW.toISOString(),
            },
          },
        }),
      );
    });
    worker.send(JSON.stringify(workerHello("worker-01")));

    await vi.waitFor(() => {
      expect(dependencies.testState.workspaces).toEqual([]);
    });

    worker.close();
    await app.close();
  });
});
