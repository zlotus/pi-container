import { describe, expect, it } from "vitest";

import { parseServerConfig } from "./config.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://agent-runtime.test/database",
  SESSION_SECRET: "test-session-secret-that-is-at-least-32-characters",
  WORKSPACE_BASE_URL: "http://agent.test:3001",
};

describe("Portal Origin configuration", () => {
  it("keeps a canonical origin and parses multiple exact-match allowed origins", () => {
    const config = parseServerConfig({
      ...REQUIRED_ENV,
      PORTAL_ORIGIN: "http://127.0.0.1:5173",
      PORTAL_ALLOWED_ORIGINS:
        " http://192.168.1.124:5173,https://portal.tailnet.test ",
    });

    expect(config.PORTAL_ORIGIN).toBe("http://127.0.0.1:5173");
    expect(config.PORTAL_ALLOWED_ORIGINS).toEqual([
      "http://192.168.1.124:5173",
      "https://portal.tailnet.test",
    ]);
  });

  it("defaults the optional allowlist to empty", () => {
    const config = parseServerConfig(REQUIRED_ENV);

    expect(config.PORTAL_ALLOWED_ORIGINS).toEqual([]);
  });

  it.each([
    "*",
    "https://*.example.test",
    "https://portal.test,,https://lan.test",
    "ftp://portal.test",
    "not-an-origin",
  ])("rejects an unsafe allowed-origin list entry: %s", (allowedOrigins) => {
    expect(() =>
      parseServerConfig({
        ...REQUIRED_ENV,
        PORTAL_ALLOWED_ORIGINS: allowedOrigins,
      }),
    ).toThrow();
  });

  it("rejects a wildcard canonical origin", () => {
    expect(() =>
      parseServerConfig({
        ...REQUIRED_ENV,
        PORTAL_ORIGIN: "https://*.example.test",
      }),
    ).toThrow();
  });
});
