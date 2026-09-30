import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createLogger,
  isRequestId,
  LoggingConfigSchema,
  newRequestId,
  serializers,
  workspacePathClass,
} from "./index.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { lines, stream };
}

describe("logging configuration", () => {
  it("defaults to JSON at info level and rejects unknown values", () => {
    expect(LoggingConfigSchema.parse({})).toEqual({ LOG_LEVEL: "info", LOG_FORMAT: "json" });
    expect(LoggingConfigSchema.safeParse({ LOG_FORMAT: "xml" }).success).toBe(false);
  });
});

describe("credential redaction", () => {
  it("censors credentials even when a raw object is logged by mistake", async () => {
    const { lines, stream } = capture();
    const logger = await createLogger("test", LoggingConfigSchema.parse({}), stream);
    logger.info({
      headers: { cookie: "platform-session=secret-cookie", authorization: "Bearer secret-bearer" },
      password: "secret-password",
      token: "secret-token",
      rawToken: "secret-raw",
      code: "secret-oauth-code",
      body: { password: "secret-body" },
      details: { cookie: "secret-nested-cookie", authorization: "secret-nested-auth" },
    }, "raw object");
    const output = lines.join("");
    for (const secret of ["secret-cookie", "secret-bearer", "secret-password", "secret-token", "secret-raw", "secret-oauth-code", "secret-body", "secret-nested-cookie", "secret-nested-auth"]) {
      expect(output).not.toContain(secret);
    }
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ service: "test", msg: "raw object" });
  });

  it("serializes requests with the route template only, never the raw URL", () => {
    expect(serializers.req({
      method: "GET",
      routeOptions: { url: "/auth/oidc/callback" },
      // Extra fields a real request carries must not leak through the serializer.
      ...{ url: "/auth/oidc/callback?code=secret&state=s", headers: { cookie: "c" } },
    } as never)).toEqual({ method: "GET", route: "/auth/oidc/callback" });
    expect(serializers.req({ method: "GET" })).toEqual({ method: "GET", route: "unmatched" });
  });

  it("keeps the root cause chain without stacks of causes", () => {
    const root = new Error("Docker image not found");
    const serialized = serializers.err(new Error("Capability probe failed", { cause: root }));
    expect(serialized.cause).toEqual({ type: "Error", message: "Docker image not found", code: undefined });
  });

  it("keeps only stable error fields", () => {
    const error = Object.assign(new Error("duplicate key"), { code: "23505", detail: "Key (email)=(a@b.c)" });
    expect(serializers.err(error)).toEqual({
      type: "Error",
      message: "duplicate key",
      code: "23505",
      stack: error.stack,
    });
  });
});

describe("request and path helpers", () => {
  it("accepts only UUID request IDs", () => {
    expect(isRequestId(newRequestId())).toBe(true);
    expect(isRequestId("req-1")).toBe(false);
    expect(isRequestId('x"}\n{"injected":true')).toBe(false);
    expect(isRequestId(undefined)).toBe(false);
  });

  it("reduces Workspace paths to their first segment", () => {
    expect(workspacePathClass("/api/files/home/agent/secret-report.pdf?download=1")).toBe("/api");
    expect(workspacePathClass("/")).toBe("/");
    expect(workspacePathClass("/_platform/session")).toBe("/_platform");
    expect(workspacePathClass("/%2e%2e/etc")).toBe("/");
    expect(workspacePathClass(undefined)).toBe("/");
  });
});
