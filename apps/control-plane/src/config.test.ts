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

describe("Phase 10 OIDC configuration", () => {
  it("keeps OIDC disabled and auto-provisioning off by default", () => {
    const config = parseServerConfig(REQUIRED_ENV);

    expect(config.AUTH_OIDC_ENABLED).toBe(false);
    expect(config.AUTH_OIDC_AUTO_PROVISION).toBe(false);
    expect(config.AUTH_OIDC_ALLOWED_DOMAINS).toEqual([]);
    expect(config.AUTH_OIDC_PROVIDER_ID).toBe("generic-oidc");
    expect(config.AUTH_OAUTH2_ENABLED).toBe(false);
    expect(config.AUTH_OAUTH2_AUTO_PROVISION).toBe(false);
  });

  it("accepts one fully configured Generic OIDC provider", () => {
    const config = parseServerConfig({
      ...REQUIRED_ENV,
      AUTH_OIDC_ENABLED: "true",
      AUTH_OIDC_PROVIDER_ID: "enterprise-oidc",
      AUTH_OIDC_ISSUER: "https://idp.example.test/realms/enterprise",
      AUTH_OIDC_CLIENT_ID: "agent-runtime",
      AUTH_OIDC_CLIENT_SECRET: "not-a-real-secret",
      AUTH_OIDC_AUTO_PROVISION: "false",
    });

    expect(config).toMatchObject({
      AUTH_OIDC_ENABLED: true,
      AUTH_OIDC_PROVIDER_ID: "enterprise-oidc",
      AUTH_OIDC_ISSUER: "https://idp.example.test/realms/enterprise",
      AUTH_OIDC_CLIENT_ID: "agent-runtime",
      AUTH_OIDC_CLIENT_SECRET: "not-a-real-secret",
      AUTH_OIDC_AUTO_PROVISION: false,
    });
  });

  it("rejects incomplete providers and orphaned auto-provisioning", () => {
    expect(() =>
      parseServerConfig({
        ...REQUIRED_ENV,
        AUTH_OIDC_ENABLED: "true",
      }),
    ).toThrow();
    expect(() =>
      parseServerConfig({
        ...REQUIRED_ENV,
        AUTH_OIDC_AUTO_PROVISION: "true",
      }),
    ).toThrow("AUTH_OIDC_AUTO_PROVISION requires AUTH_OIDC_ENABLED=true");
  });

  it("accepts JIT and exact allowed domains for an enabled OIDC provider", () => {
    const config = parseServerConfig({
      ...REQUIRED_ENV,
      AUTH_OIDC_ENABLED: "true",
      AUTH_OIDC_ISSUER: "https://idp.example.test",
      AUTH_OIDC_CLIENT_ID: "agent-runtime",
      AUTH_OIDC_CLIENT_SECRET: "secret",
      AUTH_OIDC_AUTO_PROVISION: "true",
      AUTH_OIDC_ALLOWED_DOMAINS: " Example.Test,subsidiary.example ",
    });
    expect(config.AUTH_OIDC_AUTO_PROVISION).toBe(true);
    expect(config.AUTH_OIDC_ALLOWED_DOMAINS).toEqual([
      "example.test",
      "subsidiary.example",
    ]);
  });

  it.each(["*", "*.example.test", "example.test,,other.test", "https://example.test"])(
    "rejects an unsafe JIT domain entry: %s",
    (allowedDomains) => {
      expect(() =>
        parseServerConfig({
          ...REQUIRED_ENV,
          AUTH_OIDC_ALLOWED_DOMAINS: allowedDomains,
        }),
      ).toThrow();
    },
  );

  it.each([
    "ftp://idp.example.test",
    "http://idp.internal.test",
    "https://user:password@idp.example.test",
    "https://idp.example.test?tenant=a",
    "not-an-issuer",
  ])("rejects an unsafe issuer value: %s", (issuer) => {
    expect(() =>
      parseServerConfig({
        ...REQUIRED_ENV,
        AUTH_OIDC_ISSUER: issuer,
      }),
    ).toThrow();
  });
});

describe("Phase 11 OAuth2 UserInfo configuration", () => {
  const OAUTH2_ENV = {
    ...REQUIRED_ENV,
    AUTH_OAUTH2_ENABLED: "true",
    AUTH_OAUTH2_PROVIDER_ID: "enterprise-oauth2",
    AUTH_OAUTH2_AUTHORIZATION_URL: "https://portal.example.test/oauth/authorize",
    AUTH_OAUTH2_TOKEN_URL: "https://portal.example.test/oauth/token",
    AUTH_OAUTH2_USERINFO_URL: "https://portal.example.test/oauth/userinfo",
    AUTH_OAUTH2_CLIENT_ID: "agent-runtime",
    AUTH_OAUTH2_CLIENT_SECRET: "secret",
    AUTH_OAUTH2_SUBJECT_FIELD: "attributes.workcode",
    AUTH_OAUTH2_USERNAME_FIELD: "attributes.workcode",
    AUTH_OAUTH2_EMAIL_FIELD: "attributes.email",
    AUTH_OAUTH2_DISPLAY_NAME_FIELD: "attributes.displayName",
  };

  it("accepts independent endpoints and nested JSON field mappings", () => {
    const config = parseServerConfig(OAUTH2_ENV);
    expect(config).toMatchObject({
      AUTH_OAUTH2_ENABLED: true,
      AUTH_OAUTH2_PROVIDER_ID: "enterprise-oauth2",
      AUTH_OAUTH2_SUBJECT_FIELD: "attributes.workcode",
      AUTH_OAUTH2_EMAIL_FIELD: "attributes.email",
      AUTH_OAUTH2_USERINFO_TOKEN_METHOD: "bearer",
    });

    expect(
      parseServerConfig({
        ...OAUTH2_ENV,
        AUTH_OAUTH2_USERINFO_TOKEN_METHOD: "query",
        AUTH_OAUTH2_SUBJECT_FIELD: 'attributes["workcode"]',
      }),
    ).toMatchObject({
      AUTH_OAUTH2_USERINFO_TOKEN_METHOD: "query",
      AUTH_OAUTH2_SUBJECT_FIELD: 'attributes["workcode"]',
    });
  });

  it("rejects incomplete, unsafe, malformed, and provider-ID-conflicting config", () => {
    expect(() =>
      parseServerConfig({ ...REQUIRED_ENV, AUTH_OAUTH2_ENABLED: "true" }),
    ).toThrow();
    expect(() =>
      parseServerConfig({
        ...OAUTH2_ENV,
        AUTH_OAUTH2_TOKEN_URL: "http://portal.example.test/token",
      }),
    ).toThrow();
    expect(() =>
      parseServerConfig({
        ...OAUTH2_ENV,
        AUTH_OAUTH2_SUBJECT_FIELD: "attributes..workcode",
      }),
    ).toThrow();
    expect(() =>
      parseServerConfig({
        ...OAUTH2_ENV,
        AUTH_OAUTH2_USERINFO_TOKEN_METHOD: "fragment",
      }),
    ).toThrow();
    expect(() =>
      parseServerConfig({
        ...OAUTH2_ENV,
        AUTH_OIDC_ENABLED: "true",
        AUTH_OIDC_PROVIDER_ID: "enterprise-oauth2",
        AUTH_OIDC_ISSUER: "https://idp.example.test",
        AUTH_OIDC_CLIENT_ID: "oidc-client",
        AUTH_OIDC_CLIENT_SECRET: "oidc-secret",
      }),
    ).toThrow("provider IDs must be distinct");
  });
});

describe("model gateway configuration (Phase 16.8)", () => {
  const GATEWAY = {
    MODEL_GATEWAY_ADMIN_URL: "http://127.0.0.1:4400",
    MODEL_GATEWAY_MASTER_KEY: "sk-0123456789abcdef0123456789abcdef",
    MODEL_GATEWAY_CATALOG_FILE: "/etc/agent-runtime/catalog.json",
  };

  it("is off by default and parses the full configuration", () => {
    expect(parseServerConfig(REQUIRED_ENV)).toMatchObject({
      MODEL_GATEWAY_ADMIN_URL: "",
      MODEL_GATEWAY_USER_BUDGET_USD: null,
      MODEL_GATEWAY_BUDGET_DURATION: "30d",
      MODEL_GATEWAY_KEY_RPM: 60,
      MODEL_GATEWAY_KEY_TPM: null,
    });
    expect(
      parseServerConfig({ ...REQUIRED_ENV, ...GATEWAY, MODEL_GATEWAY_USER_BUDGET_USD: "25", MODEL_GATEWAY_KEY_TPM: "100000" }),
    ).toMatchObject({ MODEL_GATEWAY_USER_BUDGET_USD: 25, MODEL_GATEWAY_KEY_TPM: 100_000 });
  });

  it.each([
    { MODEL_GATEWAY_MASTER_KEY: "sk-x" },
    { MODEL_GATEWAY_MASTER_KEY: "not-a-litellm-key-0123456789" },
    { MODEL_GATEWAY_CATALOG_FILE: "catalog.json" },
    { MODEL_GATEWAY_ADMIN_URL: "http://gateway.internal:4000" },
    { MODEL_GATEWAY_ADMIN_URL: "https://user:pass@gateway.internal" },
    { MODEL_GATEWAY_USER_BUDGET_USD: "-1" },
    { MODEL_GATEWAY_BUDGET_DURATION: "monthly" },
    { MODEL_GATEWAY_KEY_TPM: "1.5" },
  ])("rejects an unsafe or invalid gateway setting: %o", (override) => {
    expect(() => parseServerConfig({ ...REQUIRED_ENV, ...GATEWAY, ...override })).toThrow();
  });

  it("rejects a partial configuration instead of silently disabling it", () => {
    expect(() => parseServerConfig({ ...REQUIRED_ENV, MODEL_GATEWAY_MASTER_KEY: GATEWAY.MODEL_GATEWAY_MASTER_KEY })).toThrow();
    expect(() => parseServerConfig({ ...REQUIRED_ENV, MODEL_GATEWAY_ADMIN_URL: GATEWAY.MODEL_GATEWAY_ADMIN_URL })).toThrow();
  });
});

describe("metrics configuration (Phase 17.7)", () => {
  it("is off by default and needs a token file when a port is set", () => {
    expect(parseServerConfig(REQUIRED_ENV)).toMatchObject({
      METRICS_HOST: "127.0.0.1",
      METRICS_PORT: null,
      METRICS_TOKEN_FILE: "",
    });
    expect(
      parseServerConfig({ ...REQUIRED_ENV, METRICS_PORT: "9464", METRICS_TOKEN_FILE: "/etc/agent-runtime/metrics.token" }),
    ).toMatchObject({ METRICS_PORT: 9464 });
  });

  it.each([
    { METRICS_PORT: "9464" },
    { METRICS_PORT: "9464", METRICS_TOKEN_FILE: "metrics.token" },
    { METRICS_PORT: "70000", METRICS_TOKEN_FILE: "/t" },
    { METRICS_PORT: "abc", METRICS_TOKEN_FILE: "/t" },
    { METRICS_TOKEN_FILE: "/etc/agent-runtime/metrics.token" },
  ])("rejects an incomplete metrics setting: %o", (override) => {
    expect(() => parseServerConfig({ ...REQUIRED_ENV, ...override })).toThrow();
  });
});
