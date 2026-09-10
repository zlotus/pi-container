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
  UserRecord,
  WorkerRecord,
  WorkspaceRecord,
} from "@agent-runtime/database";
import websocket from "@fastify/websocket";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";

import { WorkerChannel } from "./worker-channel.js";
import {
  registerWorkerControlChannel,
  type WorkerControlStore,
} from "./worker-control.js";

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

const INVALID_LOGIN_HASH =
  "scrypt$N=16384,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg$91N6IibOCNGoJIaLSVpuW8f6Qg4lxDxxq0yCck7RYgnoDkMSGEYhoP9aqNjR08hwW6OkhlITEQoD_Hoq0k5wxQ";

type Phase1Store = Pick<
  Phase1Repository,
  | "findUserByLogin"
  | "createSession"
  | "findActiveSession"
  | "revokeSession"
  | "listWorkspaces"
  | "createWorkspace"
  | "findOwnedWorkspace"
  | "deleteOwnedWorkspace"
>;

type WorkerAdminStore = Pick<Phase2Repository, "listWorkers">;

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
  now?: () => Date;
}

interface AuthContext {
  rawToken: string;
  session: AuthenticatedSessionRecord;
}

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

function publicWorker(
  worker: WorkerRecord,
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
  const workerChannel = new WorkerChannel(dependencies.workerCommandTimeoutMs);
  void app.register(websocket, {
    options: { maxPayload: 256 * 1024, perMessageDeflate: false },
  });
  void app.register(async (workerControlScope) => {
    registerWorkerControlChannel(workerControlScope, {
      store: dependencies.workerStore,
      channel: workerChannel,
      now,
    });
  });
  const cookieName = dependencies.secureCookies
    ? "__Host-platform-session"
    : "platform-session";

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

  app.get("/api/admin/workers", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) return reply;
    if (auth.session.user.role !== "admin") {
      return reply
        .code(403)
        .send(errorBody("FORBIDDEN", "Administrator access is required"));
    }
    const currentTime = now();
    const workers = await dependencies.workerStore.listWorkers();
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
    if (workspace.workerId !== null || workspace.state !== "CREATED") {
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
