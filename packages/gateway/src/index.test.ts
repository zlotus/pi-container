import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  parseHttpOrigin,
  parseWorkspaceBaseUrl,
  proxyHttpRequest,
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
});
