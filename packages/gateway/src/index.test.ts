import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

import { describe, expect, it, vi } from "vitest";

import {
  parseHttpOrigin,
  parseWorkspaceBaseUrl,
  proxyHttpRequest,
  proxyWebSocketUpgrade,
  sanitizeRequestHeaders,
  stripPlatformCookies,
  workspaceHost,
  workspaceIdFromHost,
  workspaceOrigin,
} from "./index.js";

const WORKSPACE_ID = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";

describe("Workspace host routing", () => {
  it("accepts only the exact configured subdomain authority", () => {
    const base = parseWorkspaceBaseUrl("https://agent.example.internal:8443");
    const host = `${WORKSPACE_ID}.agent.example.internal:8443`;

    expect(workspaceIdFromHost(host, base)).toBe(WORKSPACE_ID);
    expect(workspaceHost(WORKSPACE_ID, base)).toBe(host);
    expect(workspaceOrigin(WORKSPACE_ID, base)).toBe(`https://${host}`);
    expect(workspaceIdFromHost(`${host}.attacker.test`, base)).toBeNull();
    expect(
      workspaceIdFromHost(`${WORKSPACE_ID}.agent.example.internal`, base),
    ).toBeNull();
  });

  it("rejects path-bearing or credential-bearing base URLs", () => {
    expect(() => parseWorkspaceBaseUrl("https://agent.test/base")).toThrow();
    expect(() => parseWorkspaceBaseUrl("https://user@agent.test")).toThrow();
    expect(() => parseWorkspaceBaseUrl("http://127.0.0.1:3001")).toThrow();
    expect(parseHttpOrigin("http://127.0.0.1:3100").host).toBe(
      "127.0.0.1:3100",
    );
  });
});

describe("proxy header boundaries", () => {
  it("removes hop-by-hop and Connection-nominated headers before overrides", () => {
    expect(
      sanitizeRequestHeaders(
        {
          connection: "keep-alive, authorization, x-platform-workspace-id",
          authorization: "browser secret",
          "x-platform-workspace-id": "browser target",
          cookie: "theme=dark",
        },
        {
          authorization: "Bearer trusted",
          "x-platform-workspace-id": WORKSPACE_ID,
        },
      ),
    ).toEqual({
      authorization: "Bearer trusted",
      "x-platform-workspace-id": WORKSPACE_ID,
      cookie: "theme=dark",
    });
  });

  it("removes Next.js-internal headers but keeps App Router headers (Phase 18.10)", () => {
    expect(
      sanitizeRequestHeaders({
        "x-prerender-revalidate": "published-preview-id",
        "X-Prerender-Revalidate-If-Generated": "1",
        "x-middleware-subrequest": "middleware:middleware",
        "x-middleware-invoke": "1",
        "x-invoke-path": "/api/files",
        "x-invoke-status": "200",
        rsc: "1",
        "next-router-state-tree": "%5B%5D",
        "next-action": "abc",
        "next-url": "/",
        accept: "text/x-component",
      }),
    ).toEqual({
      rsc: "1",
      "next-router-state-tree": "%5B%5D",
      "next-action": "abc",
      "next-url": "/",
      accept: "text/x-component",
    });
  });

  it("removes only platform-owned cookies", () => {
    expect(
      stripPlatformCookies(
        "theme=dark; platform-session=secret; pi-preference=compact",
      ),
    ).toBe("theme=dark; pi-preference=compact");
    expect(stripPlatformCookies("__Host-platform-session=secret")).toBeUndefined();
  });
});

describe("HTTP proxy connection lifecycle", () => {
  it("unregisters a completed response", async () => {
    const upstream = createServer((_request, response) => response.end("ok"));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const unregister = vi.fn();
    const proxy = createServer((request, response) => {
      proxyHttpRequest(request, response, {
        target: new URL(`http://127.0.0.1:${upstreamPort}`),
        requestHeaders: request.headers,
        onConnected: () => unregister,
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as AddressInfo).port;

    try {
      const body = await new Promise<string>((resolve, reject) => {
        const outgoing = httpRequest(
          {
            hostname: "127.0.0.1",
            port: proxyPort,
            path: "/stream",
            headers: { connection: "close" },
          },
          (response) => {
            let result = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => (result += chunk));
            response.once("end", () => resolve(result));
          },
        );
        outgoing.once("error", reject);
        outgoing.end();
      });

      expect(body).toBe("ok");
      expect(unregister).toHaveBeenCalledOnce();
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    }
  });

  it("does not register a request the Browser aborted before proxying started", async () => {
    const upstream = createServer((_request, response) => response.end("ok"));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;
    let active = 0;
    const proxy = createServer((request, response) => {
      // The Control Plane authorizes (database lookups) before it proxies.
      setTimeout(() => {
        proxyHttpRequest(request, response, {
          target: new URL(`http://127.0.0.1:${upstreamPort}`),
          requestHeaders: request.headers,
          onConnected: () => {
            active += 1;
            return () => (active -= 1);
          },
        });
      }, 100);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as AddressInfo).port;
    const destroyAll = trackSockets(proxy, upstream);

    try {
      const outgoing = httpRequest({ hostname: "127.0.0.1", port: proxyPort, path: "/favicon.ico" });
      outgoing.once("error", () => undefined);
      outgoing.end();
      setTimeout(() => outgoing.destroy(), 20);
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(active).toBe(0);
    } finally {
      destroyAll();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    }
  });
});

describe("WebSocket proxy connection lifecycle", () => {
  /** A proxy that waits `authorizeMs` (the Control Plane's authorization) before proxying. */
  async function webSocketProxy(authorizeMs: number) {
    const upstream = createServer();
    upstream.on("upgrade", (_request, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const state = { active: 0 };
    const proxy = createServer();
    proxy.on("upgrade", (request, socket, head) => {
      setTimeout(() => {
        proxyWebSocketUpgrade(request, socket, head, {
          target: new URL(`http://127.0.0.1:${upstreamPort}`),
          requestHeaders: request.headers,
          onConnected: () => {
            state.active += 1;
            return () => (state.active -= 1);
          },
        });
      }, authorizeMs);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const destroyAll = trackSockets(proxy, upstream);
    const client = connect((proxy.address() as AddressInfo).port, "127.0.0.1");
    client.once("error", () => undefined);
    await once(client, "connect");
    client.write(
      "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    return {
      state,
      client,
      async close() {
        destroyAll();
        await Promise.all([
          new Promise<void>((resolve) => proxy.close(() => resolve())),
          new Promise<void>((resolve) => upstream.close(() => resolve())),
        ]);
      },
    };
  }

  it("unregisters an upgrade the Browser closed before proxying started", async () => {
    const { state, client, close } = await webSocketProxy(100);
    try {
      setTimeout(() => client.destroy(), 20);
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(state.active).toBe(0);
    } finally {
      await close();
    }
  });

  it("unregisters a WebSocket the Browser only half-closed", async () => {
    const { state, client, close } = await webSocketProxy(0);
    try {
      await once(client, "data");
      expect(state.active).toBe(1);
      client.end();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(state.active).toBe(0);
    } finally {
      await close();
    }
  });
});

/** Destroys every socket these servers accepted, upgraded ones included, so close() returns. */
function trackSockets(...servers: Server[]): () => void {
  const sockets = new Set<Socket>();
  for (const server of servers) server.on("connection", (socket: Socket) => sockets.add(socket));
  return () => {
    for (const socket of sockets) socket.destroy();
  };
}

/** A certificate for IP:127.0.0.1 only, signed by a throwaway CA. */
function ipCertificate(): { ca: string; cert: string; key: string } {
  const directory = mkdtempSync(join(tmpdir(), "gateway-tls-"));
  try {
    const run = (args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=test CA", "-keyout", "ca.key", "-out", "ca.crt"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", "server.key", "-out", "server.csr"]);
    writeFileSync(join(directory, "ext"), "subjectAltName=IP:127.0.0.1\n");
    run(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", "ext", "-out", "server.crt"]);
    const read = (name: string) => readFileSync(join(directory, name), "utf8");
    return { ca: read("ca.crt"), cert: read("server.crt"), key: read("server.key") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("HTTPS upstream (Worker Gateway with native TLS)", () => {
  it("verifies the upstream by its own address, not by the forwarded public Host (Phase 19.19)", async () => {
    const tls = ipCertificate();
    const previous = getCACertificates("default");
    // Like NODE_EXTRA_CA_CERTS in the Control Plane unit.
    setDefaultCACertificates([...previous, tls.ca]);
    let seenHost: string | undefined;
    const upstream = createHttpsServer({ cert: tls.cert, key: tls.key }, (request, response) => {
      seenHost = request.headers.host;
      response.end("tls-ok");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const proxy: Server = createServer((request, response) => {
      proxyHttpRequest(request, response, {
        target: new URL(`https://127.0.0.1:${upstreamPort}`),
        requestHeaders: { ...request.headers, host: `${WORKSPACE_ID}.agent.example.internal` },
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as AddressInfo).port;
    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = httpRequest(
          { hostname: "127.0.0.1", port: proxyPort, path: "/", headers: { connection: "close" } },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => (body += chunk));
            response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        outgoing.once("error", reject);
        outgoing.end();
      });
      expect(result).toEqual({ status: 200, body: "tls-ok" });
      // The public Host still reaches the Worker Gateway, which checks it.
      expect(seenHost).toBe(`${WORKSPACE_ID}.agent.example.internal`);
    } finally {
      setDefaultCACertificates(previous);
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    }
  });
});
