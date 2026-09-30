import type { PlatformAuditEvent } from "@agent-runtime/database";
import { describe, expect, it } from "vitest";

import { buildControlPlane } from "../app.js";
import {
  beginOAuth2Login,
  beginOidcLogin,
  configureTestOAuth2,
  configureTestOidc,
  createTestDependencies,
  firstCookie,
  login,
  ORIGIN,
} from "./test-fixtures.js";

describe("Phase 12 authentication audit and hardening", () => {
  it("keeps production OIDC cookies host-only and redirects only to the configured Portal", async () => {
    const dependencies = await createTestDependencies();
    configureTestOidc(dependencies);
    if (dependencies.oidc === undefined) throw new Error("OIDC test runtime missing");
    dependencies.oidc.autoProvision = true;
    dependencies.secureCookies = true;
    const app = buildControlPlane(dependencies);
    const loginResponse = await app.inject({
      method: "GET",
      url: "/auth/oidc/login",
    });
    const transactionCookie = firstCookie(
      loginResponse,
      "__Host-oidc-transaction",
    );
    const setCookie = loginResponse.headers["set-cookie"];
    const serialized = Array.isArray(setCookie) ? setCookie.join(";") : setCookie;
    const callback = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=expected-state&returnTo=https%3A%2F%2Fattacker.test",
      headers: {
        cookie: transactionCookie,
        host: "attacker.test",
      },
    });
    const callbackCookies = callback.headers["set-cookie"];
    const callbackSerialized = Array.isArray(callbackCookies)
      ? callbackCookies.join(";")
      : callbackCookies;

    expect(serialized).toContain("Secure");
    expect(serialized).toContain("HttpOnly");
    expect(serialized).toContain("SameSite=Lax");
    expect(serialized).not.toContain("Domain=");
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(ORIGIN);
    expect(callbackSerialized).toContain("__Host-platform-session=");
    expect(callbackSerialized).toContain("Secure");
    expect(callbackSerialized).not.toContain("Domain=");
    await app.close();
  });

  it("records complete admin-only auth events with stable categories and no secrets", async () => {
    const dependencies = await createTestDependencies();
    configureTestOidc(dependencies);
    configureTestOAuth2(dependencies);
    if (dependencies.oidc === undefined) throw new Error("OIDC test runtime missing");
    if (dependencies.oauth2 === undefined) throw new Error("OAuth2 test runtime missing");
    const app = buildControlPlane(dependencies);
    const admin = await login(app, "admin", "password-for-admin");
    const user = await login(app, "user-a", "password-for-user-a");
    const adminHeaders = {
      cookie: admin.cookie,
      origin: ORIGIN,
      "x-csrf-token": admin.csrfToken,
    };

    const failedLocal = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN, "user-agent": "phase12-test-agent" },
      payload: {
        login: "user-a",
        password: "password-secret-marker",
      },
    });
    const transaction = await beginOidcLogin(app);
    dependencies.oidc.client = {
      ...dependencies.oidc.client,
      async exchangeAuthorizationCode() {
        throw new Error(
          "authorization-code-secret access-token-secret client-secret-marker",
        );
      },
    };
    const failedOidc = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=authorization-code-secret&state=expected-state",
      headers: { cookie: transaction },
    });
    const oauth2Transaction = await beginOAuth2Login(app);
    dependencies.oauth2.client = {
      ...dependencies.oauth2.client,
      async exchangeAuthorizationCode() {
        throw new Error(
          "oauth-authorization-code-secret oauth-access-token-secret oauth-client-secret-marker",
        );
      },
    };
    const failedOAuth2 = await app.inject({
      method: "GET",
      url: "/auth/oauth2/callback?code=oauth-authorization-code-secret&state=oauth-expected-state",
      headers: { cookie: oauth2Transaction },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: adminHeaders,
      payload: {
        email: "phase12@example.test",
        username: "phase12-user",
        password: "new-password-secret-marker",
      },
    });
    const targetId = created.json<{ user: { id: string } }>().user.id;
    for (const payload of [
      { role: "admin" },
      { role: "user" },
      { status: "disabled" },
      { status: "active" },
    ]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/admin/users/${targetId}`,
        headers: adminHeaders,
        payload,
      });
      expect(response.statusCode).toBe(200);
    }
    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/reset-password`,
      headers: adminHeaders,
      payload: { password: "replacement-secret-marker" },
    });
    const revoked = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/revoke-sessions`,
      headers: adminHeaders,
      payload: {},
    });
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: user.cookie,
        origin: ORIGIN,
        "x-csrf-token": user.csrfToken,
      },
      payload: {},
    });
    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/audit-events?limit=100",
      headers: { cookie: admin.cookie },
    });
    const events = auditResponse.json<{ events: PlatformAuditEvent[] }>().events;
    const eventTypes = events.map((event) => event.eventType);
    const serialized = JSON.stringify(events);
    const userAudit = await app.inject({
      method: "GET",
      url: "/api/audit-events?limit=100",
      headers: { cookie: (await login(app, "user-b", "password-for-user-b")).cookie },
    });

    expect(failedLocal.statusCode).toBe(401);
    expect(failedOidc.statusCode).toBe(401);
    expect(failedOAuth2.statusCode).toBe(401);
    expect(created.statusCode).toBe(201);
    expect(reset.statusCode).toBe(204);
    expect(revoked.statusCode).toBe(204);
    expect(logout.statusCode).toBe(204);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "auth.login_succeeded",
        "auth.login_failed",
        "auth.logout",
        "auth.session_revoked",
        "user.created",
        "user.enabled",
        "user.disabled",
        "user.role_changed",
        "user.password_reset",
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "auth.login_failed",
          details: expect.objectContaining({
            protocol: "LOCAL",
            providerId: "local",
            category: "invalid_credentials",
          }),
        }),
        expect.objectContaining({
          eventType: "auth.login_failed",
          details: expect.objectContaining({
            protocol: "OIDC",
            providerId: "enterprise-oidc",
            category: "protocol_validation_failed",
          }),
        }),
        expect.objectContaining({
          eventType: "auth.login_failed",
          details: expect.objectContaining({
            protocol: "OAUTH2",
            providerId: "enterprise-oauth2",
            category: "protocol_validation_failed",
          }),
        }),
      ]),
    );
    for (const secret of [
      "password-secret-marker",
      "new-password-secret-marker",
      "replacement-secret-marker",
      "authorization-code-secret",
      "access-token-secret",
      "client-secret-marker",
      "oauth-authorization-code-secret",
      "oauth-access-token-secret",
      "oauth-client-secret-marker",
      "expected-code-verifier",
      "expected-nonce",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(
      userAudit
        .json<{ events: PlatformAuditEvent[] }>()
        .events.some((event) =>
          event.eventType.startsWith("auth.") ||
          event.eventType.startsWith("user.") ||
          event.eventType.startsWith("identity."),
        ),
    ).toBe(false);
    await app.close();
  });
});
