import { describe, expect, it } from "vitest";

import { buildControlPlane } from "../app.js";
import {
  beginOidcLogin,
  configureTestOidc,
  createTestDependencies,
  firstCookie,
  login,
  ORIGIN,
  USER_A_ID,
  USER_B_ID,
} from "./test-fixtures.js";

describe("Phase 10 Generic OIDC", () => {
  it("keeps SSO optional so Local Admin login remains available", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const methods = await app.inject({
      method: "GET",
      url: "/api/auth/methods",
    });
    const disabledSso = await app.inject({
      method: "GET",
      url: "/auth/oidc/login",
    });
    const admin = await login(app, "admin", "password-for-admin");

    expect(methods.json()).toEqual({
      oidc: { enabled: false, providerId: null },
      oauth2: { enabled: false, providerId: null },
    });
    expect(disabledSso.statusCode).toBe(404);
    expect(admin.cookie).toContain("platform-session=");
    await app.close();
  });

  it("allows only an admin to pre-bind the configured provider and exact subject", async () => {
    const dependencies = await createTestDependencies();
    configureTestOidc(dependencies);
    const app = buildControlPlane(dependencies);
    const methods = await app.inject({
      method: "GET",
      url: "/api/auth/methods",
    });
    const admin = await login(app, "admin", "password-for-admin");
    const user = await login(app, "user-a", "password-for-user-a");
    const userAttempt = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/oidc-identities`,
      headers: {
        cookie: user.cookie,
        origin: ORIGIN,
        "x-csrf-token": user.csrfToken,
      },
      payload: {
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
      },
    });
    const providerMismatch = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/oidc-identities`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
      payload: {
        providerId: "another-provider",
        providerSubject: "subject-a",
      },
    });
    const bound = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/oidc-identities`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
      payload: {
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
      },
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_B_ID}/oidc-identities`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
      payload: {
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
      },
    });

    expect(methods.json()).toEqual({
      oidc: { enabled: true, providerId: "enterprise-oidc" },
      oauth2: { enabled: false, providerId: null },
    });
    expect(userAttempt.statusCode).toBe(403);
    expect(providerMismatch.statusCode).toBe(400);
    expect(providerMismatch.json()).toMatchObject({
      error: { code: "OIDC_PROVIDER_MISMATCH" },
    });
    expect(bound.statusCode).toBe(201);
    expect(bound.json()).toMatchObject({
      identity: {
        userId: USER_A_ID,
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
      },
    });
    expect(duplicate.statusCode).toBe(409);
    await app.close();
  });

  it("rejects unknown and disabled identities, but creates a Platform session for a known active identity", async () => {
    const dependencies = await createTestDependencies();
    const behavior = configureTestOidc(dependencies);
    const app = buildControlPlane(dependencies);
    const admin = await login(app, "admin", "password-for-admin");
    const userB = await login(app, "user-b", "password-for-user-b");
    const workspaceB = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userB.cookie,
        origin: ORIGIN,
        "x-csrf-token": userB.csrfToken,
      },
      payload: { name: "user-b-private" },
    });
    const workspaceBId = workspaceB.json<{ workspace: { id: string } }>()
      .workspace.id;

    const unknownTransaction = await beginOidcLogin(app);
    const unknown = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=expected-state",
      headers: { cookie: unknownTransaction },
    });
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json()).toMatchObject({
      error: { code: "OIDC_IDENTITY_NOT_BOUND" },
    });

    const binding = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/oidc-identities`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
      payload: {
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
      },
    });
    expect(binding.statusCode).toBe(201);

    const knownTransaction = await beginOidcLogin(app);
    const known = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=expected-state",
      headers: { cookie: knownTransaction },
    });
    expect(known.statusCode).toBe(302);
    expect(known.headers.location).toBe(ORIGIN);
    const oidcSession = firstCookie(known, "platform-session");
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: oidcSession },
    });
    const foreignWorkspace = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceBId}`,
      headers: { cookie: oidcSession },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { id: USER_A_ID, role: "user" } });
    expect(foreignWorkspace.statusCode).toBe(404);

    behavior.subject = "subject-with-the-same-email";
    behavior.emailSnapshot = "a@example.test";
    const sameEmailTransaction = await beginOidcLogin(app);
    const sameEmail = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-b&state=expected-state",
      headers: { cookie: sameEmailTransaction },
    });
    expect(sameEmail.statusCode).toBe(403);
    expect(sameEmail.json()).toMatchObject({
      error: { code: "OIDC_IDENTITY_NOT_BOUND" },
    });

    await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${USER_A_ID}`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
      payload: { status: "disabled" },
    });
    behavior.subject = "subject-a";
    const disabledTransaction = await beginOidcLogin(app);
    const disabled = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-c&state=expected-state",
      headers: { cookie: disabledTransaction },
    });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toMatchObject({
      error: { code: "OIDC_USER_DISABLED" },
    });
    await app.close();
  });

  it("consumes callback transactions once and returns one stable failure code", async () => {
    const dependencies = await createTestDependencies();
    configureTestOidc(dependencies);
    const app = buildControlPlane(dependencies);
    const transactionCookie = await beginOidcLogin(app);
    const mismatch = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=wrong-state",
      headers: { cookie: transactionCookie },
    });
    const replay = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=expected-state",
      headers: { cookie: transactionCookie },
    });

    expect(mismatch.statusCode).toBe(401);
    expect(mismatch.json()).toEqual({
      error: {
        code: "OIDC_AUTHENTICATION_FAILED",
        message: "OIDC authentication failed",
      },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({
      error: { code: "OIDC_TRANSACTION_INVALID" },
    });
    await app.close();
  });
});
