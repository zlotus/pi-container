import { randomUUID } from "node:crypto";
import { once } from "node:events";

import { hashOpaqueToken, hashPassword } from "@agent-runtime/auth";
import type {
  AuthenticatedSessionRecord,
  PlatformAuditEvent,
  UserRecord,
  UserIdentityRecord,
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
import { SessionConnectionRegistry } from "./session-connections.js";
import { OidcTransactionStore, type OidcRuntime } from "./oidc.js";
import { OAuth2TransactionStore, type OAuth2Runtime } from "./oauth2.js";

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
    users: UserRecord[];
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
      status: "active",
      lastLoginAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: USER_B_ID,
      email: "b@example.test",
      username: "user-b",
      passwordHash: await hashPassword("password-for-user-b"),
      role: "user",
      status: "active",
      lastLoginAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: ADMIN_ID,
      email: "admin@example.test",
      username: "admin",
      passwordHash: await hashPassword("password-for-admin"),
      role: "admin",
      status: "active",
      lastLoginAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  const sessions = new Map<
    string,
    { id: string; userId: string; expiresAt: Date; revoked: boolean }
  >();
  const identities: UserIdentityRecord[] = [];
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
      users,
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
      async createUser(input) {
        if (
          users.some(
            (user) =>
              user.email === input.email ||
              (input.username !== null && user.username === input.username),
          )
        ) {
          throw Object.assign(new Error("duplicate user"), { code: "23505" });
        }
        const user: UserRecord = {
          ...input,
          status: "active",
          lastLoginAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        users.push(user);
        return user;
      },
      async createSession(input) {
        const user = users.find((candidate) => candidate.id === input.userId);
        if (user === undefined || user.status !== "active") return false;
        sessions.set(input.tokenHash, {
          id: input.id,
          userId: input.userId,
          expiresAt: input.expiresAt,
          revoked: false,
        });
        user.lastLoginAt = NOW;
        return true;
      },
      async listUserIdentities(userId) {
        if (!users.some((candidate) => candidate.id === userId)) return null;
        return identities.filter((identity) => identity.userId === userId);
      },
      async bindExternalIdentity(input) {
        if (!users.some((candidate) => candidate.id === input.userId)) {
          return { outcome: "USER_NOT_FOUND" as const };
        }
        if (
          identities.some(
            (identity) =>
              identity.providerId === input.providerId &&
              identity.providerSubject === input.providerSubject,
          )
        ) {
          return { outcome: "IDENTITY_ALREADY_BOUND" as const };
        }
        const identity: UserIdentityRecord = {
          id: input.id,
          userId: input.userId,
          providerId: input.providerId,
          providerSubject: input.providerSubject,
          usernameSnapshot: null,
          emailSnapshot: null,
          displayNameSnapshot: null,
          createdAt: NOW,
          lastLoginAt: null,
        };
        identities.push(identity);
        auditEvents.unshift({
          id: String(auditEvents.length + 1),
          eventType: "identity.bound",
          actorUserId: input.actorUserId,
          ownerUserId: input.userId,
          workspaceId: null,
          workerId: null,
          details: { identityId: identity.id, providerId: identity.providerId },
          createdAt: NOW,
        });
        return { outcome: "BOUND" as const, identity };
      },
      async unbindExternalIdentity(input) {
        const user = users.find((candidate) => candidate.id === input.userId);
        if (user === undefined) return { outcome: "USER_NOT_FOUND" as const };
        const userIdentities = identities.filter(
          (candidate) => candidate.userId === input.userId,
        );
        const identity = userIdentities.find(
          (candidate) => candidate.id === input.identityId,
        );
        if (identity === undefined) return { outcome: "IDENTITY_NOT_FOUND" as const };
        const hasLocalLogin =
          user.passwordHash !== null &&
          (user.email !== null || user.username !== null);
        if (!hasLocalLogin && userIdentities.length === 1) {
          return { outcome: "LAST_LOGIN_METHOD" as const };
        }
        identities.splice(identities.indexOf(identity), 1);
        auditEvents.unshift({
          id: String(auditEvents.length + 1),
          eventType: "identity.unbound",
          actorUserId: input.actorUserId,
          ownerUserId: input.userId,
          workspaceId: null,
          workerId: null,
          details: { identityId: identity.id, providerId: identity.providerId },
          createdAt: NOW,
        });
        return { outcome: "UNBOUND" as const };
      },
      async completeExternalLogin(input) {
        const identity = identities.find(
          (candidate) =>
            candidate.providerId === input.providerId &&
            candidate.providerSubject === input.providerSubject,
        );
        let resolvedIdentity = identity;
        if (resolvedIdentity === undefined) {
          if (!input.autoProvision) return { outcome: "UNKNOWN_IDENTITY" as const };
          if (input.provisionedUser === null) {
            return { outcome: "PROVISIONING_NOT_ALLOWED" as const };
          }
          const user: UserRecord = {
            id: input.provisionedUser.id,
            email: input.provisionedUser.email,
            username: input.provisionedUser.username,
            passwordHash: null,
            role: "user",
            status: "active",
            lastLoginAt: null,
            createdAt: input.authenticatedAt,
            updatedAt: input.authenticatedAt,
          };
          users.push(user);
          resolvedIdentity = {
            id: input.identityId,
            userId: user.id,
            providerId: input.providerId,
            providerSubject: input.providerSubject,
            usernameSnapshot: input.usernameSnapshot,
            emailSnapshot: input.emailSnapshot,
            displayNameSnapshot: input.displayNameSnapshot,
            createdAt: input.authenticatedAt,
            lastLoginAt: null,
          };
          identities.push(resolvedIdentity);
        }
        const user = users.find((candidate) => candidate.id === resolvedIdentity.userId);
        if (user === undefined || user.status !== "active") {
          return { outcome: "USER_DISABLED" as const };
        }
        sessions.set(input.tokenHash, {
          id: input.sessionId,
          userId: user.id,
          expiresAt: input.expiresAt,
          revoked: false,
        });
        resolvedIdentity.usernameSnapshot = input.usernameSnapshot;
        resolvedIdentity.emailSnapshot = input.emailSnapshot;
        resolvedIdentity.displayNameSnapshot = input.displayNameSnapshot;
        resolvedIdentity.lastLoginAt = input.authenticatedAt;
        user.lastLoginAt = input.authenticatedAt;
        user.updatedAt = input.authenticatedAt;
        return {
          outcome: "AUTHENTICATED" as const,
          provisioned: identity === undefined,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
            status: user.status,
            lastLoginAt: input.authenticatedAt,
            createdAt: user.createdAt,
            updatedAt: input.authenticatedAt,
          },
        };
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
        if (user === undefined || user.status !== "active") return null;
        const result: AuthenticatedSessionRecord = {
          sessionId: session.id,
          expiresAt: session.expiresAt,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
            status: user.status,
            lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
        };
        return result;
      },
      async revokeSession(tokenHash) {
        const session = sessions.get(tokenHash);
        if (session !== undefined) session.revoked = true;
      },
      async listUsers() {
        return users.map((user) => ({
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
          status: user.status,
          source: "local" as const,
          workspaceCount: workspaces.filter(
            (workspace) => workspace.userId === user.id,
          ).length,
          lastLoginAt: user.lastLoginAt,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        }));
      },
      async updateManagedUser(input) {
        const user = users.find((candidate) => candidate.id === input.userId);
        if (user === undefined) return { outcome: "NOT_FOUND" as const };
        const role = input.role ?? user.role;
        const status = input.status ?? user.status;
        if (
          user.role === "admin" &&
          user.status === "active" &&
          (role !== "admin" || status !== "active") &&
          !users.some(
            (candidate) =>
              candidate.id !== user.id &&
              candidate.role === "admin" &&
              candidate.status === "active",
          )
        ) {
          return { outcome: "LAST_ACTIVE_LOCAL_ADMIN" as const };
        }
        user.role = role;
        user.status = status;
        user.updatedAt = NOW;
        if (status === "disabled") {
          for (const session of sessions.values()) {
            if (session.userId === user.id) session.revoked = true;
          }
        }
        return {
          outcome: "UPDATED" as const,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
            status: user.status,
            source: "local" as const,
            workspaceCount: workspaces.filter(
              (workspace) => workspace.userId === user.id,
            ).length,
            lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
        };
      },
      async resetLocalPassword(input) {
        const user = users.find((candidate) => candidate.id === input.userId);
        if (user === undefined) return false;
        user.passwordHash = input.passwordHash;
        user.updatedAt = NOW;
        return true;
      },
      async revokeUserSessions(userId) {
        if (!users.some((user) => user.id === userId)) return false;
        for (const session of sessions.values()) {
          if (session.userId === userId) session.revoked = true;
        }
        return true;
      },
      async listManagedUserWorkspaces(userId) {
        if (!users.some((user) => user.id === userId)) return null;
        return workspaces.filter((workspace) => workspace.userId === userId);
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

function configureTestOidc(dependencies: TestControlPlaneDependencies) {
  const behavior = {
    subject: "subject-a",
    usernameSnapshot: "user-a" as string | null,
    emailSnapshot: "a@example.test" as string | null,
    displayNameSnapshot: "User A" as string | null,
  };
  const oidc: OidcRuntime = {
    providerId: "enterprise-oidc",
    redirectUri: `${ORIGIN}/auth/oidc/callback`,
    transactions: new OidcTransactionStore(),
    autoProvision: false,
    allowedDomains: [],
    client: {
      async createAuthorizationRequest(redirectUri) {
        return {
          url: new URL(
            `https://idp.example.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
          ),
          transaction: {
            state: "expected-state",
            nonce: "expected-nonce",
            codeVerifier: "expected-code-verifier",
          },
        };
      },
      async exchangeAuthorizationCode(input) {
        if (input.callbackUrl.origin + input.callbackUrl.pathname !== input.redirectUri) {
          throw new Error("redirect URI mismatch");
        }
        if (
          input.callbackUrl.searchParams.get("state") !==
          input.transaction.state
        ) {
          throw new Error("state mismatch");
        }
        return { ...behavior };
      },
    },
  };
  dependencies.oidc = oidc;
  return behavior;
}

function configureTestOAuth2(dependencies: TestControlPlaneDependencies) {
  const behavior = {
    subject: "oauth-subject-a",
    usernameSnapshot: "oauth-user-a" as string | null,
    emailSnapshot: "oauth@example.test" as string | null,
    displayNameSnapshot: "OAuth User A" as string | null,
  };
  const oauth2: OAuth2Runtime = {
    providerId: "enterprise-oauth2",
    redirectUri: `${ORIGIN}/auth/oauth2/callback`,
    transactions: new OAuth2TransactionStore(),
    autoProvision: false,
    allowedDomains: [],
    client: {
      async createAuthorizationRequest(redirectUri) {
        return {
          url: new URL(
            `https://oauth.example.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
          ),
          transaction: {
            state: "oauth-expected-state",
            codeVerifier: "oauth-expected-code-verifier",
          },
        };
      },
      async exchangeAuthorizationCode(input) {
        if (input.callbackUrl.origin + input.callbackUrl.pathname !== input.redirectUri) {
          throw new Error("redirect URI mismatch");
        }
        if (
          input.callbackUrl.searchParams.get("state") !==
          input.transaction.state
        ) {
          throw new Error("state mismatch");
        }
        return { ...behavior };
      },
    },
  };
  dependencies.oauth2 = oauth2;
  return behavior;
}

function firstCookie(response: {
  headers: Record<string, string | string[] | number | undefined>;
}, name: string): string {
  const value = response.headers["set-cookie"];
  const cookies = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  for (const entry of cookies) {
    const cookie = entry.split(";")[0];
    if (cookie?.startsWith(`${name}=`)) return cookie;
  }
  throw new Error(`${name} cookie is missing`);
}

async function beginOidcLogin(app: ReturnType<typeof buildControlPlane>) {
  const response = await app.inject({ method: "GET", url: "/auth/oidc/login" });
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toContain("https://idp.example.test/authorize");
  return firstCookie(response, "oidc-transaction");
}

async function beginOAuth2Login(app: ReturnType<typeof buildControlPlane>) {
  const response = await app.inject({ method: "GET", url: "/auth/oauth2/login" });
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toContain("https://oauth.example.test/authorize");
  return firstCookie(response, "oauth2-transaction");
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

  it("accepts the canonical Portal Origin and multiple exact-match allowed origins", async () => {
    const dependencies = await createTestDependencies();
    dependencies.portalAllowedOrigins = [
      "http://192.168.1.124:5173",
      "http://100.64.0.10:5173",
    ];
    const app = buildControlPlane(dependencies);

    for (const origin of [
      ORIGIN,
      "http://192.168.1.124:5173",
      "http://100.64.0.10:5173",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { login: "user-a", password: "password-for-user-a" },
      });
      expect(response.statusCode).toBe(200);
    }
    const differentPort = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "http://192.168.1.124:5174" },
      payload: { login: "user-a", password: "password-for-user-a" },
    });
    expect(differentPort.statusCode).toBe(403);
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

  it("rejects invalid credentials, untrusted origins, and a missing Origin", async () => {
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
    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { login: "user-a", password: "password-for-user-a" },
    });

    expect(invalidPassword.statusCode).toBe(401);
    expect(invalidOrigin.statusCode).toBe(403);
    expect(missingOrigin.statusCode).toBe(403);
    await app.close();
  });
});

describe("Phase 10 Generic OIDC", () => {
  it("keeps SSO optional so Local Admin login remains available", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const methods = await app.inject({
      method: "GET",
      url: "/api/auth/methods",
    });
    const disabledSso = await app.inject({
      method: "GET",
      url: "/auth/oidc/login",
    });
    const admin = await login(app, "admin", "password-for-admin");

    expect(methods.json()).toEqual({
      oidc: { enabled: false, providerId: null },
      oauth2: { enabled: false, providerId: null },
    });
    expect(disabledSso.statusCode).toBe(404);
    expect(admin.cookie).toContain("platform-session=");
    await app.close();
  });

  it("allows only an admin to pre-bind the configured provider and exact subject", async () => {
    const dependencies = await createTestDependencies();
    configureTestOidc(dependencies);
    const app = buildControlPlane(dependencies);
    const methods = await app.inject({
      method: "GET",
      url: "/api/auth/methods",
    });
    const admin = await login(app, "admin", "password-for-admin");
    const user = await login(app, "user-a", "password-for-user-a");
    const userAttempt = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/oidc-identities`,
      headers: {
        cookie: user.cookie,
        origin: ORIGIN,
        "x-csrf-token": user.csrfToken,
      },
      payload: {
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
      },
    });
    const providerMismatch = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/oidc-identities`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
      payload: {
        providerId: "another-provider",
        providerSubject: "subject-a",
      },
    });
    const bound = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/oidc-identities`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
      payload: {
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
      },
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_B_ID}/oidc-identities`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
      payload: {
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
      },
    });

    expect(methods.json()).toEqual({
      oidc: { enabled: true, providerId: "enterprise-oidc" },
      oauth2: { enabled: false, providerId: null },
    });
    expect(userAttempt.statusCode).toBe(403);
    expect(providerMismatch.statusCode).toBe(400);
    expect(providerMismatch.json()).toMatchObject({
      error: { code: "OIDC_PROVIDER_MISMATCH" },
    });
    expect(bound.statusCode).toBe(201);
    expect(bound.json()).toMatchObject({
      identity: {
        userId: USER_A_ID,
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
      },
    });
    expect(duplicate.statusCode).toBe(409);
    await app.close();
  });

  it("rejects unknown and disabled identities, but creates a Platform session for a known active identity", async () => {
    const dependencies = await createTestDependencies();
    const behavior = configureTestOidc(dependencies);
    const app = buildControlPlane(dependencies);
    const admin = await login(app, "admin", "password-for-admin");
    const userB = await login(app, "user-b", "password-for-user-b");
    const workspaceB = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userB.cookie,
        origin: ORIGIN,
        "x-csrf-token": userB.csrfToken,
      },
      payload: { name: "user-b-private" },
    });
    const workspaceBId = workspaceB.json<{ workspace: { id: string } }>()
      .workspace.id;

    const unknownTransaction = await beginOidcLogin(app);
    const unknown = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=expected-state",
      headers: { cookie: unknownTransaction },
    });
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json()).toMatchObject({
      error: { code: "OIDC_IDENTITY_NOT_BOUND" },
    });

    const binding = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/oidc-identities`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
      payload: {
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
      },
    });
    expect(binding.statusCode).toBe(201);

    const knownTransaction = await beginOidcLogin(app);
    const known = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=expected-state",
      headers: { cookie: knownTransaction },
    });
    expect(known.statusCode).toBe(302);
    expect(known.headers.location).toBe(ORIGIN);
    const oidcSession = firstCookie(known, "platform-session");
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: oidcSession },
    });
    const foreignWorkspace = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceBId}`,
      headers: { cookie: oidcSession },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { id: USER_A_ID, role: "user" } });
    expect(foreignWorkspace.statusCode).toBe(404);

    behavior.subject = "subject-with-the-same-email";
    behavior.emailSnapshot = "a@example.test";
    const sameEmailTransaction = await beginOidcLogin(app);
    const sameEmail = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-b&state=expected-state",
      headers: { cookie: sameEmailTransaction },
    });
    expect(sameEmail.statusCode).toBe(403);
    expect(sameEmail.json()).toMatchObject({
      error: { code: "OIDC_IDENTITY_NOT_BOUND" },
    });

    await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${USER_A_ID}`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
      payload: { status: "disabled" },
    });
    behavior.subject = "subject-a";
    const disabledTransaction = await beginOidcLogin(app);
    const disabled = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-c&state=expected-state",
      headers: { cookie: disabledTransaction },
    });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toMatchObject({
      error: { code: "OIDC_USER_DISABLED" },
    });
    await app.close();
  });

  it("consumes callback transactions once and returns one stable failure code", async () => {
    const dependencies = await createTestDependencies();
    configureTestOidc(dependencies);
    const app = buildControlPlane(dependencies);
    const transactionCookie = await beginOidcLogin(app);
    const mismatch = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=wrong-state",
      headers: { cookie: transactionCookie },
    });
    const replay = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=expected-state",
      headers: { cookie: transactionCookie },
    });

    expect(mismatch.statusCode).toBe(401);
    expect(mismatch.json()).toEqual({
      error: {
        code: "OIDC_AUTHENTICATION_FAILED",
        message: "OIDC authentication failed",
      },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({
      error: { code: "OIDC_TRANSACTION_INVALID" },
    });
    await app.close();
  });
});

describe("Phase 11 provisioning and identity management", () => {
  it("keeps JIT off by default, provisions role=user when enabled, and enforces exact allowed domains", async () => {
    const dependencies = await createTestDependencies();
    const behavior = configureTestOidc(dependencies);
    if (dependencies.oidc === undefined) throw new Error("OIDC test runtime missing");
    dependencies.oidc.autoProvision = true;
    dependencies.oidc.allowedDomains = ["example.test"];
    behavior.subject = "new-subject-with-existing-email";
    behavior.emailSnapshot = "a@example.test";
    const app = buildControlPlane(dependencies);

    const transaction = await beginOidcLogin(app);
    const callback = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=expected-state",
      headers: { cookie: transaction },
    });
    expect(callback.statusCode).toBe(302);
    const jitSession = firstCookie(callback, "platform-session");
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: jitSession },
    });
    const jitUser = me.json<{ user: { id: string; role: string; email: string } }>().user;
    expect(jitUser).toMatchObject({ role: "user", email: "a@example.test" });
    expect(jitUser.id).not.toBe(USER_A_ID);
    const adminDenied = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: jitSession },
    });
    expect(adminDenied.statusCode).toBe(403);

    behavior.subject = "domain-denied-subject";
    behavior.emailSnapshot = "person@outside.test";
    const deniedTransaction = await beginOidcLogin(app);
    const denied = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-b&state=expected-state",
      headers: { cookie: deniedTransaction },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: { code: "OIDC_PROVISIONING_NOT_ALLOWED" },
    });

    behavior.subject = "missing-email-subject";
    behavior.emailSnapshot = null;
    const missingEmailTransaction = await beginOidcLogin(app);
    const missingEmail = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-c&state=expected-state",
      headers: { cookie: missingEmailTransaction },
    });
    expect(missingEmail.statusCode).toBe(403);
    await app.close();
  });

  it("lists, binds, and unbinds stable identities with authorization, audit, and last-login protection", async () => {
    const dependencies = await createTestDependencies();
    configureTestOidc(dependencies);
    configureTestOAuth2(dependencies);
    const app = buildControlPlane(dependencies);
    const admin = await login(app, "admin", "password-for-admin");
    const user = await login(app, "user-a", "password-for-user-a");
    const bind = async (providerId: string, providerSubject: string) =>
      app.inject({
        method: "POST",
        url: `/api/admin/users/${USER_A_ID}/identities`,
        headers: {
          cookie: admin.cookie,
          origin: ORIGIN,
          "x-csrf-token": admin.csrfToken,
        },
        payload: { providerId, providerSubject },
      });

    const oidcBound = await bind("enterprise-oidc", "subject-a");
    const oauthBound = await bind("enterprise-oauth2", "oauth-subject-a");
    expect(oidcBound.statusCode).toBe(201);
    expect(oauthBound.statusCode).toBe(201);
    const userListDenied = await app.inject({
      method: "GET",
      url: `/api/admin/users/${USER_A_ID}/identities`,
      headers: { cookie: user.cookie },
    });
    expect(userListDenied.statusCode).toBe(403);

    const listed = await app.inject({
      method: "GET",
      url: `/api/admin/users/${USER_A_ID}/identities`,
      headers: { cookie: admin.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const identities = listed.json<{ identities: Array<{ id: string; providerId: string }> }>()
      .identities;
    expect(identities.map((identity) => identity.providerId)).toEqual([
      "enterprise-oidc",
      "enterprise-oauth2",
    ]);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${USER_A_ID}/identities/${identities[0]?.id}`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
    });
    expect(removed.statusCode).toBe(204);
    const audit = await app.inject({
      method: "GET",
      url: "/api/audit-events?limit=20",
      headers: { cookie: admin.cookie },
    });
    const identityEvents = audit
      .json<{ events: Array<{ eventType: string; details: Record<string, unknown> }> }>()
      .events.filter((event) => event.eventType.startsWith("identity."));
    expect(identityEvents.map((event) => event.eventType)).toEqual([
      "identity.unbound",
      "identity.bound",
      "identity.bound",
    ]);
    expect(JSON.stringify(identityEvents)).not.toContain("subject-a");

    if (dependencies.oidc === undefined) throw new Error("OIDC test runtime missing");
    dependencies.oidc.autoProvision = true;
    const behavior = configureTestOidc(dependencies);
    dependencies.oidc.autoProvision = true;
    behavior.subject = "external-only";
    behavior.emailSnapshot = "external-only@example.test";
    const externalTransaction = await beginOidcLogin(app);
    const externalLogin = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-d&state=expected-state",
      headers: { cookie: externalTransaction },
    });
    const externalSession = firstCookie(externalLogin, "platform-session");
    const externalMe = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: externalSession },
    });
    const externalUserId = externalMe.json<{ user: { id: string } }>().user.id;
    const externalIdentities = await app.inject({
      method: "GET",
      url: `/api/admin/users/${externalUserId}/identities`,
      headers: { cookie: admin.cookie },
    });
    const onlyIdentity = externalIdentities.json<{ identities: Array<{ id: string }> }>()
      .identities[0];
    if (onlyIdentity === undefined) throw new Error("JIT identity missing");
    const lockedOut = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${externalUserId}/identities/${onlyIdentity.id}`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
    });
    expect(lockedOut.statusCode).toBe(409);
    expect(lockedOut.json()).toMatchObject({
      error: { code: "LAST_LOGIN_METHOD" },
    });
    await app.close();
  });

  it("routes OAuth2 UserInfo profiles through the same JIT and Platform Session chain", async () => {
    const dependencies = await createTestDependencies();
    configureTestOAuth2(dependencies);
    if (dependencies.oauth2 === undefined) throw new Error("OAuth2 test runtime missing");
    dependencies.oauth2.autoProvision = true;
    dependencies.oauth2.allowedDomains = ["example.test"];
    const app = buildControlPlane(dependencies);
    const transaction = await beginOAuth2Login(app);
    const callback = await app.inject({
      method: "GET",
      url: "/auth/oauth2/callback?code=oauth-code&state=oauth-expected-state",
      headers: { cookie: transaction },
    });
    expect(callback.statusCode).toBe(302);
    const session = firstCookie(callback, "platform-session");
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: session },
    });
    expect(me.json()).toMatchObject({
      user: { email: "oauth@example.test", username: "oauth-user-a", role: "user" },
    });
    await app.close();
  });
});

describe("Phase 9 Admin Users", () => {
  it("rejects every Admin Users route for a non-admin", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const user = await login(app, "user-a", "password-for-user-a");
    const headers = {
      cookie: user.cookie,
      origin: ORIGIN,
      "x-csrf-token": user.csrfToken,
    };
    const requests = [
      app.inject({ method: "GET", url: "/api/admin/users", headers }),
      app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers,
        payload: {
          email: "blocked@example.test",
          password: "blocked-password",
        },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/admin/users/${USER_B_ID}`,
        headers,
        payload: { role: "admin" },
      }),
      app.inject({
        method: "POST",
        url: `/api/admin/users/${USER_B_ID}/reset-password`,
        headers,
        payload: { password: "replacement-password" },
      }),
      app.inject({
        method: "POST",
        url: `/api/admin/users/${USER_B_ID}/revoke-sessions`,
        headers,
        payload: {},
      }),
      app.inject({
        method: "GET",
        url: `/api/admin/users/${USER_B_ID}/workspaces`,
        headers,
      }),
    ];

    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.statusCode)).toEqual([
      403, 403, 403, 403, 403, 403,
    ]);
    await app.close();
  });

  it("creates only ordinary Local Users and exposes read-only Workspace metadata", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
    const admin = await login(app, "admin", "password-for-admin");
    const adminHeaders = {
      cookie: admin.cookie,
      origin: ORIGIN,
      "x-csrf-token": admin.csrfToken,
    };
    const forgedAdmin = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: adminHeaders,
      payload: {
        email: "forged-admin@example.test",
        username: "forged-admin",
        password: "phase-nine-password",
        role: "admin",
      },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: adminHeaders,
      payload: {
        email: "phase9@example.test",
        username: "user-phase9",
        password: "phase-nine-password",
      },
    });
    const createdUserId = created.json<{ user: { id: string } }>().user.id;
    const newUser = await login(app, "user-phase9", "phase-nine-password");
    const workspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: newUser.cookie,
        origin: ORIGIN,
        "x-csrf-token": newUser.csrfToken,
      },
      payload: { name: "phase9-owned" },
    });
    const metadata = await app.inject({
      method: "GET",
      url: `/api/admin/users/${createdUserId}/workspaces`,
      headers: { cookie: admin.cookie },
    });
    const adminOwnWorkspaces = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: admin.cookie },
    });
    const ownershipRewrite = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${createdUserId}`,
      headers: adminHeaders,
      payload: { workspaceOwnerId: ADMIN_ID },
    });

    expect(forgedAdmin.statusCode).toBe(400);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      user: { role: "user", status: "active", email: "phase9@example.test" },
    });
    expect(workspace.statusCode).toBe(201);
    expect(metadata.json()).toMatchObject({
      workspaces: [{ name: "phase9-owned" }],
    });
    expect(adminOwnWorkspaces.json()).toEqual({ workspaces: [] });
    expect(ownershipRewrite.statusCode).toBe(400);
    expect(
      dependencies.testState.workspaces.find(
        (candidate) => candidate.name === "phase9-owned",
      )?.userId,
    ).toBe(createdUserId);
    await app.close();
  });

  it("fails closed after disable or revoke and applies role and password changes", async () => {
    const dependencies = await createTestDependencies();
    const sessionConnections = new SessionConnectionRegistry();
    dependencies.sessionConnections = sessionConnections;
    const disabledConnection = vi.fn();
    sessionConnections.register(
      { userId: USER_A_ID, sessionId: "workspace-disabled" },
      disabledConnection,
    );
    const app = buildControlPlane(dependencies);
    const admin = await login(app, "admin", "password-for-admin");
    const user = await login(app, "user-a", "password-for-user-a");
    const preservedWorkspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: user.cookie,
        origin: ORIGIN,
        "x-csrf-token": user.csrfToken,
      },
      payload: { name: "preserved-after-disable" },
    });
    const adminHeaders = {
      cookie: admin.cookie,
      origin: ORIGIN,
      "x-csrf-token": admin.csrfToken,
    };
    const disable = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${USER_A_ID}`,
      headers: adminHeaders,
      payload: { status: "disabled" },
    });
    const existingDisabledSession = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: user.cookie },
    });
    const disabledLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "password-for-user-a" },
    });
    const enable = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${USER_A_ID}`,
      headers: adminHeaders,
      payload: { status: "active" },
    });
    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/reset-password`,
      headers: adminHeaders,
      payload: { password: "replacement-password" },
    });
    const oldPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "password-for-user-a" },
    });
    const replacementSession = await login(app, "user-a", "replacement-password");
    const preservedAfterEnable = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: replacementSession.cookie },
    });
    const promote = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${USER_A_ID}`,
      headers: adminHeaders,
      payload: { role: "admin" },
    });
    const promotedAccess = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: replacementSession.cookie },
    });
    const demote = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${USER_A_ID}`,
      headers: adminHeaders,
      payload: { role: "user" },
    });
    const demotedAccess = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: replacementSession.cookie },
    });
    const revoke = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/revoke-sessions`,
      headers: adminHeaders,
      payload: {},
    });
    const revokedSession = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: replacementSession.cookie },
    });

    expect(disable.statusCode).toBe(200);
    expect(preservedWorkspace.statusCode).toBe(201);
    expect(existingDisabledSession.statusCode).toBe(401);
    expect(disabledLogin.statusCode).toBe(401);
    expect(disabledConnection).toHaveBeenCalledOnce();
    expect(enable.statusCode).toBe(200);
    expect(reset.statusCode).toBe(204);
    expect(oldPassword.statusCode).toBe(401);
    expect(preservedAfterEnable.json()).toMatchObject({
      workspaces: [{ name: "preserved-after-disable" }],
    });
    expect(promote.statusCode).toBe(200);
    expect(promotedAccess.statusCode).toBe(200);
    expect(demote.statusCode).toBe(200);
    expect(demotedAccess.statusCode).toBe(403);
    const revokedConnection = vi.fn();
    sessionConnections.register(
      { userId: USER_A_ID, sessionId: "workspace-revoked" },
      revokedConnection,
    );
    await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/revoke-sessions`,
      headers: adminHeaders,
      payload: {},
    });
    expect(revoke.statusCode).toBe(204);
    expect(revokedSession.statusCode).toBe(401);
    expect(revokedConnection).toHaveBeenCalledOnce();
    await app.close();
  });

  it("refuses to disable or demote the last active Local Admin", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const admin = await login(app, "admin", "password-for-admin");
    const headers = {
      cookie: admin.cookie,
      origin: ORIGIN,
      "x-csrf-token": admin.csrfToken,
    };
    const disable = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${ADMIN_ID}`,
      headers,
      payload: { status: "disabled" },
    });
    const demote = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${ADMIN_ID}`,
      headers,
      payload: { role: "user" },
    });

    expect(disable.statusCode).toBe(409);
    expect(disable.json()).toMatchObject({
      error: { code: "LAST_ACTIVE_LOCAL_ADMIN" },
    });
    expect(demote.statusCode).toBe(409);
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
    const dependencies = await createTestDependencies();
    dependencies.portalAllowedOrigins = ["http://192.168.1.124:5173"];
    const app = buildControlPlane(dependencies);
    const userA = await login(app, "user-a", "password-for-user-a");

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: userA.cookie, origin: "http://192.168.1.124:5173" },
      payload: { name: "blocked" },
    });
    const allowedOrigin = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userA.cookie,
        origin: "http://192.168.1.124:5173",
        "x-csrf-token": userA.csrfToken,
      },
      payload: { name: "allowed" },
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
    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userA.cookie,
        "x-csrf-token": userA.csrfToken,
      },
      payload: { name: "blocked" },
    });

    expect(missingCsrf.statusCode).toBe(403);
    expect(allowedOrigin.statusCode).toBe(201);
    expect(wrongOrigin.statusCode).toBe(403);
    expect(missingOrigin.statusCode).toBe(403);
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
