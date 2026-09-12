import { constantTimeTextEqual } from "@agent-runtime/auth";
import {
  parseWorkspaceBaseUrl,
  proxyHttpRequest,
  proxyWebSocketUpgrade,
  rejectUpgrade,
  sanitizeRequestHeaders,
  sendJsonError,
  stripPlatformCookies,
  workspaceHost,
} from "@agent-runtime/gateway";
import { WorkerTokenSchema, WorkspaceIdSchema } from "@agent-runtime/protocol";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import type { Duplex } from "node:stream";

export interface WorkerGatewayDependencies {
  gatewayToken: string;
  workspaceBaseUrl: string;
  resolveWorkspaceTarget: (workspaceId: string) => Promise<URL>;
  tls?: Pick<HttpsServerOptions, "cert" | "key">;
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return null;
  const parsed = WorkerTokenSchema.safeParse(header.slice("Bearer ".length));
  return parsed.success ? parsed.data : null;
}

function authenticated(request: IncomingMessage, expectedToken: string): boolean {
  const supplied = bearerToken(request);
  return supplied !== null && constantTimeTextEqual(supplied, expectedToken);
}

function requestedWorkspace(request: IncomingMessage): string | null {
  const supplied = request.headers["x-platform-workspace-id"];
  if (typeof supplied !== "string") return null;
  const parsed = WorkspaceIdSchema.safeParse(supplied);
  return parsed.success ? parsed.data : null;
}

function forwardedHeaders(
  request: IncomingMessage,
  target: URL,
) {
  const cookie = stripPlatformCookies(request.headers.cookie);
  return sanitizeRequestHeaders(request.headers, {
    authorization: undefined,
    cookie,
    host: target.host,
    origin:
      request.headers.origin === undefined ? undefined : target.origin,
    "x-platform-workspace-id": undefined,
  });
}

async function authorizeTarget(
  request: IncomingMessage,
  dependencies: WorkerGatewayDependencies,
): Promise<{ target: URL; publicOrigin: string } | null> {
  if (!authenticated(request, dependencies.gatewayToken)) return null;
  const workspaceId = requestedWorkspace(request);
  if (workspaceId === null) return null;
  const base = parseWorkspaceBaseUrl(dependencies.workspaceBaseUrl);
  const expectedHost = workspaceHost(workspaceId, base);
  const expectedOrigin = `${base.protocol}//${expectedHost}`;
  if (
    request.headers.host !== expectedHost ||
    request.headers["x-forwarded-host"] !== expectedHost ||
    request.headers["x-forwarded-proto"] !== base.protocol.slice(0, -1) ||
    request.headers["sec-fetch-site"] === "cross-site" ||
    (request.headers.origin !== undefined &&
      request.headers.origin !== expectedOrigin)
  ) {
    return null;
  }
  const target = await dependencies.resolveWorkspaceTarget(workspaceId);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    target.pathname !== "/" ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    throw new Error("Runtime returned an invalid Gateway target");
  }
  return {
    target,
    publicOrigin: `${base.protocol}//${expectedHost}`,
  };
}

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: WorkerGatewayDependencies,
): Promise<void> {
  if (request.method === "CONNECT") {
    sendJsonError(response, 400, "INVALID_REQUEST", "CONNECT is not supported");
    return;
  }
  let authorized;
  try {
    authorized = await authorizeTarget(request, dependencies);
  } catch {
    sendJsonError(
      response,
      503,
      "WORKSPACE_UNAVAILABLE",
      "Workspace Runtime is unavailable",
    );
    return;
  }
  if (authorized === null) {
    sendJsonError(response, 401, "UNAUTHORIZED_GATEWAY", "Gateway authentication failed");
    return;
  }
  proxyHttpRequest(request, response, {
    target: authorized.target,
    requestHeaders: forwardedHeaders(
      request,
      authorized.target,
    ),
    publicOrigin: authorized.publicOrigin,
  });
}

async function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  dependencies: WorkerGatewayDependencies,
): Promise<void> {
  let authorized;
  try {
    authorized = await authorizeTarget(request, dependencies);
  } catch {
    rejectUpgrade(socket, 503, "Workspace Runtime is unavailable");
    return;
  }
  if (authorized === null) {
    rejectUpgrade(socket, 401, "Gateway authentication failed");
    return;
  }
  proxyWebSocketUpgrade(request, socket, head, {
    target: authorized.target,
    requestHeaders: forwardedHeaders(
      request,
      authorized.target,
    ),
  });
}

export function buildWorkerGateway(
  dependencies: WorkerGatewayDependencies,
): Server {
  WorkerTokenSchema.parse(dependencies.gatewayToken);
  parseWorkspaceBaseUrl(dependencies.workspaceBaseUrl);
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void handleHttp(request, response, dependencies);
  };
  const server = dependencies.tls
    ? createHttpsServer(dependencies.tls, listener)
    : createHttpServer(listener);
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head, dependencies);
  });
  server.on("connect", (_request, socket) => {
    rejectUpgrade(socket, 400, "CONNECT is not supported");
  });
  return server;
}
