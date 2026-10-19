// The production nginx template against stub upstreams (specs.md Phase 19.12): routing,
// SPA fallback, caching and security headers, unbuffered streaming, WebSocket upgrades,
// the internal entry points' path and address restrictions, and access-log hygiene.
// Needs Docker and the pinned nginx image: TEST_DEPLOY=1 pnpm test:deploy
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NGINX_DIR = join(ROOT, "deploy", "production", "nginx");
const COMPOSE = join(ROOT, "deploy", "production", "compose.yml");
const LISTEN = "127.0.0.2";
const DENIED_SOURCE = "127.0.0.3";
const PORTAL = "portal.ar.test";
const WORKSPACE_DOMAIN = "agent.ar.test";
const WORKSPACE = `0b8c8f3e-6a43-4d55-9d7b-3d1c7f0c5a10.${WORKSPACE_DOMAIN}`;
const PORTS = { controlPlane: 39_011, gateway: 39_012, litellm: 39_013 };

const describeWithNginx = process.env.TEST_DEPLOY === "1" ? describe : describe.skip;

/** The nginx image pinned in the production compose file (one place to update it). */
async function pinnedNginxImage(): Promise<string> {
  const compose = await readFile(COMPOSE, "utf8");
  const match = /image:\s*(nginx:[^\s]+@sha256:[0-9a-f]{64})/.exec(compose);
  if (match?.[1] === undefined) throw new Error("no pinned nginx image in compose.yml");
  return match[1];
}

interface Seen {
  upstream: string;
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  bodyBytes: number;
}

function stub(name: string, port: number, seen: Seen[]): Promise<Server> {
  const server = createServer((request, response) => {
    let bodyBytes = 0;
    request.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length;
    });
    request.on("end", () => {
      seen.push({ upstream: name, method: request.method ?? "", url: request.url ?? "", headers: request.headers, bodyBytes });
      if (request.url === "/events") {
        // Server-sent events with gaps: a buffering proxy would deliver them together.
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write("data: first\n\n");
        setTimeout(() => response.write("data: second\n\n"), 400);
        setTimeout(() => response.end("data: last\n\n"), 800);
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=1; Path=/" });
      response.end(JSON.stringify({ upstream: name, url: request.url, bodyBytes }));
    });
  });
  // Upgrades are echoed byte for byte after the 101.
  server.on("upgrade", (request: IncomingMessage, socket) => {
    seen.push({ upstream: name, method: "UPGRADE", url: request.url ?? "", headers: request.headers, bodyBytes: 0 });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.pipe(socket);
  });
  return new Promise((resolveListen) => server.listen(port, "127.0.0.1", () => resolveListen(server)));
}

interface Response {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
  /** Milliseconds from the request to the first body chunk. */
  firstChunkMs: number | null;
  totalMs: number;
}

describeWithNginx("production nginx template", () => {
  let work = "";
  let ca = "";
  let container = "";
  const seen: Seen[] = [];
  const servers: Server[] = [];

  function send(options: {
    host: string;
    port?: number;
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
    localAddress?: string;
  }): Promise<Response> {
    return new Promise((resolveResponse, reject) => {
      const started = Date.now();
      const request = httpsRequest(
        {
          host: LISTEN,
          port: options.port ?? 443,
          servername: options.host,
          ca,
          path: options.path,
          method: options.method ?? "GET",
          headers: { host: options.host, ...options.headers },
          ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }),
        },
        (response) => {
          let body = "";
          let firstChunkMs: number | null = null;
          response.on("data", (chunk: Buffer) => {
            firstChunkMs ??= Date.now() - started;
            body += chunk.toString();
          });
          response.on("end", () =>
            resolveResponse({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body,
              firstChunkMs,
              totalMs: Date.now() - started,
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(options.body);
    });
  }

  /** Performs a WebSocket-style upgrade and echoes one message through it. */
  function upgrade(host: string, port: number, path: string): Promise<{ status: string; echoed: string }> {
    return new Promise((resolveUpgrade, reject) => {
      const socket = tlsConnect({ host: LISTEN, port, servername: host, ca }, () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
      });
      let buffer = "";
      let status = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        if (status === "" && buffer.includes("\r\n\r\n")) {
          status = buffer.split("\r\n")[0] ?? "";
          buffer = buffer.slice(buffer.indexOf("\r\n\r\n") + 4);
          if (!status.includes(" 101 ")) {
            socket.end();
            resolveUpgrade({ status, echoed: "" });
            return;
          }
          socket.write("ping-through-proxy");
        }
        if (status !== "" && buffer.includes("ping-through-proxy")) {
          socket.end();
          resolveUpgrade({ status, echoed: buffer });
        }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error(`upgrade to ${host}${path} timed out`)), 5_000);
    });
  }

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "agent-runtime-nginx-"));
    const tls = join(work, "tls");
    await mkdir(tls);
    const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: tls, stdio: "ignore" });
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=test CA",
      "-keyout", "ca.key", "-out", "ca.crt"]);
    for (const [name, sans] of [
      ["public", `DNS:${PORTAL},DNS:*.${WORKSPACE_DOMAIN}`],
      ["internal", "DNS:cp.ar.test,IP:127.0.0.2"],
    ] as const) {
      openssl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${name}`, "-keyout", `${name}.key`, "-out", `${name}.csr`]);
      await writeFile(join(tls, `${name}.ext`), `subjectAltName=${sans}\n`);
      openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
        "-days", "1", "-extfile", `${name}.ext`, "-out", `${name}.crt`]);
    }
    ca = await readFile(join(tls, "ca.crt"), "utf8");
    execFileSync("chmod", ["-R", "a+rX", tls]);

    // A release tree: /opt/agent-runtime/current -> releases/test (relative link).
    const portal = join(work, "opt", "releases", "test", "portal");
    await mkdir(join(portal, "assets"), { recursive: true });
    await writeFile(join(portal, "index.html"), "<!doctype html><title>Portal</title>");
    await writeFile(join(portal, "assets", "app-123.js"), "console.log(1)");
    await cp(NGINX_DIR, join(work, "opt", "releases", "test", "deploy", "nginx"), { recursive: true });
    await symlink("releases/test", join(work, "opt", "current"));
    await mkdir(join(work, "etc-nginx"));
    await writeFile(join(work, "etc-nginx", "worker-allow.conf"), "allow 127.0.0.1;\n");

    servers.push(
      await stub("control-plane", PORTS.controlPlane, seen),
      await stub("gateway", PORTS.gateway, seen),
      await stub("litellm", PORTS.litellm, seen),
    );

    container = `agent-runtime-nginx-test-${process.pid}`;
    execFileSync("docker", [
      "run", "-d", "--rm", "--name", container, "--network", "host",
      // As in deploy/production/compose.yml.
      "-e", "NGINX_ENVSUBST_FILTER=^AR_",
      "-e", "NGINX_ENVSUBST_TEMPLATE_DIR=/opt/agent-runtime/current/deploy/nginx/templates",
      "-e", `AR_PUBLIC_LISTEN=${LISTEN}`,
      "-e", `AR_INTERNAL_LISTEN=${LISTEN}`,
      "-e", `AR_PORTAL_HOST=${PORTAL}`,
      "-e", `AR_WORKSPACE_DOMAIN=${WORKSPACE_DOMAIN}`,
      "-e", `AR_CONTROL_PLANE_PORT=${PORTS.controlPlane}`,
      "-e", `AR_GATEWAY_PORT=${PORTS.gateway}`,
      "-e", `AR_LITELLM_PORT=${PORTS.litellm}`,
      "--tmpfs", "/etc/nginx/conf.d",
      "-v", `${join(work, "opt")}:/opt/agent-runtime:ro`,
      "-v", `${tls}:/etc/agent-runtime/tls:ro`,
      "-v", `${join(work, "etc-nginx")}:/etc/agent-runtime/nginx:ro`,
      await pinnedNginxImage(),
    ]);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await send({ host: PORTAL, path: "/" });
        break;
      } catch (error) {
        if (attempt > 50) {
          throw new Error(`nginx did not start: ${execFileSync("docker", ["logs", container]).toString()}`, { cause: error });
        }
        await new Promise((wait) => setTimeout(wait, 200));
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (container !== "") execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
    if (work !== "") await rm(work, { recursive: true, force: true });
  });

  it("serves the Portal with SPA fallback, immutable assets and security headers", async () => {
    for (const path of ["/", "/activity", "/admin/users", "/admin/workers?tab=1"]) {
      const response = await send({ host: PORTAL, path });
      expect(response.status, path).toBe(200);
      expect(response.body, path).toContain("<title>Portal</title>");
      expect(response.headers["cache-control"], path).toBe("no-cache");
      expect(response.headers["content-security-policy"], path).toContain(
        `form-action 'self' https://*.${WORKSPACE_DOMAIN}`,
      );
      expect(response.headers["content-security-policy"], path).toContain("frame-ancestors 'none'");
      expect(response.headers["strict-transport-security"], path).toBe("max-age=31536000");
      expect(response.headers["x-content-type-options"], path).toBe("nosniff");
    }
    const asset = await send({ host: PORTAL, path: "/assets/app-123.js" });
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await send({ host: PORTAL, path: "/assets/missing.js" })).status).toBe(404);
  });

  it("proxies /api and /auth to the Control Plane with an overwritten client address", async () => {
    seen.length = 0;
    const api = await send({
      host: PORTAL,
      path: "/api/workspaces",
      headers: { "x-forwarded-for": "203.0.113.9", cookie: "__Host-session=abc" },
    });
    expect(JSON.parse(api.body)).toMatchObject({ upstream: "control-plane", url: "/api/workspaces" });
    const callback = await send({ host: PORTAL, path: "/auth/oidc/callback?code=TOPSECRETCODE&state=s" });
    expect(JSON.parse(callback.body)).toMatchObject({ upstream: "control-plane", url: "/auth/oidc/callback?code=TOPSECRETCODE&state=s" });
    const forwarded = seen.find((entry) => entry.url === "/api/workspaces");
    expect(forwarded?.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(forwarded?.headers["x-forwarded-proto"]).toBe("https");
    expect(forwarded?.headers.cookie).toBe("__Host-session=abc");
  });

  it("never exposes the Worker control channel on the public entry", async () => {
    seen.length = 0;
    expect((await send({ host: PORTAL, path: "/api/workers/connect" })).status).toBe(404);
    expect((await upgrade(PORTAL, 443, "/api/workers/connect")).status).toContain(" 404 ");
    expect(seen).toEqual([]);
  });

  it("forwards Workspace hosts unchanged, unbuffered, with uploads and upgrades", async () => {
    seen.length = 0;
    const page = await send({ host: WORKSPACE, path: "/session?x=1" });
    expect(JSON.parse(page.body)).toMatchObject({ upstream: "gateway", url: "/session?x=1" });
    expect(seen[0]?.headers.host).toBe(WORKSPACE);
    // pi-web's own headers pass through; the Portal's policy is not added.
    expect(page.headers["content-security-policy"]).toBeUndefined();
    expect(page.headers["set-cookie"]).toEqual(["upstream=1; Path=/"]);

    const events = await send({ host: WORKSPACE, path: "/events" });
    expect(events.body).toContain("data: last");
    expect(events.firstChunkMs).not.toBeNull();
    expect(events.firstChunkMs ?? Infinity).toBeLessThan(300);
    expect(events.totalMs).toBeGreaterThan(700);

    const upload = await send({ host: WORKSPACE, path: "/api/files/upload", method: "POST", body: Buffer.alloc(8 * 1024 ** 2, 1) });
    expect(JSON.parse(upload.body)).toMatchObject({ bodyBytes: 8 * 1024 ** 2 });

    const socket = await upgrade(WORKSPACE, 443, "/api/terminal");
    expect(socket.status).toContain(" 101 ");
    expect(socket.echoed).toContain("ping-through-proxy");
  });

  it("rejects names it does not serve and redirects HTTP to HTTPS", async () => {
    await expect(send({ host: "other.example.test", path: "/" })).rejects.toThrow();
    const redirect = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}",
      "-H", `Host: ${PORTAL}`, `http://${LISTEN}/admin`]).toString();
    expect(redirect).toBe(`301 https://${PORTAL}/admin`);
  });

  it("opens only the Worker control path on 8443 and only for allowed addresses", async () => {
    seen.length = 0;
    const control = await upgrade("cp.ar.test", 8443, "/api/workers/connect");
    expect(control.status).toContain(" 101 ");
    expect(seen[0]).toMatchObject({ upstream: "control-plane", url: "/api/workers/connect" });
    expect((await send({ host: "cp.ar.test", port: 8443, path: "/api/workspaces" })).status).toBe(404);
    expect((await send({ host: "cp.ar.test", port: 8443, path: "/health" })).status).toBe(404);
    const denied = await send({ host: "cp.ar.test", port: 8443, path: "/api/workers/connect", localAddress: DENIED_SOURCE });
    expect(denied.status).toBe(403);
  });

  it("opens only the inference paths of the model gateway on 8444", async () => {
    seen.length = 0;
    for (const path of ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens"]) {
      const response = await send({ host: "cp.ar.test", port: 8444, path, method: "POST", body: Buffer.from("{}") });
      expect(JSON.parse(response.body), path).toMatchObject({ upstream: "litellm", url: path });
    }
    expect((await send({ host: "cp.ar.test", port: 8444, path: "/health/liveliness" })).status).toBe(200);
    for (const [method, path] of [
      ["POST", "/key/generate"],
      ["POST", "/key/delete"],
      ["GET", "/user/info"],
      ["GET", "/metrics"],
      ["GET", "/ui"],
      ["GET", "/v1/models"],
      ["GET", "/v1/chat/completions"],
    ] as const) {
      const response = await send({ host: "cp.ar.test", port: 8444, path, method });
      expect([403, 404], `${method} ${path}`).toContain(response.status);
    }
    expect(seen.map((entry) => entry.url).sort()).toEqual(
      ["/health/liveliness", "/v1/chat/completions", "/v1/messages", "/v1/messages/count_tokens", "/v1/responses"],
    );
    const denied = await send({ host: "cp.ar.test", port: 8444, path: "/v1/chat/completions", method: "POST", localAddress: DENIED_SOURCE });
    expect(denied.status).toBe(403);
  });

  it("keeps query strings and cookies out of the access log", async () => {
    await send({ host: PORTAL, path: "/auth/oauth2/callback?code=LEAKYCODE&state=s", headers: { cookie: "__Host-session=LEAKYCOOKIE" } });
    await send({ host: WORKSPACE, path: "/?access_token=LEAKYTOKEN" });
    await new Promise((wait) => setTimeout(wait, 200));
    const logs = execFileSync("docker", ["logs", container], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    expect(logs).toContain('"path":"/auth/oauth2/callback"');
    for (const secret of ["LEAKYCODE", "LEAKYCOOKIE", "LEAKYTOKEN", "TOPSECRETCODE", "__Host-session"]) {
      expect(logs).not.toContain(secret);
    }
  });
});
