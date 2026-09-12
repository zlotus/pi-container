import { hashOpaqueToken } from "@agent-runtime/auth";
import type {
  Phase4Repository,
  WorkspaceRecord,
} from "@agent-runtime/database";
import {
  parseHttpOrigin,
  parseWorkspaceBaseUrl,
  proxyHttpRequest,
  proxyWebSocketUpgrade,
  rejectUpgrade,
  sanitizeRequestHeaders,
  sendJsonError,
  stripPlatformCookies,
  workspaceIdFromHost,
  workspaceOrigin,
} from "@agent-runtime/gateway";
import { WorkerIdSchema, WorkerTokenSchema } from "@agent-runtime/protocol";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";

import type { WorkspaceSessionExchange } from "./session-exchange.js";

const ExchangeBodySchema = z.object({ code: z.string().min(32).max(256) }).strict();

export type WorkspaceGatewayStore = Pick<
  Phase4Repository,
  "findActiveSession" | "findOwnedWorkspace" | "findWorkerGatewayRoute"
>;

export interface WorkspaceGatewayDependencies {
  store: WorkspaceGatewayStore;
  exchanges: WorkspaceSessionExchange;
  portalOrigin: string;
  workspaceBaseUrl: string;
  secureCookies: boolean;
  sessionTtlMs: number;
  workerOfflineAfterMs: number;
  workerGatewayTokens: Readonly<Record<string, string>>;
  now?: () => Date;
}

interface AuthorizedWorkspace {
  workspace: WorkspaceRecord;
  workerGatewayBaseUrl: URL;
  workerGatewayToken: string;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return matches.length === 1 && matches[0] !== "" ? (matches[0] ?? null) : null;
}

function sessionCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function sendWorkspaceBootstrap(
  response: ServerResponse,
  setCookie: string,
): void {
  const nonce = randomBytes(18).toString("base64");
  const body = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    "<title>Opening Workspace</title>",
    `<script nonce="${nonce}">window.location.replace("/");</script>`,
    "</head><body>",
    '<p>Opening Workspace…</p><noscript><a href="/">Continue to Workspace</a></noscript>',
    "</body></html>",
  ].join("");
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "content-type": "text/html; charset=utf-8",
    "cross-origin-opener-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "set-cookie": setCookie,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

async function readExchangeBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 1_024) {
        tooLarge = true;
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new Error("exchange body is too large"));
        return;
      }
      const form = new URLSearchParams(body);
      const entries = [...form.entries()];
      if (entries.length !== 1 || entries[0]?.[0] !== "code") {
        resolve({ invalid: true });
        return;
      }
      resolve(Object.fromEntries(entries));
    });
    request.on("error", reject);
  });
}

async function resolveAuthorizedWorkspace(
  request: IncomingMessage,
  workspaceId: string,
  dependencies: WorkspaceGatewayDependencies,
): Promise<AuthorizedWorkspace | null> {
  const expectedOrigin = workspaceOrigin(
    workspaceId,
    parseWorkspaceBaseUrl(dependencies.workspaceBaseUrl),
  );
  if (
    request.headers["sec-fetch-site"] === "cross-site" ||
    (request.headers.origin !== undefined &&
      request.headers.origin !== expectedOrigin)
  ) {
    return null;
  }
  const cookieName = dependencies.secureCookies
    ? "__Host-platform-session"
    : "platform-session";
  const rawToken = parseCookie(request.headers.cookie, cookieName);
  if (rawToken === null) return null;
  const currentTime = dependencies.now?.() ?? new Date();
  const session = await dependencies.store.findActiveSession(
    hashOpaqueToken(rawToken),
    currentTime,
  );
  if (session === null) return null;
  const workspace = await dependencies.store.findOwnedWorkspace(
    workspaceId,
    session.user.id,
  );
  if (
    workspace === null ||
    workspace.state !== "RUNNING" ||
    workspace.workerId === null
  ) {
    return null;
  }
  const route = await dependencies.store.findWorkerGatewayRoute({
    workerId: workspace.workerId,
    heartbeatCutoff: new Date(
      currentTime.getTime() - dependencies.workerOfflineAfterMs,
    ),
  });
  const workerGatewayToken = dependencies.workerGatewayTokens[workspace.workerId];
  if (
    route === null ||
    route.workerId !== workspace.workerId ||
    workerGatewayToken === undefined
  ) {
    return null;
  }
  WorkerTokenSchema.parse(workerGatewayToken);
  return {
    workspace,
    workerGatewayBaseUrl: parseHttpOrigin(route.gatewayBaseUrl),
    workerGatewayToken,
  };
}

function workerRequestHeaders(
  request: IncomingMessage,
  authorized: AuthorizedWorkspace,
  publicOrigin: string,
) {
  const host = new URL(publicOrigin).host;
  const cookie = stripPlatformCookies(request.headers.cookie);
  return sanitizeRequestHeaders(request.headers, {
    authorization: `Bearer ${authorized.workerGatewayToken}`,
    cookie,
    host,
    "x-forwarded-host": host,
    "x-forwarded-proto": new URL(publicOrigin).protocol.slice(0, -1),
    "x-platform-workspace-id": authorized.workspace.id,
  });
}

async function handleExchange(
  request: IncomingMessage,
  response: ServerResponse,
  workspaceId: string,
  dependencies: WorkspaceGatewayDependencies,
): Promise<void> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (
    request.method !== "POST" ||
    request.headers.origin !== dependencies.portalOrigin ||
    contentType !== "application/x-www-form-urlencoded" ||
    (request.headers["sec-fetch-mode"] !== undefined &&
      request.headers["sec-fetch-mode"] !== "navigate") ||
    (request.headers["sec-fetch-dest"] !== undefined &&
      request.headers["sec-fetch-dest"] !== "document")
  ) {
    sendJsonError(response, 400, "INVALID_EXCHANGE", "Invalid session exchange");
    return;
  }
  let parsed;
  try {
    parsed = ExchangeBodySchema.safeParse(await readExchangeBody(request));
  } catch {
    sendJsonError(response, 400, "INVALID_EXCHANGE", "Invalid session exchange");
    return;
  }
  if (!parsed.success) {
    sendJsonError(response, 400, "INVALID_EXCHANGE", "Invalid session exchange");
    return;
  }
  const currentTime = dependencies.now?.() ?? new Date();
  const record = dependencies.exchanges.consume(
    parsed.data.code,
    workspaceId,
    currentTime,
  );
  if (record === null) {
    sendJsonError(response, 401, "INVALID_EXCHANGE", "Session exchange is invalid or expired");
    return;
  }
  const activeSession = await dependencies.store.findActiveSession(
    hashOpaqueToken(record.rawSessionToken),
    currentTime,
  );
  const workspace = await dependencies.store.findOwnedWorkspace(
    workspaceId,
    record.userId,
  );
  if (
    activeSession === null ||
    activeSession.user.id !== record.userId ||
    workspace === null ||
    workspace.state !== "RUNNING"
  ) {
    sendJsonError(response, 401, "INVALID_EXCHANGE", "Session exchange is invalid or expired");
    return;
  }
  const cookieName = dependencies.secureCookies
    ? "__Host-platform-session"
    : "platform-session";
  sendWorkspaceBootstrap(
    response,
    sessionCookie(
      cookieName,
      record.rawSessionToken,
      Math.floor(dependencies.sessionTtlMs / 1_000),
      dependencies.secureCookies,
    ),
  );
}

export function buildWorkspaceGateway(dependencies: WorkspaceGatewayDependencies) {
  const base = parseWorkspaceBaseUrl(dependencies.workspaceBaseUrl);
  if (
    parseHttpOrigin(dependencies.portalOrigin).origin !== dependencies.portalOrigin
  ) {
    throw new Error("Portal Origin must be canonical");
  }
  for (const [workerId, token] of Object.entries(dependencies.workerGatewayTokens)) {
    WorkerIdSchema.parse(workerId);
    WorkerTokenSchema.parse(token);
  }
  const server = createServer((request, response) => {
    void (async () => {
      const workspaceId = workspaceIdFromHost(request.headers.host, base);
      if (workspaceId === null) {
        sendJsonError(response, 404, "WORKSPACE_NOT_FOUND", "Workspace was not found");
        return;
      }
      if (request.url === "/_platform/session") {
        await handleExchange(request, response, workspaceId, dependencies);
        return;
      }
      const authorized = await resolveAuthorizedWorkspace(
        request,
        workspaceId,
        dependencies,
      );
      if (authorized === null) {
        sendJsonError(response, 404, "WORKSPACE_NOT_FOUND", "Workspace was not found or is unavailable");
        return;
      }
      const publicOrigin = workspaceOrigin(workspaceId, base);
      proxyHttpRequest(request, response, {
        target: authorized.workerGatewayBaseUrl,
        requestHeaders: workerRequestHeaders(request, authorized, publicOrigin),
        publicOrigin,
      });
    })().catch(() => {
      sendJsonError(response, 503, "GATEWAY_UNAVAILABLE", "Workspace Gateway is unavailable");
    });
  });
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const workspaceId = workspaceIdFromHost(request.headers.host, base);
      if (workspaceId === null) {
        rejectUpgrade(socket, 404, "Workspace was not found");
        return;
      }
      const expectedOrigin = workspaceOrigin(workspaceId, base);
      if (request.headers.origin !== expectedOrigin) {
        rejectUpgrade(socket, 403, "WebSocket Origin is not allowed");
        return;
      }
      const authorized = await resolveAuthorizedWorkspace(
        request,
        workspaceId,
        dependencies,
      );
      if (authorized === null) {
        rejectUpgrade(socket, 404, "Workspace was not found or is unavailable");
        return;
      }
      proxyWebSocketUpgrade(request, socket, head, {
        target: authorized.workerGatewayBaseUrl,
        requestHeaders: workerRequestHeaders(request, authorized, expectedOrigin),
      });
    })().catch(() => {
      rejectUpgrade(socket, 503, "Workspace Gateway is unavailable");
    });
  });
  server.on("connect", (_request, socket: Duplex) => {
    rejectUpgrade(socket, 400, "CONNECT is not supported");
  });
  return server;
}
