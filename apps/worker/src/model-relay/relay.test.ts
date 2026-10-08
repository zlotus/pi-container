import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ModelRelay, type RelayEndpoint } from "./relay.js";

const WORKSPACE = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const VIRTUAL_KEY = "sk-virtual-key-for-workspace";

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (let close = closers.pop(); close !== undefined; close = closers.pop()) await close();
});

/** A stand-in for LiteLLM that records requests and streams a scripted SSE reply. */
async function fakeGateway(options: { holdOpen?: boolean } = {}) {
  const received: Received[] = [];
  let aborted = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "gw=1" });
      res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
      if (options.holdOpen) {
        res.on("close", () => (aborted += 1));
        return;
      }
      res.end('data: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as AddressInfo).port;
  return { received, url: new URL(`http://127.0.0.1:${port}`), aborted: () => aborted };
}

async function startRelay(
  upstream: URL,
  endpoints: RelayEndpoint[],
  keys: Record<string, string> = { [WORKSPACE]: VIRTUAL_KEY },
  options: { maxBodyBytes?: number; maxConcurrentPerWorkspace?: number } = {},
) {
  const logs: Array<Record<string, unknown>> = [];
  const relay = new ModelRelay({
    port: 0,
    host: "127.0.0.1",
    upstream,
    keys: { get: (id) => keys[id] },
    endpoints: async () => endpoints,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    maxConcurrentPerWorkspace: options.maxConcurrentPerWorkspace ?? 16,
    refreshIntervalMs: 0,
    log: {
      info: (fields: object) => logs.push(fields as Record<string, unknown>),
      warn: (fields: object) => logs.push(fields as Record<string, unknown>),
    },
  });
  await relay.start();
  closers.push(() => relay.stop());
  const address = relay.address();
  if (address === null) throw new Error("relay is not listening");
  return { relay, port: address.port, logs };
}

/** Sends from `localAddress` (the "container") to 127.0.0.1 (the "bridge gateway"). */
function send(
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: string; from?: string } = {},
): Promise<{ status: number | null; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        localAddress: options.from ?? "127.0.0.2",
        method: options.method ?? "POST",
        path: options.path ?? "/v1/chat/completions",
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? null, headers: res.headers, body }));
        res.on("error", () => resolve({ status: res.statusCode ?? null, headers: res.headers, body }));
      },
    );
    req.on("error", () => resolve({ status: null, headers: {}, body: "" }));
    req.end(options.body ?? '{"model":"deepseek-v4-flash","stream":true}');
  });
}

const ENDPOINT: RelayEndpoint = {
  workspaceId: WORKSPACE,
  gatewayAddress: "127.0.0.1",
  containerAddress: "127.0.0.2",
};

describe("Worker model relay (Phase 16.4)", () => {
  it("streams an inference request with the Workspace key and no client credentials", async () => {
    const gateway = await fakeGateway();
    const { port, logs } = await startRelay(gateway.url, [ENDPOINT]);
    const response = await send(port, {
      headers: {
        authorization: "Bearer agent-runtime-relay",
        "x-api-key": "sk-client-supplied",
        "x-litellm-api-key": "sk-client-litellm",
        cookie: "platform-session=stolen",
        "x-stainless-lang": "js",
        "user-agent": "pi",
        "x-forwarded-for": "10.0.0.1",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain("he");
    expect(response.body).toContain("[DONE]");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(gateway.received).toHaveLength(1);
    const [upstream] = gateway.received;
    if (upstream === undefined) throw new Error("no upstream request");
    expect(upstream.path).toBe("/v1/chat/completions");
    expect(upstream.headers.authorization).toBe(`Bearer ${VIRTUAL_KEY}`);
    expect(upstream.headers["x-api-key"]).toBeUndefined();
    expect(upstream.headers["x-litellm-api-key"]).toBeUndefined();
    expect(upstream.headers.cookie).toBeUndefined();
    expect(upstream.headers["x-forwarded-for"]).toBeUndefined();
    expect(upstream.headers["x-stainless-lang"]).toBe("js");
    expect(upstream.body).toBe('{"model":"deepseek-v4-flash","stream":true}');

    const output = JSON.stringify(logs);
    expect(output).not.toContain(VIRTUAL_KEY);
    expect(output).not.toContain("deepseek-v4-flash");
    expect(logs.at(-1)).toMatchObject({ workspaceId: WORKSPACE, status: 200, path: "/v1" });
  });

  it("drops connections that are not a running managed Workspace, without any response", async () => {
    const gateway = await fakeGateway();
    // Same container address, but the connection arrives on a different local address.
    const { port } = await startRelay(gateway.url, [{ ...ENDPOINT, gatewayAddress: "127.0.0.3" }]);
    expect((await send(port)).status).toBeNull();
    // Right local address, unknown remote address.
    const second = await startRelay(gateway.url, [ENDPOINT]);
    expect((await send(second.port, { from: "127.0.0.4" })).status).toBeNull();
    expect(gateway.received).toHaveLength(0);
  });

  it("forwards only exact inference routes", async () => {
    const gateway = await fakeGateway();
    const { port } = await startRelay(gateway.url, [ENDPOINT]);
    for (const path of [
      "/key/generate",
      "/v1/models",
      "/model/info",
      "/ui",
      "/v1/chat/completions?api_base=x",
      "/v1/chat/completions/../../key/generate",
      "/v1%2fchat/completions",
      "/v1/chat/completions/",
    ]) {
      expect((await send(port, { path })).status, path).toBe(404);
    }
    expect((await send(port, { method: "GET", body: "" })).status).toBe(404);
    for (const path of ["/v1/responses", "/v1/messages", "/v1/messages/count_tokens"]) {
      expect((await send(port, { path })).status, path).toBe(200);
    }
    expect(gateway.received.map((entry) => entry.path)).toEqual([
      "/v1/responses",
      "/v1/messages",
      "/v1/messages/count_tokens",
    ]);
  });

  it("answers 403 without contacting the gateway when the Workspace has no key", async () => {
    const gateway = await fakeGateway();
    const { port } = await startRelay(gateway.url, [ENDPOINT], {});
    const response = await send(port);
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "MODEL_KEY_UNAVAILABLE" } });
    expect(gateway.received).toHaveLength(0);
  });

  it("reports an unreachable gateway as 502", async () => {
    const { port } = await startRelay(new URL("http://127.0.0.1:1"), [ENDPOINT]);
    const response = await send(port);
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "MODEL_GATEWAY_UNAVAILABLE" } });
  });

  it("rejects oversized bodies and bounds concurrent requests per Workspace", async () => {
    const gateway = await fakeGateway({ holdOpen: true });
    const { port } = await startRelay(gateway.url, [ENDPOINT], undefined, {
      maxBodyBytes: 64,
      maxConcurrentPerWorkspace: 1,
    });
    expect((await send(port, { body: "x".repeat(65) })).status).toBe(413);

    const first = new Promise<number>((resolve) => {
      const req = request(
        { host: "127.0.0.1", port, localAddress: "127.0.0.2", method: "POST", path: "/v1/chat/completions" },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end("{}");
    });
    expect(await first).toBe(200);
    expect((await send(port, { body: "{}" })).status).toBe(429);
  });

  it("aborts the upstream request when the Agent stops", async () => {
    const gateway = await fakeGateway({ holdOpen: true });
    const { port } = await startRelay(gateway.url, [ENDPOINT]);
    await new Promise<void>((resolve) => {
      const req = request(
        { host: "127.0.0.1", port, localAddress: "127.0.0.2", method: "POST", path: "/v1/chat/completions" },
        (res) => res.once("data", () => {
          req.destroy();
          resolve();
        }),
      );
      req.end("{}");
    });
    await expect.poll(() => gateway.aborted(), { timeout: 2_000 }).toBe(1);
  });
});
