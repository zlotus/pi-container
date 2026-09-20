import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { hashOpaqueToken } from "@agent-runtime/auth";
import type {
  AuthenticatedSessionRecord,
  WorkspaceRecord,
} from "@agent-runtime/database";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  buildWorkspaceGateway,
  type WorkspaceGatewayStore,
} from "./gateway.js";
import { WorkspaceSessionExchange } from "./session-exchange.js";
import { SessionConnectionRegistry } from "./session-connections.js";

const NOW = new Date("2026-09-12T08:00:00.000Z");
const WORKSPACE_ID = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const WORKSPACE_B_ID = "740df352-879b-4299-b5ab-a4d613a5ae56";
const USER_A_ID = "11111111-1111-4111-8111-111111111111";
const USER_B_ID = "22222222-2222-4222-8222-222222222222";
const WORKER_ID = "worker-01";
const GATEWAY_TOKEN = "gateway0123456789abcdef0123456789abcdef";
const SESSION_A = "sessiona0123456789abcdef0123456789abcdef";
const SESSION_B = "sessionb0123456789abcdef0123456789abcdef";
const PUBLIC_HOST = `${WORKSPACE_ID}.agent.test`;
const PUBLIC_ORIGIN = `http://${PUBLIC_HOST}`;

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

function session(userId: string): AuthenticatedSessionRecord {
  return {
    sessionId: `${userId}-session`,
    expiresAt: new Date(NOW.getTime() + 60_000),
    user: {
      id: userId,
      email: `${userId}@example.test`,
      username: null,
      role: "user",
      status: "active",
      lastLoginAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function workspace(state: WorkspaceRecord["state"] = "RUNNING"): WorkspaceRecord {
  return {
    id: WORKSPACE_ID,
    userId: USER_A_ID,
    name: "workspace-a",
    workerId: WORKER_ID,
    state,
    runtimeImage: "agent-runtime:test",
    createdAt: NOW,
    updatedAt: NOW,
    lastActivityAt: NOW,
  };
}

function request(input: {
  port: number;
  method?: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}) {
  return new Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      let responseHeaders: Record<string, string | string[] | undefined> = {};
      const outgoing = httpRequest(
        {
          hostname: "127.0.0.1",
          port: input.port,
          method: input.method ?? "GET",
          path: input.path,
          headers: input.headers,
        },
        (response) => {
          responseHeaders = response.headers;
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (body += chunk));
          response.on("end", () =>
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: responseHeaders,
              body,
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(input.body);
    },
  );
}

function rejectedWebSocketStatus(
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, { headers });
    client.once("open", () => {
      client.close();
      reject(new Error("WebSocket was unexpectedly accepted"));
    });
    client.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    client.once("error", () => undefined);
  });
}

describe("authenticated Workspace Gateway", () => {
  it("exchanges a Portal session once into a host-only Workspace bootstrap", async () => {
    const exchanges = new WorkspaceSessionExchange(60_000);
    const active = new Map([
      [hashOpaqueToken(SESSION_A), session(USER_A_ID)],
    ]);
    const store: WorkspaceGatewayStore = {
      async findActiveSession(tokenHash) {
        return active.get(tokenHash) ?? null;
      },
      async findOwnedWorkspace(id, userId) {
        return id === WORKSPACE_ID && userId === USER_A_ID ? workspace() : null;
      },
      async findWorkerGatewayRoute() {
        return null;
      },
    };
    const gateway = buildWorkspaceGateway({
      store,
      exchanges,
      portalOrigin: "http://portal.test",
      portalAllowedOrigins: ["http://portal.lan.test", "http://portal.tailnet.test"],
      workspaceBaseUrl: "http://agent.test",
      secureCookies: false,
      sessionTtlMs: 60_000,
      workerOfflineAfterMs: 35_000,
      workerGatewayTokens: {},
      now: () => NOW,
    });
    const port = await listen(gateway);
    const code = exchanges.issue({
      rawSessionToken: SESSION_A,
      userId: USER_A_ID,
      workspaceId: WORKSPACE_ID,
      now: NOW,
    });
    const body = new URLSearchParams({ code }).toString();
    const rejectedOrigin = await request({
      port,
      method: "POST",
      path: "/_platform/session",
      headers: {
        host: PUBLIC_HOST,
        origin: "http://attacker.test",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(body)),
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-user": "?1",
      },
      body,
    });
    const missingOrigin = await request({
      port,
      method: "POST",
      path: "/_platform/session",
      headers: {
        host: PUBLIC_HOST,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(body)),
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
      body,
    });
    const first = await request({
      port,
      method: "POST",
      path: "/_platform/session",
      headers: {
        host: PUBLIC_HOST,
        origin: "http://portal.tailnet.test",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(body)),
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-user": "?1",
      },
      body,
    });
    const replay = await request({
      port,
      method: "POST",
      path: "/_platform/session",
      headers: {
        host: PUBLIC_HOST,
        origin: "http://portal.test",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(body)),
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-user": "?1",
      },
      body,
    });
    const framedCode = exchanges.issue({
      rawSessionToken: SESSION_A,
      userId: USER_A_ID,
      workspaceId: WORKSPACE_ID,
      now: NOW,
    });
    const framedBody = new URLSearchParams({ code: framedCode }).toString();
    const framedExchange = await request({
      port,
      method: "POST",
      path: "/_platform/session",
      headers: {
        host: PUBLIC_HOST,
        origin: "http://portal.test",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(framedBody)),
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "iframe",
      },
      body: framedBody,
    });

    expect(rejectedOrigin.statusCode).toBe(400);
    expect(missingOrigin.statusCode).toBe(400);
    expect(first.statusCode).toBe(200);
    expect(first.headers.location).toBeUndefined();
    expect(first.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(first.headers["x-frame-options"]).toBe("DENY");
    expect(first.body).toContain('window.location.replace("/")');
    expect(first.body).not.toContain(code);
    expect(first.body).not.toContain(SESSION_A);
    expect(first.headers["set-cookie"]).toEqual([
      expect.stringContaining(`platform-session=${SESSION_A}; Path=/; HttpOnly; SameSite=Lax`),
    ]);
    expect(first.headers["set-cookie"]?.join(";")).not.toContain("Domain=");
    expect(replay.statusCode).toBe(401);
    expect(framedExchange.statusCode).toBe(400);
  });

  it("starts a new same-origin navigation after a cross-site Portal exchange", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("pi-web root");
    });
    const upstreamPort = await listen(upstream);
    const exchanges = new WorkspaceSessionExchange(60_000);
    const store: WorkspaceGatewayStore = {
      async findActiveSession(tokenHash) {
        return tokenHash === hashOpaqueToken(SESSION_A) ? session(USER_A_ID) : null;
      },
      async findOwnedWorkspace(id, userId) {
        return id === WORKSPACE_ID && userId === USER_A_ID ? workspace() : null;
      },
      async findWorkerGatewayRoute() {
        return {
          workerId: WORKER_ID,
          gatewayBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        };
      },
    };
    const gateway = buildWorkspaceGateway({
      store,
      exchanges,
      portalOrigin: "http://portal.test",
      workspaceBaseUrl: "http://agent.test",
      secureCookies: false,
      sessionTtlMs: 60_000,
      workerOfflineAfterMs: 35_000,
      workerGatewayTokens: { [WORKER_ID]: GATEWAY_TOKEN },
      now: () => NOW,
    });
    const port = await listen(gateway);
    const code = exchanges.issue({
      rawSessionToken: SESSION_A,
      userId: USER_A_ID,
      workspaceId: WORKSPACE_ID,
      now: NOW,
    });
    const body = new URLSearchParams({ code }).toString();
    const exchange = await request({
      port,
      method: "POST",
      path: "/_platform/session",
      headers: {
        host: PUBLIC_HOST,
        origin: "http://portal.test",
        referer: "http://portal.test/",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(body)),
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-user": "?1",
      },
      body,
    });
    const cookie = exchange.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("Workspace cookie is missing");

    const workspaceNavigation = await request({
      port,
      path: "/",
      headers: {
        host: PUBLIC_HOST,
        cookie,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    const redirectTaintedNavigation = await request({
      port,
      path: "/",
      headers: {
        host: PUBLIC_HOST,
        cookie,
        referer: "http://portal.test/",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-user": "?1",
      },
    });

    expect(exchange.statusCode).toBe(200);
    expect(workspaceNavigation.statusCode).toBe(200);
    expect(workspaceNavigation.body).toBe("pi-web root");
    expect(redirectTaintedNavigation.statusCode).toBe(404);
  });

  it("streams HTTP only for the owning active session and uses the registered Worker route", async () => {
    let observedHeaders: Record<string, string | string[] | undefined> = {};
    const upstream = createServer((request, response) => {
      observedHeaders = request.headers;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "set-cookie": ["platform-session=upstream", "pi-theme=dark"],
      });
      response.write("data: first\n\n");
      response.end("data: second\n\n");
    });
    const upstreamPort = await listen(upstream);
    const active = new Map([
      [hashOpaqueToken(SESSION_A), session(USER_A_ID)],
      [hashOpaqueToken(SESSION_B), session(USER_B_ID)],
    ]);
    const ownedWorkspace = workspace();
    const store: WorkspaceGatewayStore = {
      async findActiveSession(tokenHash) {
        return active.get(tokenHash) ?? null;
      },
      async findOwnedWorkspace(id, userId) {
        return id === WORKSPACE_ID && userId === USER_A_ID
          ? ownedWorkspace
          : null;
      },
      async findWorkerGatewayRoute() {
        return {
          workerId: WORKER_ID,
          gatewayBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        };
      },
    };
    const gateway = buildWorkspaceGateway({
      store,
      exchanges: new WorkspaceSessionExchange(60_000),
      portalOrigin: "http://portal.test",
      workspaceBaseUrl: "http://agent.test",
      secureCookies: false,
      sessionTtlMs: 60_000,
      workerOfflineAfterMs: 35_000,
      workerGatewayTokens: { [WORKER_ID]: GATEWAY_TOKEN },
      now: () => NOW,
    });
    const gatewayPort = await listen(gateway);
    const owner = await request({
      port: gatewayPort,
      path: "/api/agent/id/events",
      headers: {
        host: PUBLIC_HOST,
        cookie: `platform-session=${SESSION_A}; pi-theme=light`,
        authorization: "Bearer browser-controlled",
        connection: "keep-alive, authorization, x-platform-workspace-id",
        "x-platform-workspace-id": "740df352-879b-4299-b5ab-a4d613a5ae56",
      },
    });
    const foreign = await request({
      port: gatewayPort,
      path: "/",
      headers: {
        host: PUBLIC_HOST,
        cookie: `platform-session=${SESSION_B}`,
      },
    });
    const crossSiteFetch = await request({
      port: gatewayPort,
      path: "/",
      headers: {
        host: PUBLIC_HOST,
        cookie: `platform-session=${SESSION_A}`,
        origin: "http://attacker.test",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
    });
    const crossSiteSubresource = await request({
      port: gatewayPort,
      path: "/favicon.ico",
      headers: {
        host: PUBLIC_HOST,
        cookie: `platform-session=${SESSION_A}`,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-dest": "image",
      },
    });
    const crossSiteIframe = await request({
      port: gatewayPort,
      path: "/",
      headers: {
        host: PUBLIC_HOST,
        cookie: `platform-session=${SESSION_A}`,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "iframe",
      },
    });
    const noCookie = await request({
      port: gatewayPort,
      path: "/",
      headers: {
        host: PUBLIC_HOST,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    active.delete(hashOpaqueToken(SESSION_A));
    const revoked = await request({
      port: gatewayPort,
      path: "/",
      headers: {
        host: PUBLIC_HOST,
        cookie: `platform-session=${SESSION_A}`,
      },
    });
    active.set(hashOpaqueToken(SESSION_A), session(USER_A_ID));
    ownedWorkspace.state = "WORKER_OFFLINE";
    const reconciling = await request({
      port: gatewayPort,
      path: "/",
      headers: {
        host: PUBLIC_HOST,
        cookie: `platform-session=${SESSION_A}`,
      },
    });
    ownedWorkspace.state = "STOPPED";
    const stopped = await request({
      port: gatewayPort,
      path: "/",
      headers: {
        host: PUBLIC_HOST,
        cookie: `platform-session=${SESSION_A}`,
      },
    });

    expect(owner.statusCode).toBe(200);
    expect(owner.body).toBe("data: first\n\ndata: second\n\n");
    expect(observedHeaders).toMatchObject({
      authorization: `Bearer ${GATEWAY_TOKEN}`,
      host: PUBLIC_HOST,
      "x-forwarded-host": PUBLIC_HOST,
      "x-forwarded-proto": "http",
      "x-platform-workspace-id": WORKSPACE_ID,
      cookie: "pi-theme=light",
    });
    expect(owner.headers["set-cookie"]).toEqual(["pi-theme=dark"]);
    expect(foreign.statusCode).toBe(404);
    expect(crossSiteFetch.statusCode).toBe(404);
    expect(crossSiteSubresource.statusCode).toBe(404);
    expect(crossSiteIframe.statusCode).toBe(404);
    expect(noCookie.statusCode).toBe(404);
    expect(revoked.statusCode).toBe(404);
    expect(reconciling.statusCode).toBe(404);
    expect(stopped.statusCode).toBe(404);
  });

  it("closes a revoked user's established HTTP stream without affecting another user", async () => {
    const upstreamResponses = new Map<string, ServerResponse>();
    const upstream = createServer((request, response) => {
      const path = request.url ?? "";
      upstreamResponses.set(path, response);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${path}:first\n\n`);
      response.once("close", () => upstreamResponses.delete(path));
    });
    const upstreamPort = await listen(upstream);
    const active = new Map([
      [hashOpaqueToken(SESSION_A), session(USER_A_ID)],
      [hashOpaqueToken(SESSION_B), session(USER_B_ID)],
    ]);
    const store: WorkspaceGatewayStore = {
      async findActiveSession(tokenHash) {
        return active.get(tokenHash) ?? null;
      },
      async findOwnedWorkspace(id, userId) {
        if (id === WORKSPACE_ID && userId === USER_A_ID) return workspace();
        if (id === WORKSPACE_B_ID && userId === USER_B_ID) {
          return {
            ...workspace(),
            id: WORKSPACE_B_ID,
            userId: USER_B_ID,
            name: "workspace-b",
          };
        }
        return null;
      },
      async findWorkerGatewayRoute() {
        return {
          workerId: WORKER_ID,
          gatewayBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        };
      },
    };
    const sessionConnections = new SessionConnectionRegistry();
    const gateway = buildWorkspaceGateway({
      store,
      exchanges: new WorkspaceSessionExchange(60_000),
      portalOrigin: "http://portal.test",
      workspaceBaseUrl: "http://agent.test",
      secureCookies: false,
      sessionTtlMs: 60_000,
      workerOfflineAfterMs: 35_000,
      workerGatewayTokens: { [WORKER_ID]: GATEWAY_TOKEN },
      sessionConnections,
      now: () => NOW,
    });
    const gatewayPort = await listen(gateway);
    type OpenStream = {
      response: IncomingMessage;
      chunks: string[];
    };
    const connectStream = (workspaceId: string, token: string, path: string) =>
      new Promise<OpenStream>((resolve, reject) => {
        const chunks: string[] = [];
        let resolved = false;
        const outgoing = httpRequest(
          {
            hostname: "127.0.0.1",
            port: gatewayPort,
            path,
            headers: {
              host: `${workspaceId}.agent.test`,
              cookie: `platform-session=${token}`,
            },
          },
          (response) => {
            response.setEncoding("utf8");
            response.on("error", () => undefined);
            response.on("data", (chunk: string) => {
              chunks.push(chunk);
              if (!resolved) {
                resolved = true;
                resolve({ response, chunks });
              }
            });
          },
        );
        outgoing.once("error", reject);
        outgoing.end();
      });
    const [streamA, streamB] = await Promise.all([
      connectStream(WORKSPACE_ID, SESSION_A, "/stream-a"),
      connectStream(WORKSPACE_B_ID, SESSION_B, "/stream-b"),
    ]);
    const streamAClosed = new Promise<void>((resolve) =>
      streamA.response.once("close", resolve),
    );

    active.delete(hashOpaqueToken(SESSION_A));
    sessionConnections.closeUser(USER_A_ID);
    await streamAClosed;

    expect(streamA.response.destroyed).toBe(true);
    expect(streamB.response.destroyed).toBe(false);
    const streamBNextChunk = once(streamB.response, "data");
    upstreamResponses.get("/stream-b")?.write("data: /stream-b:second\n\n");
    await streamBNextChunk;
    expect(streamB.chunks.join("")).toContain("data: /stream-b:second\n\n");

    const revoked = await request({
      port: gatewayPort,
      path: "/after-revoke",
      headers: {
        host: PUBLIC_HOST,
        cookie: `platform-session=${SESSION_A}`,
      },
    });
    expect(revoked.statusCode).toBe(404);

    const streamBClosed = new Promise<void>((resolve) =>
      streamB.response.once("close", resolve),
    );
    sessionConnections.closeUser(USER_B_ID);
    await streamBClosed;
  });

  it("authorizes WebSocket upgrades by exact Origin and fixes the target at handshake", async () => {
    let upstreamPath = "";
    const upstream = createServer();
    const wss = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (request, socket, head) => {
      upstreamPath = request.url ?? "";
      expect(request.headers.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`);
      expect(request.headers["x-platform-workspace-id"]).toBe(WORKSPACE_ID);
      wss.handleUpgrade(request, socket, head, (websocket) => {
        websocket.on("message", (data) => websocket.send(data));
      });
    });
    const upstreamPort = await listen(upstream);
    const store: WorkspaceGatewayStore = {
      async findActiveSession(tokenHash) {
        return tokenHash === hashOpaqueToken(SESSION_A) ? session(USER_A_ID) : null;
      },
      async findOwnedWorkspace(id, userId) {
        return id === WORKSPACE_ID && userId === USER_A_ID ? workspace() : null;
      },
      async findWorkerGatewayRoute() {
        return {
          workerId: WORKER_ID,
          gatewayBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        };
      },
    };
    const sessionConnections = new SessionConnectionRegistry();
    const gateway = buildWorkspaceGateway({
      store,
      exchanges: new WorkspaceSessionExchange(60_000),
      portalOrigin: "http://portal.test",
      workspaceBaseUrl: "http://agent.test",
      secureCookies: false,
      sessionTtlMs: 60_000,
      workerOfflineAfterMs: 35_000,
      workerGatewayTokens: { [WORKER_ID]: GATEWAY_TOKEN },
      sessionConnections,
      now: () => NOW,
    });
    const port = await listen(gateway);
    const foreignWorkspace = "740df352-879b-4299-b5ab-a4d613a5ae56";
    await expect(
      rejectedWebSocketStatus(`ws://127.0.0.1:${port}/socket`, {
        host: PUBLIC_HOST,
        origin: "http://attacker.test",
        cookie: `platform-session=${SESSION_A}`,
      }),
    ).resolves.toBe(403);
    await expect(
      rejectedWebSocketStatus(`ws://127.0.0.1:${port}/socket`, {
        host: PUBLIC_HOST,
        origin: PUBLIC_ORIGIN,
        cookie: `platform-session=${SESSION_B}`,
      }),
    ).resolves.toBe(404);
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/socket?workspaceId=${foreignWorkspace}`,
      {
        headers: {
          host: PUBLIC_HOST,
          origin: PUBLIC_ORIGIN,
          cookie: `platform-session=${SESSION_A}`,
        },
      },
    );
    await once(client, "open");
    client.send("terminal-data");
    const [message] = await once(client, "message");

    expect(message.toString()).toBe("terminal-data");
    expect(upstreamPath).toBe(`/socket?workspaceId=${foreignWorkspace}`);
    sessionConnections.closeUser(USER_A_ID);
    await once(client, "close");
    wss.close();
  });

  it("revalidates a session after registering an in-flight WebSocket", async () => {
    const upstream = createServer();
    const wss = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, () => undefined);
    });
    const upstreamPort = await listen(upstream);
    let sessionLookups = 0;
    const store: WorkspaceGatewayStore = {
      async findActiveSession(tokenHash) {
        if (tokenHash !== hashOpaqueToken(SESSION_A)) return null;
        sessionLookups += 1;
        return sessionLookups === 1 ? session(USER_A_ID) : null;
      },
      async findOwnedWorkspace(id, userId) {
        return id === WORKSPACE_ID && userId === USER_A_ID ? workspace() : null;
      },
      async findWorkerGatewayRoute() {
        return {
          workerId: WORKER_ID,
          gatewayBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        };
      },
    };
    const gateway = buildWorkspaceGateway({
      store,
      exchanges: new WorkspaceSessionExchange(60_000),
      portalOrigin: "http://portal.test",
      workspaceBaseUrl: "http://agent.test",
      secureCookies: false,
      sessionTtlMs: 60_000,
      workerOfflineAfterMs: 35_000,
      workerGatewayTokens: { [WORKER_ID]: GATEWAY_TOKEN },
      now: () => NOW,
    });
    const port = await listen(gateway);
    const client = new WebSocket(`ws://127.0.0.1:${port}/socket`, {
      headers: {
        host: PUBLIC_HOST,
        origin: PUBLIC_ORIGIN,
        cookie: `platform-session=${SESSION_A}`,
      },
    });
    const closed = once(client, "close");

    await once(client, "open");
    await closed;

    expect(sessionLookups).toBe(2);
    wss.close();
  });
});
