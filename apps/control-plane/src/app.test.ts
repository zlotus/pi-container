import { randomUUID } from "node:crypto";
import { once } from "node:events";

import { hashOpaqueToken, hashPassword } from "@agent-runtime/auth";
import type {
  AuthenticatedSessionRecord,
  PlatformAuditEvent,
  UserRecord,
  WorkerRecord,
  WorkspaceRecord,
} from "@agent-runtime/database";
import type {
  WorkerToControlMessage,
  WorkspaceDesiredState,
} from "@agent-runtime/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  buildControlPlane,
  type ControlPlaneDependencies,
} from "./app.js";
import { selectWorker } from "./scheduler.js";
import { WorkspaceSessionExchange } from "./session-exchange.js";

const ORIGIN = "http://portal.test";
const NOW = new Date("2026-09-10T08:00:00.000Z");
const USER_A_ID = "11111111-1111-4111-8111-111111111111";
const USER_B_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "33333333-3333-4333-8333-333333333333";
const WORKER_1_TOKEN = "worker1token0123456789abcdef0123456789abcdef";
const WORKER_2_TOKEN = "worker2token0123456789abcdef0123456789abcdef";

interface TestControlPlaneDependencies extends ControlPlaneDependencies {
  testState: {
    workspaces: WorkspaceRecord[];
    workers: WorkerRecord[];
    markWorkersOffline(cutoff: Date): number;
    setDesiredState(workspaceId: string, state: WorkspaceDesiredState): void;
  };
}

async function createTestDependencies(
  initialWorkspaces: WorkspaceRecord[] = [],
): Promise<TestControlPlaneDependencies> {
  const users: UserRecord[] = [
    {
      id: USER_A_ID,
      email: "a@example.test",
      username: "user-a",
      passwordHash: await hashPassword("password-for-user-a"),
      role: "user",
      createdAt: NOW,
    },
    {
      id: USER_B_ID,
      email: "b@example.test",
      username: "user-b",
      passwordHash: await hashPassword("password-for-user-b"),
      role: "user",
      createdAt: NOW,
    },
    {
      id: ADMIN_ID,
      email: "admin@example.test",
      username: "admin",
      passwordHash: await hashPassword("password-for-admin"),
      role: "admin",
      createdAt: NOW,
    },
  ];
  const sessions = new Map<
    string,
    { id: string; userId: string; expiresAt: Date; revoked: boolean }
  >();
  const workspaces: WorkspaceRecord[] = initialWorkspaces.map((workspace) => ({
    ...workspace,
  }));
  const desiredStates = new Map<string, WorkspaceDesiredState>(
    workspaces.map((workspace) => [
      workspace.id,
      workspace.state === "RUNNING" || workspace.state === "STARTING"
        ? "RUNNING"
        : workspace.state === "DELETING"
          ? "DELETED"
          : workspace.state === "ERROR" || workspace.state === "WORKER_OFFLINE"
            ? "UNKNOWN"
          : "STOPPED",
    ]),
  );
  const auditEvents: PlatformAuditEvent[] = [];
  const workers: WorkerRecord[] = [WORKER_1_TOKEN, WORKER_2_TOKEN].map(
    (_token, index) => ({
      id: `worker-0${index + 1}`,
      hostname: null,
      architecture: null,
      status: "REGISTERED",
      enabled: true,
      runtimeImage: null,
      runtimeVersion: null,
      capabilities: {},
      maxWorkspaces: null,
      allocatedWorkspaces: 0,
      systemResources: { logicalCpuCount: null, memoryBytes: null },
      lastHeartbeatAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  const credentials = new Map([
    [hashOpaqueToken(WORKER_1_TOKEN), "worker-01"],
    [hashOpaqueToken(WORKER_2_TOKEN), "worker-02"],
  ]);

  return {
    testState: {
      workspaces,
      workers,
      markWorkersOffline(cutoff) {
        const offlineWorkerIds = new Set(
          workers
            .filter(
              (worker) =>
                worker.enabled &&
                worker.status === "ONLINE" &&
                (worker.lastHeartbeatAt === null ||
                  worker.lastHeartbeatAt <= cutoff),
            )
            .map((worker) => {
              worker.status = "OFFLINE";
              return worker.id;
            }),
        );
        for (const workspace of workspaces) {
          if (
            workspace.workerId !== null &&
            offlineWorkerIds.has(workspace.workerId) &&
            ["STARTING", "RUNNING", "STOPPING", "STOPPED", "ERROR"].includes(
              workspace.state,
            )
          ) {
            workspace.state = "WORKER_OFFLINE";
          }
        }
        return offlineWorkerIds.size;
      },
      setDesiredState(workspaceId, state) {
        desiredStates.set(workspaceId, state);
      },
    },
    checkDatabase: vi.fn<() => Promise<void>>(),
    sessionSecret: "test-session-secret-that-is-at-least-32-characters",
    portalOrigin: ORIGIN,
    secureCookies: false,
    sessionTtlMs: 12 * 60 * 60 * 1_000,
    workspaceBaseUrl: "http://agent.test:3001",
    sessionExchanges: new WorkspaceSessionExchange(60_000),
    defaultRuntimeImage: "agent-runtime:test-unassigned",
    workerOfflineAfterMs: 35_000,
    workerCommandTimeoutMs: 1_000,
    now: () => NOW,
    workerStore: {
      async findWorkerByCredentialHash(credentialHash) {
        const workerId = credentials.get(credentialHash);
        if (workerId === undefined) return null;
        const worker = workers.find((candidate) => candidate.id === workerId);
        return worker === undefined
          ? null
          : { workerId, enabled: worker.enabled };
      },
      async recordWorkerHello(input) {
        if (credentials.get(input.credentialHash) !== input.workerId) return false;
        const worker = workers.find((candidate) => candidate.id === input.workerId);
        if (worker === undefined || !worker.enabled) return false;
        Object.assign(worker, {
          hostname: input.hostname,
          architecture: input.architecture,
          status: "ONLINE",
          runtimeImage: input.runtimeImage,
          runtimeVersion: input.runtimeVersion,
          capabilities: input.capabilities,
          maxWorkspaces: input.maxWorkspaces,
          allocatedWorkspaces: input.allocatedWorkspaces,
          systemResources: input.systemResources,
          lastHeartbeatAt: input.receivedAt,
          updatedAt: input.receivedAt,
        });
        return true;
      },
      async recordWorkerHeartbeat(input) {
        if (credentials.get(input.credentialHash) !== input.workerId) return false;
        const worker = workers.find((candidate) => candidate.id === input.workerId);
        if (worker === undefined || !worker.enabled) return false;
        worker.allocatedWorkspaces = input.allocatedWorkspaces;
        worker.lastHeartbeatAt = input.receivedAt;
        worker.updatedAt = input.receivedAt;
        worker.status = "ONLINE";
        return true;
      },
      async listWorkersWithAssignments() {
        return workers.map((worker) => ({
          ...worker,
          assignedWorkspaces: workspaces.filter(
            (workspace) => workspace.workerId === worker.id,
          ).length,
        }));
      },
    },
    store: {
      async recordWorkspaceOpened(input) {
        auditEvents.unshift({
          id: String(auditEvents.length + 1),
          eventType: "workspace.opened",
          actorUserId: input.actorUserId,
          ownerUserId: input.ownerUserId,
          workspaceId: input.workspaceId,
          workerId: input.workerId,
          details: {},
          createdAt: NOW,
        });
      },
      async listAuditEvents(input) {
        return auditEvents
          .filter(
            (event) =>
              input.includeAllUsers || event.ownerUserId === input.userId,
          )
          .filter(
            (event) =>
              input.beforeId === null ||
              BigInt(event.id) < BigInt(input.beforeId),
          )
          .slice(0, input.limit);
      },
      async findUserByLogin(login) {
        const normalized = login.trim().toLowerCase();
        return (
          users.find(
            (user) =>
              user.email === normalized || user.username === normalized,
          ) ?? null
        );
      },
      async createSession(input) {
        sessions.set(input.tokenHash, {
          id: input.id,
          userId: input.userId,
          expiresAt: input.expiresAt,
          revoked: false,
        });
      },
      async findActiveSession(tokenHash, currentTime) {
        const session = sessions.get(tokenHash);
        if (
          session === undefined ||
          session.revoked ||
          session.expiresAt <= currentTime
        ) {
          return null;
        }
        const user = users.find((candidate) => candidate.id === session.userId);
        if (user === undefined) return null;
        const result: AuthenticatedSessionRecord = {
          sessionId: session.id,
          expiresAt: session.expiresAt,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
            createdAt: user.createdAt,
          },
        };
        return result;
      },
      async revokeSession(tokenHash) {
        const session = sessions.get(tokenHash);
        if (session !== undefined) session.revoked = true;
      },
      async listWorkspaces(userId) {
        return workspaces.filter((workspace) => workspace.userId === userId);
      },
      async beginWorkerReconciliation(workerId) {
        return workspaces
          .filter((workspace) => workspace.workerId === workerId)
          .map((workspace) => {
            workspace.state = "WORKER_OFFLINE";
            return {
              ...workspace,
              desiredState: desiredStates.get(workspace.id) ?? "STOPPED",
            };
          });
      },
      async reconcileWorkspaceRecovery(input) {
        const workspace = workspaces.find(
          (candidate) =>
            candidate.id === input.workspaceId &&
            candidate.workerId === input.workerId &&
            candidate.runtimeImage === input.runtimeImage &&
            desiredStates.get(candidate.id) === input.desiredState &&
            candidate.state === "WORKER_OFFLINE",
        );
        if (workspace === undefined) return false;
        workspace.state = input.state;
        if (
          input.desiredState === "UNKNOWN" &&
          (input.state === "RUNNING" || input.state === "STOPPED")
        ) {
          desiredStates.set(workspace.id, input.state);
        }
        return true;
      },
      async deleteRecoveredWorkspace(input) {
        const index = workspaces.findIndex(
          (candidate) =>
            candidate.id === input.workspaceId &&
            candidate.userId === input.userId &&
            candidate.workerId === input.workerId &&
            candidate.runtimeImage === input.runtimeImage &&
            desiredStates.get(candidate.id) === "DELETED" &&
            candidate.state === "WORKER_OFFLINE",
        );
        if (index < 0) return false;
        desiredStates.delete(input.workspaceId);
        workspaces.splice(index, 1);
        return true;
      },
      async createWorkspace(input) {
        const workspace: WorkspaceRecord = {
          id: input.id,
          userId: input.userId,
          name: input.name,
          workerId: null,
          state: "CREATED",
          runtimeImage: input.runtimeImage,
          createdAt: NOW,
          updatedAt: NOW,
          lastActivityAt: NOW,
        };
        workspaces.push(workspace);
        desiredStates.set(workspace.id, "STOPPED");
        return workspace;
      },
      async findOwnedWorkspace(id, userId) {
        return (
          workspaces.find(
            (workspace) => workspace.id === id && workspace.userId === userId,
          ) ?? null
        );
      },
      async deleteOwnedWorkspace(id, userId) {
        const index = workspaces.findIndex(
          (workspace) =>
            workspace.id === id &&
            workspace.userId === userId &&
            workspace.workerId === null &&
            workspace.state === "CREATED",
        );
        if (index < 0) return false;
        desiredStates.delete(id);
        workspaces.splice(index, 1);
        return true;
      },
      async scheduleWorkspaceStart(input) {
        const workspace = workspaces.find(
          (candidate) =>
            candidate.id === input.workspaceId &&
            candidate.userId === input.userId &&
            ["CREATED", "STOPPED", "ERROR", "WORKER_OFFLINE"].includes(
              candidate.state,
            ),
        );
        if (workspace === undefined) return { outcome: "WORKSPACE_CHANGED" };
        const sticky = workspace.workerId !== null;
        if (workspace.workerId === null) {
          const selected = selectWorker({
            workspace: {
              runtimeImage: workspace.runtimeImage,
              requiredArchitecture: null,
              requiredCapabilities: {},
            },
            candidates: workers.map((worker) => ({
              id: worker.id,
              architecture: worker.architecture,
              status: worker.status,
              enabled: worker.enabled,
              runtimeImage: worker.runtimeImage,
              runtimeVersion: worker.runtimeVersion,
              capabilities: worker.capabilities,
              maxWorkspaces: worker.maxWorkspaces,
              assignedWorkspaces: workspaces.filter(
                (candidate) => candidate.workerId === worker.id,
              ).length,
              lastHeartbeatAt: worker.lastHeartbeatAt,
            })),
            connectedWorkerIds: input.connectedWorkerIds,
            heartbeatCutoff: input.heartbeatCutoff,
          });
          if (selected === null) return { outcome: "NO_ELIGIBLE_WORKER" };
          workspace.workerId = selected.id;
        }
        workspace.state = "STARTING";
        desiredStates.set(workspace.id, "RUNNING");
        return { outcome: "STARTING", workspace, sticky };
      },
      async finishWorkspaceStart(input) {
        const workspace = workspaces.find(
          (candidate) =>
            candidate.id === input.workspaceId &&
            candidate.workerId === input.workerId &&
            candidate.state === "STARTING",
        );
        if (workspace === undefined) return false;
        workspace.state = "RUNNING";
        return true;
      },
      async beginWorkspaceStop(input) {
        const workspace = workspaces.find(
          (candidate) =>
            candidate.id === input.workspaceId &&
            candidate.userId === input.userId &&
            candidate.workerId === input.workerId &&
            candidate.state === "RUNNING",
        );
        if (workspace === undefined) return false;
        workspace.state = "STOPPING";
        desiredStates.set(workspace.id, "STOPPED");
        return true;
      },
      async finishWorkspaceStop(input) {
        const workspace = workspaces.find(
          (candidate) =>
            candidate.id === input.workspaceId &&
            candidate.workerId === input.workerId &&
            candidate.state === "STOPPING",
        );
        if (workspace === undefined) return false;
        workspace.state = "STOPPED";
        return true;
      },
      async beginWorkspaceDelete(input) {
        const workspace = workspaces.find(
          (candidate) =>
            candidate.id === input.workspaceId &&
            candidate.userId === input.userId &&
            candidate.workerId === input.workerId &&
            !["STARTING", "STOPPING", "DELETING"].includes(candidate.state),
        );
        if (workspace === undefined) return false;
        workspace.state = "DELETING";
        desiredStates.set(workspace.id, "DELETED");
        return true;
      },
      async deleteConfirmedWorkspace(input) {
        const index = workspaces.findIndex(
          (candidate) =>
            candidate.id === input.workspaceId &&
            candidate.userId === input.userId &&
            candidate.workerId === input.workerId &&
            candidate.state === "DELETING",
        );
        if (index < 0) return false;
        desiredStates.delete(input.workspaceId);
        workspaces.splice(index, 1);
        return true;
      },
      async markWorkspaceRuntimeFailure(input) {
        const workspace = workspaces.find(
          (candidate) =>
            candidate.id === input.workspaceId &&
            candidate.workerId === input.workerId,
        );
        if (workspace !== undefined) {
          workspace.state = input.workerOffline ? "WORKER_OFFLINE" : "ERROR";
        }
      },
    },
    workspaceResources: {
      cpuCount: 2,
      memoryBytes: 4 * 1024 ** 3,
      pidsLimit: 512,
    },
  };
}

async function login(
  app: ReturnType<typeof buildControlPlane>,
  identifier: string,
  password: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN },
    payload: { login: identifier, password },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = cookieHeader?.split(";")[0];
  if (cookie === undefined) throw new Error("login did not set a cookie");
  const body = response.json<{ csrfToken: string }>();
  return { cookie, csrfToken: body.csrfToken };
}

describe("control plane probes", () => {
  it("reports liveness without consulting PostgreSQL", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "control-plane",
      status: "ok",
    });
    expect(dependencies.checkDatabase).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports failed PostgreSQL readiness as unavailable", async () => {
    const dependencies = await createTestDependencies();
    dependencies.checkDatabase = async () => {
      throw new Error("database unavailable");
    };
    const app = buildControlPlane(dependencies);
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    await app.close();
  });
});

describe("local authentication", () => {
  it("accepts email or username and sets an HTTP-only host cookie", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "password-for-user-a" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("platform-session=");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(response.json()).toMatchObject({
      user: { id: USER_A_ID, email: "a@example.test" },
    });
    await app.close();
  });

  it("uses the __Host- cookie contract when Secure cookies are enabled", async () => {
    const dependencies = await createTestDependencies();
    dependencies.secureCookies = true;
    const app = buildControlPlane(dependencies);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "password-for-user-a" },
    });

    expect(response.headers["set-cookie"]).toContain(
      "__Host-platform-session=",
    );
    expect(response.headers["set-cookie"]).toContain("Secure");
    await app.close();
  });

  it("revokes the server-side session on logout", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const session = await login(app, "user-a", "password-for-user-a");
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: session.cookie,
        origin: ORIGIN,
        "x-csrf-token": session.csrfToken,
      },
      payload: {},
    });
    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: session.cookie },
    });

    expect(logout.statusCode).toBe(204);
    expect(afterLogout.statusCode).toBe(401);
    await app.close();
  });

  it("rejects invalid credentials and untrusted origins", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const invalidPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "wrong" },
    });
    const invalidOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://attacker.test" },
      payload: { login: "user-a", password: "password-for-user-a" },
    });

    expect(invalidPassword.statusCode).toBe(401);
    expect(invalidOrigin.statusCode).toBe(403);
    await app.close();
  });
});

describe("workspace ownership", () => {
  it("keeps User A and User B workspace lists isolated", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const userA = await login(app, "user-a", "password-for-user-a");
    const userB = await login(app, "b@example.test", "password-for-user-b");

    const createA = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userA.cookie,
        origin: ORIGIN,
        "x-csrf-token": userA.csrfToken,
      },
      payload: { name: "workspace-a" },
    });
    const createB = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userB.cookie,
        origin: ORIGIN,
        "x-csrf-token": userB.csrfToken,
      },
      payload: { name: "workspace-b" },
    });

    expect(createA.statusCode).toBe(201);
    expect(createB.statusCode).toBe(201);
    const workspaceA = createA.json<{ workspace: WorkspaceRecord }>().workspace;

    const listA = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: userA.cookie },
    });
    const listB = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: userB.cookie },
    });
    expect(listA.json()).toMatchObject({
      workspaces: [{ name: "workspace-a" }],
    });
    expect(listB.json()).toMatchObject({
      workspaces: [{ name: "workspace-b" }],
    });

    const foreignGet = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceA.id}`,
      headers: { cookie: userB.cookie },
    });
    const foreignDelete = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceA.id}`,
      headers: {
        cookie: userB.cookie,
        origin: ORIGIN,
        "x-csrf-token": userB.csrfToken,
      },
    });
    expect(foreignGet.statusCode).toBe(404);
    expect(foreignDelete.statusCode).toBe(404);

    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceA.id}`,
      headers: {
        cookie: userA.cookie,
        origin: ORIGIN,
        "x-csrf-token": userA.csrfToken,
      },
    });
    expect(ownerDelete.statusCode).toBe(204);
    await app.close();
  });

  it("requires both a trusted Origin and the session-bound CSRF token", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const userA = await login(app, "user-a", "password-for-user-a");

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: userA.cookie, origin: ORIGIN },
      payload: { name: "blocked" },
    });
    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userA.cookie,
        origin: "https://attacker.test",
        "x-csrf-token": userA.csrfToken,
      },
      payload: { name: "blocked" },
    });

    expect(missingCsrf.statusCode).toBe(403);
    expect(wrongOrigin.statusCode).toBe(403);
    await app.close();
  });
});

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
          version: 1,
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
    worker2.on("message", (data) => {
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
});

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

function workerHello(workerId: string) {
  return {
    version: 1,
    type: "worker.hello",
    requestId: randomUUID(),
    payload: {
      workerId,
      hostname: `${workerId}.internal`,
      architecture: "arm64",
      runtimeImage: "agent-runtime:test-unassigned",
      runtimeVersion: "phase-3",
      capabilities: {
        browser: false,
        office: false,
        ffmpeg: false,
        python: true,
        node: true,
        rust: false,
      },
      maxWorkspaces: 4,
      allocatedWorkspaces: 0,
      systemResources: {
        logicalCpuCount: 8,
        memoryBytes: 16 * 1024 ** 3,
      },
    },
  };
}

type WorkerOkResponse = Extract<
  WorkerToControlMessage,
  { type: "response.ok" }
>;
type ReconcileOkResponse = Omit<WorkerOkResponse, "payload"> & {
  payload: Extract<
    WorkerOkResponse["payload"],
    { requestType: "worker.reconcile" }
  >;
};

function emptyReconciliation(requestId: string): ReconcileOkResponse {
  return {
    version: 1,
    type: "response.ok",
    requestId,
    payload: {
      requestType: "worker.reconcile",
      reconciliation: {
        workspaces: [],
        issues: [],
        observedAt: NOW.toISOString(),
      },
    },
  };
}

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
});
