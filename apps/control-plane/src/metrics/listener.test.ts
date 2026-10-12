import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMetricsServer,
  MetricsConfigError,
  readMetricsToken,
  validateMetricsListen,
} from "./listener.js";

const TOKEN = "m".repeat(20) + "-scrape-token-0123456789";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (let cleanup = cleanups.pop(); cleanup !== undefined; cleanup = cleanups.pop()) await cleanup();
});

async function serve(collect: () => Promise<string> = async () => "agent_runtime_up 1\n", logs: unknown[] = []) {
  const server = createMetricsServer({
    token: TOKEN,
    collect,
    contentType: "text/plain; version=0.0.4; charset=utf-8",
    log: { info: (fields: unknown) => logs.push(fields), warn: (fields: unknown) => logs.push(fields) },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return (path = "/metrics", init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
}

describe("metrics listener (Phase 17.7, 17.8)", () => {
  it("serves the exposition only with the exact Bearer token", async () => {
    const logs: unknown[] = [];
    const request = await serve(undefined, logs);
    const ok = await request("/metrics", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/plain");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.text()).toBe("agent_runtime_up 1\n");

    for (const authorization of [
      undefined,
      "",
      TOKEN,
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(0, 32)}`,
      "Bearer ",
    ]) {
      const response = await request("/metrics", {
        headers: authorization === undefined ? {} : { authorization },
      });
      expect(response.status, String(authorization)).toBe(401);
      expect(await response.text()).toBe("");
    }
    expect(JSON.stringify(logs)).not.toContain(TOKEN.slice(0, 32));
  });

  it("answers nothing but GET /metrics", async () => {
    const request = await serve();
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await request("/", { headers: auth })).status).toBe(404);
    expect((await request("/metrics?name[]=x", { headers: auth })).status).toBe(404);
    expect((await request("/metrics/", { headers: auth })).status).toBe(404);
    expect((await request("/metrics", { method: "POST", headers: auth })).status).toBe(405);
  });

  it("bounds concurrent scrapes and reports collection failures as 500", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const request = await serve(async () => {
      await gate;
      return "x 1\n";
    });
    const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
    const first = request("/metrics", auth);
    const second = request("/metrics", auth);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await request("/metrics", auth)).status).toBe(503);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);

    const failing = await serve(async () => {
      throw new Error("boom");
    });
    expect((await failing("/metrics", auth)).status).toBe(500);
  });
});

describe("metrics configuration", () => {
  async function directory() {
    const path = await mkdtemp(join(tmpdir(), "metrics-token-"));
    cleanups.push(() => rm(path, { recursive: true, force: true }));
    return path;
  }

  it("reads an owner-only token file and strips one trailing newline", async () => {
    const path = join(await directory(), "token");
    await writeFile(path, `${TOKEN}\n`, { mode: 0o600 });
    await expect(readMetricsToken(path)).resolves.toBe(TOKEN);
  });

  it("refuses missing, linked, shared, short or non-printable token files", async () => {
    const root = await directory();
    await expect(readMetricsToken(join(root, "missing"))).rejects.toBeInstanceOf(MetricsConfigError);

    const target = join(root, "target");
    await writeFile(target, TOKEN, { mode: 0o600 });
    const link = join(root, "link");
    await symlink(target, link);
    await expect(readMetricsToken(link)).rejects.toThrow(/symbolic link/);

    const shared = join(root, "shared");
    await writeFile(shared, TOKEN, { mode: 0o600 });
    await chmod(shared, 0o640);
    await expect(readMetricsToken(shared)).rejects.toThrow(/group or others/);

    for (const content of ["short", `${TOKEN} with space`, ""]) {
      const path = join(root, `bad-${content.length}`);
      await writeFile(path, content, { mode: 0o600 });
      await expect(readMetricsToken(path)).rejects.toThrow(/32-512/);
    }
    await expect(readMetricsToken(root)).rejects.toThrow(/regular file/);
  });

  it("rejects wildcard addresses and clashes with the other listeners", () => {
    const listeners = [
      { host: "0.0.0.0", port: 3000 },
      { host: "127.0.0.1", port: 3001 },
    ];
    for (const metricsHost of ["0.0.0.0", "::", "[::]", "*", "example.com"]) {
      expect(() => validateMetricsListen({ metricsHost, metricsPort: 9464, listeners }), metricsHost)
        .toThrow(MetricsConfigError);
    }
    expect(() => validateMetricsListen({ metricsHost: "127.0.0.1", metricsPort: 3000, listeners })).toThrow(/differ/);
    expect(() => validateMetricsListen({ metricsHost: "127.0.0.1", metricsPort: 3001, listeners })).toThrow(/differ/);
    expect(() => validateMetricsListen({ metricsHost: "127.0.0.1", metricsPort: 9464, listeners })).not.toThrow();
    expect(() => validateMetricsListen({ metricsHost: "192.168.1.10", metricsPort: 3001, listeners })).not.toThrow();
    expect(() => validateMetricsListen({ metricsHost: "::1", metricsPort: 9464, listeners })).not.toThrow();
  });
});
