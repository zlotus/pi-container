import { randomUUID } from "node:crypto";
import { hashOpaqueToken, hashPassword } from "@agent-runtime/auth";
import type {
  AuthenticatedSessionRecord,
  PlatformAuditEvent,
  UserIdentityRecord,
  UserRecord,
  WorkerRecord,
  WorkspaceRecord,
} from "@agent-runtime/database";
import type {
  WorkerToControlMessage,
  WorkspaceDesiredState,
} from "@agent-runtime/protocol";
import { expect, vi } from "vitest";

import type { buildControlPlane, ControlPlaneDependencies } from "../app.js";
import { selectWorker } from "../scheduler.js";
import { WorkspaceSessionExchange } from "../session-exchange.js";
import { type OidcRuntime, OidcTransactionStore } from "../oidc.js";
import { type OAuth2Runtime, OAuth2TransactionStore } from "../oauth2.js";

// Shared in-memory fixtures for the Control Plane route tests.

export const ORIGIN = "http://portal.test";

export const NOW = new Date("2026-09-10T08:00:00.000Z");

export const USER_A_ID = "11111111-1111-4111-8111-111111111111";

export const USER_B_ID = "22222222-2222-4222-8222-222222222222";

export const ADMIN_ID = "33333333-3333-4333-8333-333333333333";

export const WORKER_1_TOKEN = "worker1token0123456789abcdef0123456789abcdef";

export const WORKER_2_TOKEN = "worker2token0123456789abcdef0123456789abcdef";

export interface TestControlPlaneDependencies extends ControlPlaneDependencies {
  testState: {
    workspaces: WorkspaceRecord[];
    workers: WorkerRecord[];
    users: UserRecord[];
    markWorkersOffline(cutoff: Date): number;
    setDesiredState(workspaceId: string, state: WorkspaceDesiredState): void;
  };
}

export async function createTestDependencies(
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
  const addAuditEvent = (
    eventType: string,
    input: {
      actorUserId?: string | null;
      ownerUserId?: string | null;
      details?: Record<string, unknown>;
    } = {},
  ): void => {
    auditEvents.unshift({
      id: String(auditEvents.length + 1),
      eventType,
      actorUserId: input.actorUserId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      workspaceId: null,
      workerId: null,
      details: input.details ?? {},
      createdAt: NOW,
    });
  };
  const workers: WorkerRecord[] = [WORKER_1_TOKEN, WORKER_2_TOKEN].map(
    (_token, index) => ({
      id: `worker-0${index + 1}`,
      hostname: null,
      architecture: null,
      status: "REGISTERED",
      enabled: true,
      schedulable: true,
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
      async setWorkerSchedulable(input) {
        const worker = workers.find((candidate) => candidate.id === input.workerId);
        if (worker === undefined) return { outcome: "NOT_FOUND" };
        if (worker.schedulable !== input.schedulable) {
          worker.schedulable = input.schedulable;
          const { actorUserId, ...request } = input.audit;
          auditEvents.unshift({
            id: String(auditEvents.length + 1),
            eventType: input.schedulable
              ? "worker.scheduling_resumed"
              : "worker.scheduling_paused",
            actorUserId,
            ownerUserId: null,
            workspaceId: null,
            workerId: worker.id,
            details: request,
            createdAt: NOW,
          });
        }
        return {
          outcome: "UPDATED",
          worker: {
            ...worker,
            assignedWorkspaces: workspaces.filter(
              (workspace) => workspace.workerId === worker.id,
            ).length,
          },
        };
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
              input.includeAllUsers ||
              (event.ownerUserId === input.userId &&
                event.eventType.startsWith("workspace.")),
          )
          .filter(
            (event) =>
              input.beforeId === null ||
              BigInt(event.id) < BigInt(input.beforeId),
          )
          .filter((event) => {
            const filter = input.filter ?? {};
            return (
              (filter.category == null || event.eventType.startsWith(`${filter.category}.`)) &&
              (filter.userId == null ||
                event.actorUserId === filter.userId ||
                event.ownerUserId === filter.userId) &&
              (filter.workspaceId == null || event.workspaceId === filter.workspaceId) &&
              (filter.workerId == null || event.workerId === filter.workerId) &&
              (filter.from == null || event.createdAt >= filter.from) &&
              (filter.to == null || event.createdAt < filter.to)
            );
          })
          .slice(0, input.limit);
      },
      async recordAuthenticationFailure(input) {
        addAuditEvent("auth.login_failed", {
          details: { ...input.audit, category: input.category },
        });
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
        if (input.actorUserId !== undefined) {
          addAuditEvent("user.created", {
            actorUserId: input.actorUserId,
            ownerUserId: user.id,
            details: { source: "local", role: input.role },
          });
        }
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
        if (input.audit !== undefined) {
          addAuditEvent("auth.login_succeeded", {
            actorUserId: user.id,
            ownerUserId: user.id,
            details: { ...input.audit },
          });
        }
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
          if (!input.autoProvision) {
            if (input.audit !== undefined) {
              addAuditEvent("auth.login_failed", {
                details: { ...input.audit, category: "identity_not_bound" },
              });
            }
            return { outcome: "UNKNOWN_IDENTITY" as const };
          }
          if (input.provisionedUser === null) {
            if (input.audit !== undefined) {
              addAuditEvent("auth.login_failed", {
                details: {
                  ...input.audit,
                  category: "provisioning_not_allowed",
                },
              });
            }
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
          if (input.audit !== undefined) {
            addAuditEvent("user.created", {
              actorUserId: user.id,
              ownerUserId: user.id,
              details: {
                source: "external",
                providerId: input.providerId,
                role: "user",
                requestId: input.audit.requestId,
              },
            });
          }
        }
        const user = users.find((candidate) => candidate.id === resolvedIdentity.userId);
        if (user === undefined || user.status !== "active") {
          if (input.audit !== undefined) {
            addAuditEvent("auth.login_failed", {
              details: { ...input.audit, category: "user_disabled" },
            });
          }
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
        if (input.audit !== undefined) {
          addAuditEvent("auth.login_succeeded", {
            actorUserId: user.id,
            ownerUserId: user.id,
            details: { ...input.audit, provisioned: identity === undefined },
          });
        }
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
      async revokeSession(tokenHash, _now, audit) {
        const session = sessions.get(tokenHash);
        if (session !== undefined) {
          session.revoked = true;
          if (audit !== undefined) {
            const { actorUserId, ...details } = audit;
            addAuditEvent("auth.logout", {
              actorUserId,
              ownerUserId: actorUserId,
              details,
            });
          }
        }
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
        if (input.audit !== undefined) {
          const { actorUserId, ...request } = input.audit;
          if (user.status !== status) {
            addAuditEvent(status === "active" ? "user.enabled" : "user.disabled", {
              actorUserId,
              ownerUserId: user.id,
              details: { ...request, fromStatus: user.status, toStatus: status },
            });
            if (status === "disabled") {
              addAuditEvent("auth.session_revoked", {
                actorUserId,
                ownerUserId: user.id,
                details: { ...request, reason: "user_disabled" },
              });
            }
          }
          if (user.role !== role) {
            addAuditEvent("user.role_changed", {
              actorUserId,
              ownerUserId: user.id,
              details: { ...request, fromRole: user.role, toRole: role },
            });
          }
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
        if (input.audit !== undefined) {
          const { actorUserId, ...request } = input.audit;
          addAuditEvent("user.password_reset", {
            actorUserId,
            ownerUserId: user.id,
            details: { ...request, method: "local" },
          });
        }
        return true;
      },
      async revokeUserSessions(userId, _revokedAt, audit) {
        if (!users.some((user) => user.id === userId)) return false;
        for (const session of sessions.values()) {
          if (session.userId === userId) session.revoked = true;
        }
        if (audit !== undefined) {
          const { actorUserId, ...request } = audit;
          addAuditEvent("auth.session_revoked", {
            actorUserId,
            ownerUserId: userId,
            details: { ...request, reason: "admin_request" },
          });
        }
        return true;
      },
      async listAllWorkspaces() {
        return workspaces.map((workspace) => {
          const owner = users.find((user) => user.id === workspace.userId);
          return {
            ...workspace,
            ownerUsername: owner?.username ?? null,
            ownerEmail: owner?.email ?? null,
          };
        });
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
              schedulable: worker.schedulable,
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

export async function login(
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

export function configureTestOidc(dependencies: TestControlPlaneDependencies) {
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

export function configureTestOAuth2(dependencies: TestControlPlaneDependencies) {
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

export function firstCookie(response: {
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

export async function beginOidcLogin(app: ReturnType<typeof buildControlPlane>) {
  const response = await app.inject({ method: "GET", url: "/auth/oidc/login" });
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toContain("https://idp.example.test/authorize");
  return firstCookie(response, "oidc-transaction");
}

export async function beginOAuth2Login(app: ReturnType<typeof buildControlPlane>) {
  const response = await app.inject({ method: "GET", url: "/auth/oauth2/login" });
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toContain("https://oauth.example.test/authorize");
  return firstCookie(response, "oauth2-transaction");
}

export function workerHello(workerId: string) {
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

export type WorkerOkResponse = Extract<
  WorkerToControlMessage,
  { type: "response.ok" }
>;

export type ReconcileOkResponse = Omit<WorkerOkResponse, "payload"> & {
  payload: Extract<
    WorkerOkResponse["payload"],
    { requestType: "worker.reconcile" }
  >;
};

export function emptyReconciliation(requestId: string): ReconcileOkResponse {
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
