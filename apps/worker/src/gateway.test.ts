import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { buildWorkerGateway } from "./gateway.js";

const WORKSPACE_ID = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const OTHER_WORKSPACE_ID = "740df352-879b-4299-b5ab-a4d613a5ae56";
const GATEWAY_TOKEN = "gateway0123456789abcdef0123456789abcdef";
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

function request(input: {
  port: number;
  method?: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}) {
  return new Promise<{
    statusCode: number;
    headers: IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: "127.0.0.1",
        port: input.port,
        method: input.method ?? "GET",
        path: input.path,
        headers: input.headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(input.body);
  });
}

function platformHeaders(extra: Record<string, string> = {}) {
  return {
    host: PUBLIC_HOST,
    origin: PUBLIC_ORIGIN,
    authorization: `Bearer ${GATEWAY_TOKEN}`,
    "x-forwarded-host": PUBLIC_HOST,
    "x-forwarded-proto": "http",
    "x-platform-workspace-id": WORKSPACE_ID,
    ...extra,
  };
}

describe("Worker Gateway", () => {
  it("requires its independent credential and resolves only the managed Workspace target", async () => {
    let observedHeaders: IncomingHttpHeaders = {};
    let observedBody = "";
    const runtime = createServer((request, response) => {
      observedHeaders = request.headers;
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (observedBody += chunk));
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "set-cookie": ["__Host-platform-session=replace", "pi-setting=1"],
        });
        response.write("data: terminal\n\n");
        response.end("data: ready\n\n");
      });
    });
    const runtimePort = await listen(runtime);
    const resolved: string[] = [];
    const gateway = buildWorkerGateway({
      gatewayToken: GATEWAY_TOKEN,
      workspaceBaseUrl: "http://agent.test",
      async resolveWorkspaceTarget(workspaceId) {
        resolved.push(workspaceId);
        return new URL(`http://127.0.0.1:${runtimePort}`);
      },
    });
    const gatewayPort = await listen(gateway);
    const unauthorized = await request({
      port: gatewayPort,
      path: "/",
      headers: {
        ...platformHeaders(),
        authorization: "Bearer browser0123456789abcdef0123456789abcdef",
      },
    });
    const mismatchedHost = await request({
      port: gatewayPort,
      path: "/",
      headers: {
        ...platformHeaders(),
        host: `${OTHER_WORKSPACE_ID}.agent.test`,
      },
    });
    const allowed = await request({
      port: gatewayPort,
      method: "POST",
      path: "/api/terminal/id/events",
      headers: platformHeaders({
        cookie: "platform-session=secret; pi-setting=compact",
        "content-type": "application/json",
        "content-length": "16",
      }),
      body: '{"data":"input"}',
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(mismatchedHost.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toBe("data: terminal\n\ndata: ready\n\n");
    expect(resolved).toEqual([WORKSPACE_ID]);
    expect(observedHeaders.authorization).toBeUndefined();
    expect(observedHeaders["x-platform-workspace-id"]).toBeUndefined();
    expect(observedHeaders.cookie).toBe("pi-setting=compact");
    expect(observedBody).toBe('{"data":"input"}');
    expect(observedHeaders.host).toBe(`127.0.0.1:${runtimePort}`);
    expect(observedHeaders.origin).toBe(`http://127.0.0.1:${runtimePort}`);
    expect(allowed.headers["set-cookie"]).toEqual(["pi-setting=1"]);
  });

  it("proxies WebSocket bytes only after Worker-side Workspace validation", async () => {
    const runtime = createServer();
    const wss = new WebSocketServer({ noServer: true });
    runtime.on("upgrade", (request, socket, head) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["x-platform-workspace-id"]).toBeUndefined();
      expect(request.headers.host).toBe(`127.0.0.1:${runtimePort}`);
      expect(request.headers.origin).toBe(`http://127.0.0.1:${runtimePort}`);
      wss.handleUpgrade(request, socket, head, (websocket) => {
        websocket.on("message", (data) => websocket.send(data));
      });
    });
    const runtimePort = await listen(runtime);
    const gateway = buildWorkerGateway({
      gatewayToken: GATEWAY_TOKEN,
      workspaceBaseUrl: "http://agent.test",
      async resolveWorkspaceTarget(workspaceId) {
        expect(workspaceId).toBe(WORKSPACE_ID);
        return new URL(`http://127.0.0.1:${runtimePort}`);
      },
    });
    const gatewayPort = await listen(gateway);
    const client = new WebSocket(`ws://127.0.0.1:${gatewayPort}/terminal`, {
      headers: platformHeaders(),
    });
    await once(client, "open");
    client.send("pty-bytes");
    const [message] = await once(client, "message");

    expect(message.toString()).toBe("pty-bytes");
    client.close();
    wss.close();
  });
});
