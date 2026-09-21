import { randomUUID } from "node:crypto";

import {
  constantTimeTextEqual,
  deriveCsrfToken,
  generateOpaqueToken,
  hashPassword,
  hashOpaqueToken,
  verifyPassword,
} from "@agent-runtime/auth";
import type {
  AuthenticatedSessionRecord,
  AdminUserRecord,
  Phase1Repository,
  Phase2Repository,
  Phase3Repository,
  Phase5Repository,
  Phase6Repository,
  Phase8Repository,
  Phase9Repository,
  Phase10Repository,
  Phase11Repository,
  PlatformAuditEvent,
  UserIdentityRecord,
  UserRecord,
  WorkerPlacementRecord,
  WorkspaceRecord,
} from "@agent-runtime/database";
import type {
  ControlToWorkerMessage,
  WorkerRecoveryIssue,
  WorkspaceObservation,
  WorkspaceResources,
} from "@agent-runtime/protocol";
import { parseWorkspaceBaseUrl, workspaceOrigin } from "@agent-runtime/gateway";
import websocket from "@fastify/websocket";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";

import { WorkerChannel, WorkerChannelError } from "./worker-channel.js";
import {
  registerWorkerControlChannel,
  type WorkerControlStore,
} from "./worker-control.js";
import type { WorkspaceSessionExchange } from "./session-exchange.js";
import type { SessionConnectionRegistry } from "./session-connections.js";
import type { ExternalIdentityProfile } from "./external-auth.js";
import type { OAuth2Runtime } from "./oauth2.js";
import type { OidcRuntime } from "./oidc.js";

const LoginBodySchema = z
  .object({
    login: z.string().trim().min(3).max(320),
    password: z.string().min(1).max(1_024),
  })
  .strict();

const AdminUserParamsSchema = z.object({ id: z.string().uuid() }).strict();
const AdminIdentityParamsSchema = z
  .object({ id: z.string().uuid(), identityId: z.string().uuid() })
  .strict();

const CreateLocalUserBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/)
      .optional(),
    password: z.string().min(12).max(1_024),
  })
  .strict();

const UpdateManagedUserBodySchema = z
  .object({
    role: z.enum(["user", "admin"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict()
  .refine((value) => value.role !== undefined || value.status !== undefined);

const ResetLocalPasswordBodySchema = z
  .object({ password: z.string().min(12).max(1_024) })
  .strict();

const BindExternalIdentityBodySchema = z
  .object({
    providerId: z.string().min(1).max(128),
    providerSubject: z.string().min(1).max(1_024),
  })
  .strict();

const CreateWorkspaceBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict();

const WorkspaceParamsSchema = z
  .object({ id: z.string().uuid() })
  .strict();

const AuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.string().regex(/^[1-9][0-9]*$/).optional(),
  })
  .strict();

const INVALID_LOGIN_HASH =
  "scrypt$N=16384,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg$91N6IibOCNGoJIaLSVpuW8f6Qg4lxDxxq0yCck7RYgnoDkMSGEYhoP9aqNjR08hwW6OkhlITEQoD_Hoq0k5wxQ";

type Phase1Store = Pick<
  Phase1Repository &
    Phase3Repository &
    Phase5Repository &
    Phase6Repository &
    Phase8Repository &
    Phase9Repository &
    Phase10Repository &
    Phase11Repository,
  | "findUserByLogin"
  | "createSession"
  | "findActiveSession"
  | "revokeSession"
  | "listWorkspaces"
  | "createWorkspace"
  | "findOwnedWorkspace"
  | "deleteOwnedWorkspace"
  | "scheduleWorkspaceStart"
  | "finishWorkspaceStart"
  | "beginWorkspaceStop"
  | "finishWorkspaceStop"
  | "beginWorkspaceDelete"
  | "deleteConfirmedWorkspace"
  | "markWorkspaceRuntimeFailure"
  | "beginWorkerReconciliation"
  | "reconcileWorkspaceRecovery"
  | "deleteRecoveredWorkspace"
  | "recordWorkspaceOpened"
  | "listAuditEvents"
  | "listUsers"
  | "createUser"
  | "updateManagedUser"
  | "resetLocalPassword"
  | "revokeUserSessions"
  | "listManagedUserWorkspaces"
  | "listUserIdentities"
  | "bindExternalIdentity"
  | "unbindExternalIdentity"
  | "completeExternalLogin"
>;

type WorkerAdminStore = Pick<
  Phase2Repository & Phase3Repository & Phase5Repository,
  "listWorkersWithAssignments"
>;

export interface ControlPlaneDependencies {
  checkDatabase: () => Promise<void>;
  store: Phase1Store;
  workerStore: WorkerControlStore & WorkerAdminStore;
  sessionSecret: string;
  portalOrigin: string;
  portalAllowedOrigins?: readonly string[];
  secureCookies: boolean;
  sessionTtlMs: number;
  defaultRuntimeImage: string;
  workerOfflineAfterMs: number;
  workerCommandTimeoutMs: number;
  workspaceResources: WorkspaceResources;
  workspaceBaseUrl: string;
  sessionExchanges: WorkspaceSessionExchange;
  sessionConnections?: SessionConnectionRegistry;
  oidc?: OidcRuntime;
  oauth2?: OAuth2Runtime;
  reportRecoveryIssue?: (
    issue: WorkerRecoveryIssue & { workerId: string },
  ) => void;
  now?: () => Date;
}

interface AuthContext {
  rawToken: string;
  session: AuthenticatedSessionRecord;
}

type WorkspaceRuntimeCommand = Exclude<
  ControlToWorkerMessage,
  { type: "worker.reconcile" }
>;

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) {
    return null;
  }

  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));

  return matches.length === 1 && matches[0] !== "" ? (matches[0] ?? null) : null;
}

function sessionCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

function publicUser(user: Omit<UserRecord, "passwordHash">) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function publicAdminUser(user: AdminUserRecord) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    status: user.status,
    source: user.source,
    workspaceCount: user.workspaceCount,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function publicUserIdentity(identity: UserIdentityRecord) {
  return {
    id: identity.id,
    userId: identity.userId,
    providerId: identity.providerId,
    providerSubject: identity.providerSubject,
    usernameSnapshot: identity.usernameSnapshot,
    emailSnapshot: identity.emailSnapshot,
    displayNameSnapshot: identity.displayNameSnapshot,
    createdAt: identity.createdAt.toISOString(),
    lastLoginAt: identity.lastLoginAt?.toISOString() ?? null,
  };
}

function publicWorkspace(workspace: WorkspaceRecord) {
  return {
    id: workspace.id,
    name: workspace.name,
    workerId: workspace.workerId,
    state: workspace.state,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
    lastActivityAt: workspace.lastActivityAt.toISOString(),
  };
}

function publicAuditEvent(event: PlatformAuditEvent) {
  return {
    id: event.id,
    eventType: event.eventType,
    actorUserId: event.actorUserId,
    ownerUserId: event.ownerUserId,
    workspaceId: event.workspaceId,
    workerId: event.workerId,
    details: event.details,
    createdAt: event.createdAt.toISOString(),
  };
}

function publicWorker(
  worker: WorkerPlacementRecord,
  currentTime: Date,
  offlineAfterMs: number,
) {
  const status = !worker.enabled
    ? "DISABLED"
    : worker.lastHeartbeatAt !== null &&
        currentTime.getTime() - worker.lastHeartbeatAt.getTime() < offlineAfterMs
      ? "ONLINE"
      : "OFFLINE";
  return {
    id: worker.id,
    hostname: worker.hostname,
    architecture: worker.architecture,
    status,
    enabled: worker.enabled,
    runtimeImage: worker.runtimeImage,
    runtimeVersion: worker.runtimeVersion,
    capabilities: worker.capabilities,
    maxWorkspaces: worker.maxWorkspaces,
    assignedWorkspaces: worker.assignedWorkspaces,
    allocatedWorkspaces: worker.allocatedWorkspaces,
    systemResources: worker.systemResources,
    lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString() ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function normalizedJitEmail(
  email: string | null,
  allowedDomains: readonly string[],
): string | null | undefined {
  if (email === null) return allowedDomains.length === 0 ? null : undefined;
  const normalized = email.trim().toLowerCase();
  const parsed = z.string().email().max(320).safeParse(normalized);
  if (!parsed.success) return allowedDomains.length === 0 ? null : undefined;
  const separator = normalized.lastIndexOf("@");
  const domain = normalized.slice(separator + 1);
  if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) return undefined;
  return normalized;
}

function normalizedJitUsername(username: string | null): string | null {
  if (username === null) return null;
  const normalized = username.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)
    ? normalized
    : null;
}

export function buildControlPlane(
  dependencies: ControlPlaneDependencies,
): FastifyInstance {
  const app = Fastify({ logger: false });
  const now = dependencies.now ?? (() => new Date());
  const workspaceBaseUrl = parseWorkspaceBaseUrl(dependencies.workspaceBaseUrl);
  const workerChannel = new WorkerChannel(dependencies.workerCommandTimeoutMs);
  void app.register(websocket, {
    options: { maxPayload: 8 * 1024 * 1024, perMessageDeflate: false },
  });
  const cookieName = dependencies.secureCookies
    ? "__Host-platform-session"
    : "platform-session";
  const oidcTransactionCookieName = dependencies.secureCookies
    ? "__Host-oidc-transaction"
    : "oidc-transaction";
  const oauth2TransactionCookieName = dependencies.secureCookies
    ? "__Host-oauth2-transaction"
    : "oauth2-transaction";
  const externalProviderIds = new Set(
    [dependencies.oidc?.providerId, dependencies.oauth2?.providerId].filter(
      (providerId): providerId is string => providerId !== undefined,
    ),
  );

  async function completeExternalAuthentication(input: {
    protocol: "OIDC" | "OAUTH2";
    providerId: string;
    profile: ExternalIdentityProfile;
    autoProvision: boolean;
    allowedDomains: readonly string[];
    clearedTransactionCookie: string;
    reply: FastifyReply;
  }) {
    const normalizedEmail = normalizedJitEmail(
      input.profile.emailSnapshot,
      input.allowedDomains,
    );
    const rawToken = generateOpaqueToken();
    const authenticatedAt = now();
    const result = await dependencies.store.completeExternalLogin({
      providerId: input.providerId,
      providerSubject: input.profile.subject,
      usernameSnapshot: input.profile.usernameSnapshot,
      emailSnapshot: input.profile.emailSnapshot,
      displayNameSnapshot: input.profile.displayNameSnapshot,
      autoProvision: input.autoProvision,
      provisionedUser:
        normalizedEmail === undefined
          ? null
          : {
              id: randomUUID(),
              email: normalizedEmail,
              username: normalizedJitUsername(input.profile.usernameSnapshot),
            },
      identityId: randomUUID(),
      sessionId: randomUUID(),
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt: new Date(authenticatedAt.getTime() + dependencies.sessionTtlMs),
      authenticatedAt,
    });
    if (result.outcome === "UNKNOWN_IDENTITY") {
      return input.reply
        .code(403)
        .send(
          errorBody(
            `${input.protocol}_IDENTITY_NOT_BOUND`,
            `${input.protocol} identity is not authorized for this platform`,
          ),
        );
    }
    if (result.outcome === "PROVISIONING_NOT_ALLOWED") {
      return input.reply
        .code(403)
        .send(
          errorBody(
            `${input.protocol}_PROVISIONING_NOT_ALLOWED`,
            `${input.protocol} identity is not allowed for JIT provisioning`,
          ),
        );
    }
    if (result.outcome === "USER_DISABLED") {
      return input.reply
        .code(403)
        .send(
          errorBody(
            `${input.protocol}_USER_DISABLED`,
            "Platform User is disabled",
          ),
        );
    }
    input.reply.header("set-cookie", [
      input.clearedTransactionCookie,
      sessionCookie(
        cookieName,
        rawToken,
        Math.floor(dependencies.sessionTtlMs / 1_000),
        dependencies.secureCookies,
      ),
    ]);
    return input.reply.redirect(dependencies.portalOrigin);
  }

  type DispatchResult =
    | {
        ok: true;
        workspace: WorkspaceObservation;
      }
    | {
        ok: false;
        workerOffline: boolean;
        statusCode: 409 | 502 | 503;
        code: string;
        message: string;
      };

  async function dispatchRuntimeCommand(
    workerId: string,
    message: WorkspaceRuntimeCommand,
  ): Promise<DispatchResult> {
    try {
      const response = await workerChannel.dispatch(workerId, message);
      if (response.type === "response.error") {
        return {
          ok: false,
          workerOffline: false,
          statusCode: response.payload.retryable ? 503 : 409,
          code: response.payload.code,
          message: response.payload.message,
        };
      }
      if (response.payload.requestType === "worker.reconcile") {
        return {
          ok: false,
          workerOffline: false,
          statusCode: 502,
          code: "INVALID_WORKER_RESPONSE",
          message: "Worker returned an invalid Workspace result",
        };
      }
      const workspace = response.payload.workspace;
      if (
        workspace === undefined ||
        workspace.workspaceId !== message.payload.workspaceId
      ) {
        return {
          ok: false,
          workerOffline: false,
          statusCode: 502,
          code: "INVALID_WORKER_RESPONSE",
          message: "Worker returned an invalid Workspace result",
        };
      }
      return { ok: true, workspace };
    } catch (error) {
      const workerOffline =
        error instanceof WorkerChannelError &&
        (error.code === "WORKER_NOT_CONNECTED" ||
          error.code === "WORKER_CONNECTION_CLOSED");
      return {
        ok: false,
        workerOffline,
        statusCode: 503,
        code: workerOffline ? "WORKER_UNAVAILABLE" : "WORKER_COMMAND_FAILED",
        message: workerOffline
          ? "Assigned Worker is unavailable"
          : "Worker command did not complete",
      };
    }
  }

  async function reconcileWorkerWorkspaces(workerId: string): Promise<void> {
    const workspaces =
      await dependencies.store.beginWorkerReconciliation(workerId);
    if (!workerChannel.isConnected(workerId)) return;
    let response;
    try {
      response = await workerChannel.dispatch(workerId, {
        version: 1,
        type: "worker.reconcile",
        requestId: randomUUID(),
        payload: {
          assignments: workspaces.map((workspace) => ({
            workspaceId: workspace.id,
            runtimeImage: workspace.runtimeImage,
            desiredState: workspace.desiredState,
          })),
        },
      });
    } catch {
      return;
    }
    if (
      response.type !== "response.ok" ||
      response.payload.requestType !== "worker.reconcile"
    ) {
      return;
    }

    const report = response.payload.reconciliation;
    const results = new Map(
      report.workspaces.map((result) => [
        result.status === "OBSERVED"
          ? result.workspace.workspaceId
          : result.workspaceId,
        result,
      ]),
    );
    if (
      results.size !== workspaces.length ||
      workspaces.some((workspace) => !results.has(workspace.id))
    ) {
      return;
    }
    for (const issue of report.issues) {
      dependencies.reportRecoveryIssue?.({ workerId, ...issue });
    }

    for (const workspace of workspaces) {
      if (!workerChannel.isConnected(workerId)) return;
      const result = results.get(workspace.id);
      if (result === undefined) return;
      if (
        result.status === "MISSING" &&
        workspace.desiredState === "DELETED"
      ) {
        await dependencies.store.deleteRecoveredWorkspace({
          workspaceId: workspace.id,
          userId: workspace.userId,
          workerId,
          runtimeImage: workspace.runtimeImage,
        });
        continue;
      }
      if (result.status === "INVALID" && result.retryable) continue;

      let state: "RUNNING" | "STOPPED" | "ERROR" = "ERROR";
      if (
        result.status === "OBSERVED" &&
        result.workspace.runtimeImage === workspace.runtimeImage
      ) {
        if (
          workspace.desiredState === "RUNNING" &&
          result.workspace.state === "RUNNING"
        ) {
          state = "RUNNING";
        } else if (
          workspace.desiredState === "STOPPED" &&
          result.workspace.state === "STOPPED"
        ) {
          state = "STOPPED";
        } else if (
          workspace.desiredState === "UNKNOWN" &&
          (result.workspace.state === "RUNNING" ||
            result.workspace.state === "STOPPED")
        ) {
          state = result.workspace.state;
        }
      }
      await dependencies.store.reconcileWorkspaceRecovery({
        workspaceId: workspace.id,
        workerId,
        runtimeImage: workspace.runtimeImage,
        desiredState: workspace.desiredState,
        state,
      });
    }
  }

  void app.register(async (workerControlScope) => {
    registerWorkerControlChannel(workerControlScope, {
      store: dependencies.workerStore,
      channel: workerChannel,
      now,
      onHelloAccepted: (workerId) => {
        void reconcileWorkerWorkspaces(workerId).catch(() => {
          // The Workspace stays WORKER_OFFLINE when reconciliation cannot be
          // completed. A later Worker reconnect can safely try again.
        });
      },
    });
  });

  async function markRuntimeFailure(
    workspaceId: string,
    workerId: string,
    result: Extract<DispatchResult, { ok: false }>,
  ): Promise<void> {
    await dependencies.store.markWorkspaceRuntimeFailure({
      workspaceId,
      workerId,
      workerOffline: result.workerOffline,
    });
  }

  function sendDispatchFailure(
    reply: FastifyReply,
    result: Extract<DispatchResult, { ok: false }>,
  ) {
    return reply
      .code(result.statusCode)
      .send(errorBody(result.code, result.message));
  }

  function validateRuntimeResult(
    result: Extract<DispatchResult, { ok: true }>,
    expectedRuntimeImage: string,
    expectedStates: readonly string[],
  ): Extract<DispatchResult, { ok: false }> | null {
    if (
      result.workspace.runtimeImage === expectedRuntimeImage &&
      expectedStates.includes(result.workspace.state)
    ) {
      return null;
    }
    return {
      ok: false,
      workerOffline: false,
      statusCode: 502,
      code: "INVALID_WORKER_RESPONSE",
      message: "Worker returned an unexpected Runtime result",
    };
  }

  function validateOrigin(request: FastifyRequest, reply: FastifyReply): boolean {
    const origin = request.headers.origin;
    if (
      origin === undefined ||
      (origin !== dependencies.portalOrigin &&
        !dependencies.portalAllowedOrigins?.includes(origin))
    ) {
      void reply
        .code(403)
        .send(errorBody("INVALID_ORIGIN", "Request origin is not allowed"));
      return false;
    }
    return true;
  }

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthContext | null> {
    const rawToken = parseCookie(request.headers.cookie, cookieName);
    if (rawToken === null) {
      await reply
        .code(401)
        .send(errorBody("UNAUTHENTICATED", "Authentication is required"));
      return null;
    }

    const session = await dependencies.store.findActiveSession(
      hashOpaqueToken(rawToken),
      now(),
    );
    if (session === null) {
      await reply
        .code(401)
        .send(errorBody("UNAUTHENTICATED", "Authentication is required"));
      return null;
    }
    return { rawToken, session };
  }

  async function authenticateAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthContext | null> {
    const auth = await authenticate(request, reply);
    if (auth === null) return null;
    if (auth.session.user.role !== "admin") {
      await reply
        .code(403)
        .send(errorBody("FORBIDDEN", "Administrator access is required"));
      return null;
    }
    return auth;
  }

  function validateCsrf(
    request: FastifyRequest,
    reply: FastifyReply,
    rawToken: string,
  ): boolean {
    const supplied = request.headers["x-csrf-token"];
    const expected = deriveCsrfToken(rawToken, dependencies.sessionSecret);
    if (
      typeof supplied !== "string" ||
      !constantTimeTextEqual(supplied, expected)
    ) {
      void reply
        .code(403)
        .send(errorBody("INVALID_CSRF", "CSRF validation failed"));
      return false;
    }
    return true;
  }

  app.get("/health", async () => ({
    service: "control-plane",
    status: "ok",
  }));

  app.get("/ready", async (_request, reply) => {
    try {
      await dependencies.checkDatabase();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.get("/api/auth/methods", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      oidc: {
        enabled: dependencies.oidc !== undefined,
        providerId: dependencies.oidc?.providerId ?? null,
      },
      oauth2: {
        enabled: dependencies.oauth2 !== undefined,
        providerId: dependencies.oauth2?.providerId ?? null,
      },
    };
  });

  app.get("/auth/oidc/login", async (_request, reply) => {
    if (dependencies.oidc === undefined) {
      return reply
        .code(404)
        .send(errorBody("OIDC_DISABLED", "OIDC login is not enabled"));
    }
    try {
      const authorization =
        await dependencies.oidc.client.createAuthorizationRequest(
          dependencies.oidc.redirectUri,
        );
      const handle = dependencies.oidc.transactions.create(
        authorization.transaction,
        now(),
      );
      reply.header(
        "set-cookie",
        sessionCookie(
          oidcTransactionCookieName,
          handle,
          10 * 60,
          dependencies.secureCookies,
        ),
      );
      reply.header("cache-control", "no-store");
      return reply.redirect(authorization.url.href);
    } catch {
      return reply
        .code(503)
        .send(errorBody("OIDC_UNAVAILABLE", "OIDC login is unavailable"));
    }
  });

  app.get("/auth/oidc/callback", async (request, reply) => {
    if (dependencies.oidc === undefined) {
      return reply
        .code(404)
        .send(errorBody("OIDC_DISABLED", "OIDC login is not enabled"));
    }
    const clearedTransactionCookie = sessionCookie(
      oidcTransactionCookieName,
      "",
      0,
      dependencies.secureCookies,
    );
    reply.header("set-cookie", clearedTransactionCookie);
    reply.header("cache-control", "no-store");
    const handle = parseCookie(
      request.headers.cookie,
      oidcTransactionCookieName,
    );
    const transaction =
      handle === null
        ? null
        : dependencies.oidc.transactions.consume(handle, now());
    if (transaction === null) {
      return reply
        .code(400)
        .send(
          errorBody(
            "OIDC_TRANSACTION_INVALID",
            "OIDC login transaction is missing, expired, or already used",
          ),
        );
    }

    let identity: ExternalIdentityProfile;
    try {
      const requestUrl = new URL(
        request.raw.url ?? "/",
        "http://callback.invalid",
      );
      const callbackUrl = new URL(dependencies.oidc.redirectUri);
      callbackUrl.search = requestUrl.search;
      identity = await dependencies.oidc.client.exchangeAuthorizationCode({
        callbackUrl,
        redirectUri: dependencies.oidc.redirectUri,
        transaction,
      });
    } catch {
      return reply
        .code(401)
        .send(
          errorBody(
            "OIDC_AUTHENTICATION_FAILED",
            "OIDC authentication failed",
          ),
        );
    }

    return completeExternalAuthentication({
      protocol: "OIDC",
      providerId: dependencies.oidc.providerId,
      profile: identity,
      autoProvision: dependencies.oidc.autoProvision,
      allowedDomains: dependencies.oidc.allowedDomains,
      clearedTransactionCookie,
      reply,
    });
  });

  app.get("/auth/oauth2/login", async (_request, reply) => {
    if (dependencies.oauth2 === undefined) {
      return reply
        .code(404)
        .send(errorBody("OAUTH2_DISABLED", "OAuth2 login is not enabled"));
    }
    try {
      const authorization =
        await dependencies.oauth2.client.createAuthorizationRequest(
          dependencies.oauth2.redirectUri,
        );
      const handle = dependencies.oauth2.transactions.create(
        authorization.transaction,
        now(),
      );
      reply.header(
        "set-cookie",
        sessionCookie(
          oauth2TransactionCookieName,
          handle,
          10 * 60,
          dependencies.secureCookies,
        ),
      );
      reply.header("cache-control", "no-store");
      return reply.redirect(authorization.url.href);
    } catch {
      return reply
        .code(503)
        .send(errorBody("OAUTH2_UNAVAILABLE", "OAuth2 login is unavailable"));
    }
  });

  app.get("/auth/oauth2/callback", async (request, reply) => {
    if (dependencies.oauth2 === undefined) {
      return reply
        .code(404)
        .send(errorBody("OAUTH2_DISABLED", "OAuth2 login is not enabled"));
    }
    const clearedTransactionCookie = sessionCookie(
      oauth2TransactionCookieName,
      "",
      0,
      dependencies.secureCookies,
    );
    reply.header("set-cookie", clearedTransactionCookie);
    reply.header("cache-control", "no-store");
    const handle = parseCookie(
      request.headers.cookie,
      oauth2TransactionCookieName,
    );
    const transaction =
      handle === null
        ? null
        : dependencies.oauth2.transactions.consume(handle, now());
    if (transaction === null) {
      return reply
        .code(400)
        .send(
          errorBody(
            "OAUTH2_TRANSACTION_INVALID",
            "OAuth2 login transaction is missing, expired, or already used",
          ),
        );
    }

    let identity: ExternalIdentityProfile;
    try {
      const requestUrl = new URL(
        request.raw.url ?? "/",
        "http://callback.invalid",
      );
      const callbackUrl = new URL(dependencies.oauth2.redirectUri);
      callbackUrl.search = requestUrl.search;
      identity = await dependencies.oauth2.client.exchangeAuthorizationCode({
        callbackUrl,
        redirectUri: dependencies.oauth2.redirectUri,
        transaction,
      });
    } catch {
      return reply
        .code(401)
        .send(
          errorBody(
            "OAUTH2_AUTHENTICATION_FAILED",
            "OAuth2 authentication failed",
          ),
        );
    }
    return completeExternalAuthentication({
      protocol: "OAUTH2",
      providerId: dependencies.oauth2.providerId,
      profile: identity,
      autoProvision: dependencies.oauth2.autoProvision,
      allowedDomains: dependencies.oauth2.allowedDomains,
      clearedTransactionCookie,
      reply,
    });
  });

  app.post("/api/auth/login", async (request, reply) => {
    if (!validateOrigin(request, reply)) {
      return reply;
    }
    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid login request"));
    }

    const user = await dependencies.store.findUserByLogin(parsed.data.login);
    const passwordMatches = await verifyPassword(
      parsed.data.password,
      user?.passwordHash ?? INVALID_LOGIN_HASH,
    );
    if (user === null || !passwordMatches || user.status !== "active") {
      return reply
        .code(401)
        .send(errorBody("INVALID_CREDENTIALS", "Invalid login or password"));
    }

    const rawToken = generateOpaqueToken();
    const expiresAt = new Date(now().getTime() + dependencies.sessionTtlMs);
    const created = await dependencies.store.createSession({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt,
    });
    if (!created) {
      return reply
        .code(401)
        .send(errorBody("INVALID_CREDENTIALS", "Invalid login or password"));
    }

    reply.header(
      "set-cookie",
      sessionCookie(
        cookieName,
        rawToken,
        Math.floor(dependencies.sessionTtlMs / 1_000),
        dependencies.secureCookies,
      ),
    );
    reply.header("cache-control", "no-store");
    return {
      user: publicUser(user),
      csrfToken: deriveCsrfToken(rawToken, dependencies.sessionSecret),
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }

    await dependencies.store.revokeSession(hashOpaqueToken(auth.rawToken), now());
    dependencies.sessionConnections?.closeSession(auth.session.sessionId);
    reply.header(
      "set-cookie",
      sessionCookie(cookieName, "", 0, dependencies.secureCookies),
    );
    return reply.code(204).send();
  });

  app.get("/api/me", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    reply.header("cache-control", "no-store");
    return {
      user: publicUser(auth.session.user),
      csrfToken: deriveCsrfToken(auth.rawToken, dependencies.sessionSecret),
    };
  });

  app.get("/api/workspaces", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    const workspaces = await dependencies.store.listWorkspaces(
      auth.session.user.id,
    );
    return { workspaces: workspaces.map(publicWorkspace) };
  });

  app.get("/api/audit-events", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) return reply;
    const query = AuditQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid audit event cursor"));
    }
    const events = await dependencies.store.listAuditEvents({
      userId: auth.session.user.id,
      includeAllUsers: auth.session.user.role === "admin",
      limit: query.data.limit,
      beforeId: query.data.before ?? null,
    });
    reply.header("cache-control", "no-store");
    return { events: events.map(publicAuditEvent) };
  });

  app.get("/api/admin/workers", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const currentTime = now();
    const workers = await dependencies.workerStore.listWorkersWithAssignments();
    reply.header("cache-control", "no-store");
    return {
      workers: workers.map((worker) =>
        publicWorker(
          worker,
          currentTime,
          dependencies.workerOfflineAfterMs,
        ),
      ),
    };
  });

  app.get("/api/admin/users", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const users = await dependencies.store.listUsers();
    reply.header("cache-control", "no-store");
    return { users: users.map(publicAdminUser) };
  });

  app.post("/api/admin/users", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const parsed = CreateLocalUserBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid Local User details"));
    }
    try {
      const user = await dependencies.store.createUser({
        id: randomUUID(),
        email: parsed.data.email,
        username: parsed.data.username ?? null,
        passwordHash: await hashPassword(parsed.data.password),
        role: "user",
      });
      return reply.code(201).send({ user: publicUser(user) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply
          .code(409)
          .send(errorBody("USER_ALREADY_EXISTS", "Email or username already exists"));
      }
      throw error;
    }
  });

  app.get("/api/admin/users/:id/identities", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const params = AdminUserParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid User identity lookup"));
    }
    const identities = await dependencies.store.listUserIdentities(params.data.id);
    if (identities === null) {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    reply.header("cache-control", "no-store");
    return { identities: identities.map(publicUserIdentity) };
  });

  const bindIdentityHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const legacyOidcRoute = request.url.includes("/oidc-identities");
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    if (
      (legacyOidcRoute && dependencies.oidc === undefined) ||
      (!legacyOidcRoute && externalProviderIds.size === 0)
    ) {
      return reply
        .code(409)
        .send(
          legacyOidcRoute
            ? errorBody("OIDC_DISABLED", "OIDC login is not enabled")
            : errorBody("EXTERNAL_AUTH_DISABLED", "External login is not enabled"),
        );
    }
    const params = AdminUserParamsSchema.safeParse(request.params);
    const body = BindExternalIdentityBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid external identity binding"));
    }
    if (
      (legacyOidcRoute && body.data.providerId !== dependencies.oidc?.providerId) ||
      (!legacyOidcRoute && !externalProviderIds.has(body.data.providerId))
    ) {
      return reply
        .code(400)
        .send(
          errorBody(
            legacyOidcRoute
              ? "OIDC_PROVIDER_MISMATCH"
              : "EXTERNAL_PROVIDER_MISMATCH",
            "Identity provider does not match the configured provider",
          ),
        );
    }
    const result = await dependencies.store.bindExternalIdentity({
      id: randomUUID(),
      userId: params.data.id,
      providerId: body.data.providerId,
      providerSubject: body.data.providerSubject,
      actorUserId: auth.session.user.id,
    });
    if (result.outcome === "USER_NOT_FOUND") {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    if (result.outcome === "IDENTITY_ALREADY_BOUND") {
      return reply
        .code(409)
        .send(
          errorBody(
            legacyOidcRoute
              ? "OIDC_IDENTITY_ALREADY_BOUND"
              : "EXTERNAL_IDENTITY_ALREADY_BOUND",
            `${legacyOidcRoute ? "OIDC" : "External"} identity is already bound`,
          ),
        );
    }
    reply.header("cache-control", "no-store");
    return reply
      .code(201)
      .send({ identity: publicUserIdentity(result.identity) });
  };
  app.post("/api/admin/users/:id/identities", bindIdentityHandler);
  app.post("/api/admin/users/:id/oidc-identities", bindIdentityHandler);

  app.delete(
    "/api/admin/users/:id/identities/:identityId",
    async (request, reply) => {
      const auth = await authenticateAdmin(request, reply);
      if (auth === null) return reply;
      if (
        !validateOrigin(request, reply) ||
        !validateCsrf(request, reply, auth.rawToken)
      ) {
        return reply;
      }
      const params = AdminIdentityParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .code(400)
          .send(errorBody("INVALID_REQUEST", "Invalid external identity"));
      }
      const result = await dependencies.store.unbindExternalIdentity({
        userId: params.data.id,
        identityId: params.data.identityId,
        actorUserId: auth.session.user.id,
      });
      if (result.outcome === "USER_NOT_FOUND") {
        return reply
          .code(404)
          .send(errorBody("USER_NOT_FOUND", "User was not found"));
      }
      if (result.outcome === "IDENTITY_NOT_FOUND") {
        return reply
          .code(404)
          .send(errorBody("IDENTITY_NOT_FOUND", "Identity was not found"));
      }
      if (result.outcome === "LAST_LOGIN_METHOD") {
        return reply
          .code(409)
          .send(
            errorBody(
              "LAST_LOGIN_METHOD",
              "At least one usable login method must remain",
            ),
          );
      }
      return reply.code(204).send();
    },
  );

  app.patch("/api/admin/users/:id", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = AdminUserParamsSchema.safeParse(request.params);
    const body = UpdateManagedUserBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid User update"));
    }
    const result = await dependencies.store.updateManagedUser({
      userId: params.data.id,
      ...(body.data.role === undefined ? {} : { role: body.data.role }),
      ...(body.data.status === undefined ? {} : { status: body.data.status }),
    });
    if (result.outcome === "NOT_FOUND") {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    if (result.outcome === "LAST_ACTIVE_LOCAL_ADMIN") {
      return reply
        .code(409)
        .send(
          errorBody(
            "LAST_ACTIVE_LOCAL_ADMIN",
            "At least one active Local Admin must remain",
          ),
        );
    }
    if (result.user.status === "disabled") {
      dependencies.sessionConnections?.closeUser(result.user.id);
    }
    reply.header("cache-control", "no-store");
    return { user: publicAdminUser(result.user) };
  });

  app.post("/api/admin/users/:id/reset-password", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = AdminUserParamsSchema.safeParse(request.params);
    const body = ResetLocalPasswordBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid password reset"));
    }
    const updated = await dependencies.store.resetLocalPassword({
      userId: params.data.id,
      passwordHash: await hashPassword(body.data.password),
    });
    if (!updated) {
      return reply
        .code(404)
        .send(errorBody("LOCAL_USER_NOT_FOUND", "Local User was not found"));
    }
    return reply.code(204).send();
  });

  app.post("/api/admin/users/:id/revoke-sessions", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = AdminUserParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid User identifier"));
    }
    const revoked = await dependencies.store.revokeUserSessions(
      params.data.id,
      now(),
    );
    if (!revoked) {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    dependencies.sessionConnections?.closeUser(params.data.id);
    return reply.code(204).send();
  });

  app.get("/api/admin/users/:id/workspaces", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const params = AdminUserParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    const workspaces = await dependencies.store.listManagedUserWorkspaces(
      params.data.id,
    );
    if (workspaces === null) {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    reply.header("cache-control", "no-store");
    return { workspaces: workspaces.map(publicWorkspace) };
  });

  app.post("/api/workspaces", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const parsed = CreateWorkspaceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Workspace name is required"));
    }

    try {
      const workspace = await dependencies.store.createWorkspace({
        id: randomUUID(),
        userId: auth.session.user.id,
        name: parsed.data.name,
        runtimeImage: dependencies.defaultRuntimeImage,
      });
      return reply.code(201).send({ workspace: publicWorkspace(workspace) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply
          .code(409)
          .send(errorBody("WORKSPACE_NAME_EXISTS", "Workspace name already exists"));
      }
      throw error;
    }
  });

  app.get("/api/workspaces/:id", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    const params = WorkspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    const workspace = await dependencies.store.findOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (workspace === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    return { workspace: publicWorkspace(workspace) };
  });

  app.post("/api/workspaces/:id/start", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = WorkspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    const workspace = await dependencies.store.findOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (workspace === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    if (workspace.state === "RUNNING") {
      return { workspace: publicWorkspace(workspace) };
    }

    if (
      workspace.workerId !== null &&
      !workerChannel.isConnected(workspace.workerId)
    ) {
      return reply
        .code(503)
        .send(errorBody("WORKER_UNAVAILABLE", "Assigned Worker is unavailable"));
    }

    const scheduling = await dependencies.store.scheduleWorkspaceStart({
      workspaceId: workspace.id,
      userId: auth.session.user.id,
      heartbeatCutoff: new Date(
        now().getTime() - dependencies.workerOfflineAfterMs,
      ),
      connectedWorkerIds: workerChannel.connectedWorkerIds(),
    });
    if (scheduling.outcome === "NO_ELIGIBLE_WORKER") {
      return reply
        .code(503)
        .send(
          errorBody(
            "NO_ELIGIBLE_WORKER",
            "No eligible Worker is online for this Runtime",
          ),
        );
    }
    if (scheduling.outcome === "WORKSPACE_CHANGED") {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
    }
    const starting = scheduling.workspace;
    const workerId = starting.workerId;
    if (workerId === null) {
      throw new Error("Scheduler returned a Workspace without a Worker");
    }
    if (!workerChannel.isConnected(workerId)) {
      const unavailable: Extract<DispatchResult, { ok: false }> = {
        ok: false,
        workerOffline: true,
        statusCode: 503,
        code: "WORKER_UNAVAILABLE",
        message: "Assigned Worker is unavailable",
      };
      await markRuntimeFailure(workspace.id, workerId, unavailable);
      return sendDispatchFailure(reply, unavailable);
    }

    const ensured = await dispatchRuntimeCommand(workerId, {
      version: 1,
      type: "workspace.ensure",
      requestId: randomUUID(),
      payload: {
        workspaceId: workspace.id,
        runtimeImage: workspace.runtimeImage,
        resources: dependencies.workspaceResources,
      },
    });
    if (!ensured.ok) {
      await markRuntimeFailure(workspace.id, workerId, ensured);
      return sendDispatchFailure(reply, ensured);
    }
    const invalidEnsure = validateRuntimeResult(
      ensured,
      workspace.runtimeImage,
      ["RUNNING", "STOPPED"],
    );
    if (invalidEnsure !== null) {
      await markRuntimeFailure(workspace.id, workerId, invalidEnsure);
      return sendDispatchFailure(reply, invalidEnsure);
    }
    const started = await dispatchRuntimeCommand(workerId, {
      version: 1,
      type: "workspace.start",
      requestId: randomUUID(),
      payload: { workspaceId: workspace.id },
    });
    if (!started.ok) {
      await markRuntimeFailure(workspace.id, workerId, started);
      return sendDispatchFailure(reply, started);
    }
    const invalidStart = validateRuntimeResult(started, workspace.runtimeImage, [
      "RUNNING",
    ]);
    if (invalidStart !== null) {
      await markRuntimeFailure(workspace.id, workerId, invalidStart);
      return sendDispatchFailure(reply, invalidStart);
    }
    if (
      !(await dependencies.store.finishWorkspaceStart({
        workspaceId: workspace.id,
        workerId,
      }))
    ) {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
    }
    const running = await dependencies.store.findOwnedWorkspace(
      workspace.id,
      auth.session.user.id,
    );
    if (running === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    return { workspace: publicWorkspace(running) };
  });

  app.post("/api/workspaces/:id/stop", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = WorkspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    const workspace = await dependencies.store.findOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (workspace === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    if (workspace.state === "STOPPED") {
      return { workspace: publicWorkspace(workspace) };
    }
    const workerId = workspace.workerId;
    if (workerId === null || !workerChannel.isConnected(workerId)) {
      return reply
        .code(503)
        .send(errorBody("WORKER_UNAVAILABLE", "Assigned Worker is unavailable"));
    }
    if (
      !(await dependencies.store.beginWorkspaceStop({
        workspaceId: workspace.id,
        userId: auth.session.user.id,
        workerId,
      }))
    ) {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_CHANGED", "Workspace is not running"));
    }
    const stopped = await dispatchRuntimeCommand(workerId, {
      version: 1,
      type: "workspace.stop",
      requestId: randomUUID(),
      payload: { workspaceId: workspace.id },
    });
    if (!stopped.ok) {
      await markRuntimeFailure(workspace.id, workerId, stopped);
      return sendDispatchFailure(reply, stopped);
    }
    const invalidStop = validateRuntimeResult(stopped, workspace.runtimeImage, [
      "STOPPED",
    ]);
    if (invalidStop !== null) {
      await markRuntimeFailure(workspace.id, workerId, invalidStop);
      return sendDispatchFailure(reply, invalidStop);
    }
    if (
      !(await dependencies.store.finishWorkspaceStop({
        workspaceId: workspace.id,
        workerId,
      }))
    ) {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
    }
    const current = await dependencies.store.findOwnedWorkspace(
      workspace.id,
      auth.session.user.id,
    );
    if (current === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    return { workspace: publicWorkspace(current) };
  });

  app.post("/api/workspaces/:id/open", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = WorkspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    const workspace = await dependencies.store.findOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (workspace === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    if (workspace.state !== "RUNNING" || workspace.workerId === null) {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_NOT_RUNNING", "Workspace is not running"));
    }
    await dependencies.store.recordWorkspaceOpened({
      actorUserId: auth.session.user.id,
      ownerUserId: workspace.userId,
      workspaceId: workspace.id,
      workerId: workspace.workerId,
    });
    const code = dependencies.sessionExchanges.issue({
      rawSessionToken: auth.rawToken,
      userId: auth.session.user.id,
      workspaceId: workspace.id,
      now: now(),
    });
    reply.header("cache-control", "no-store");
    return {
      exchangeUrl: `${workspaceOrigin(workspace.id, workspaceBaseUrl)}/_platform/session`,
      code,
    };
  });

  app.delete("/api/workspaces/:id", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = WorkspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }

    const workspace = await dependencies.store.findOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (workspace === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    if (workspace.workerId !== null) {
      if (!workerChannel.isConnected(workspace.workerId)) {
        return reply
          .code(503)
          .send(
            errorBody("WORKER_UNAVAILABLE", "Assigned Worker is unavailable"),
          );
      }
      const deleting = await dependencies.store.beginWorkspaceDelete({
        workspaceId: workspace.id,
        userId: auth.session.user.id,
        workerId: workspace.workerId,
      });
      if (!deleting) {
        return reply
          .code(409)
          .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
      }
      const deleted = await dispatchRuntimeCommand(workspace.workerId, {
        version: 1,
        type: "workspace.delete",
        requestId: randomUUID(),
        payload: { workspaceId: workspace.id },
      });
      if (!deleted.ok) {
        await markRuntimeFailure(workspace.id, workspace.workerId, deleted);
        return sendDispatchFailure(reply, deleted);
      }
      const invalidDelete = validateRuntimeResult(
        deleted,
        workspace.runtimeImage,
        ["CREATED"],
      );
      if (invalidDelete !== null) {
        await markRuntimeFailure(workspace.id, workspace.workerId, invalidDelete);
        return sendDispatchFailure(reply, invalidDelete);
      }
      const confirmed = await dependencies.store.deleteConfirmedWorkspace({
        workspaceId: workspace.id,
        userId: auth.session.user.id,
        workerId: workspace.workerId,
      });
      if (!confirmed) {
        return reply
          .code(409)
          .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
      }
      return reply.code(204).send();
    }
    if (workspace.state !== "CREATED") {
      return reply
        .code(409)
        .send(
          errorBody(
            "WORKSPACE_DELETE_REQUIRES_WORKER",
            "Assigned workspace deletion must be confirmed by its worker",
          ),
        );
    }

    const deleted = await dependencies.store.deleteOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (!deleted) {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
    }
    return reply.code(204).send();
  });

  return app;
}
