import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
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

const NOW = new Date("2026-09-12T08:00:00.000Z");
const WORKSPACE_ID = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
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
      createdAt: NOW,
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
  it("exchanges a Portal session once into a host-only Workspace cookie", async () => {
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
    const first = await request({
      port,
      method: "POST",
      path: "/_platform/session",
      headers: {
        host: PUBLIC_HOST,
        origin: "http://portal.test",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(body)),
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
      },
      body,
    });

    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toBe("/");
    expect(first.headers["set-cookie"]).toEqual([
      expect.stringContaining(`platform-session=${SESSION_A}; Path=/; HttpOnly; SameSite=Lax`),
    ]);
    expect(first.headers["set-cookie"]?.join(";")).not.toContain("Domain=");
    expect(replay.statusCode).toBe(401);
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
    const crossSite = await request({
      port: gatewayPort,
      path: "/",
      headers: {
        host: PUBLIC_HOST,
        cookie: `platform-session=${SESSION_A}`,
        origin: "http://attacker.test",
        "sec-fetch-site": "cross-site",
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
    expect(crossSite.statusCode).toBe(404);
    expect(stopped.statusCode).toBe(404);
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
    client.close();
    wss.close();
  });
});
