import { randomUUID } from "node:crypto";

import {
  constantTimeTextEqual,
  deriveCsrfToken,
  generateOpaqueToken,
  hashOpaqueToken,
  verifyPassword,
} from "@agent-runtime/auth";
import type {
  AuthenticatedSessionRecord,
  Phase1Repository,
  Phase2Repository,
  Phase3Repository,
  Phase5Repository,
  Phase6Repository,
  Phase8Repository,
  PlatformAuditEvent,
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

const LoginBodySchema = z
  .object({
    login: z.string().trim().min(3).max(320),
    password: z.string().min(1).max(1_024),
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
    Phase8Repository,
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
  secureCookies: boolean;
  sessionTtlMs: number;
  defaultRuntimeImage: string;
  workerOfflineAfterMs: number;
  workerCommandTimeoutMs: number;
  workspaceResources: WorkspaceResources;
  workspaceBaseUrl: string;
  sessionExchanges: WorkspaceSessionExchange;
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
    createdAt: user.createdAt.toISOString(),
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
    if (request.headers.origin !== dependencies.portalOrigin) {
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
    if (user === null || !passwordMatches) {
      return reply
        .code(401)
        .send(errorBody("INVALID_CREDENTIALS", "Invalid login or password"));
    }

    const rawToken = generateOpaqueToken();
    const expiresAt = new Date(now().getTime() + dependencies.sessionTtlMs);
    await dependencies.store.createSession({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt,
    });

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
    const auth = await authenticate(request, reply);
    if (auth === null) return reply;
    if (auth.session.user.role !== "admin") {
      return reply
        .code(403)
        .send(errorBody("FORBIDDEN", "Administrator access is required"));
    }
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
