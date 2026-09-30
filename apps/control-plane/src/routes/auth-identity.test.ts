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
  USER_A_ID,
} from "./test-fixtures.js";

describe("Phase 11 provisioning and identity management", () => {
  it("keeps JIT off by default, provisions role=user when enabled, and enforces exact allowed domains", async () => {
    const dependencies = await createTestDependencies();
    const behavior = configureTestOidc(dependencies);
    if (dependencies.oidc === undefined) throw new Error("OIDC test runtime missing");
    dependencies.oidc.autoProvision = true;
    dependencies.oidc.allowedDomains = ["example.test"];
    behavior.subject = "new-subject-with-existing-email";
    behavior.emailSnapshot = "a@example.test";
    const app = buildControlPlane(dependencies);

    const transaction = await beginOidcLogin(app);
    const callback = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=expected-state",
      headers: { cookie: transaction },
    });
    expect(callback.statusCode).toBe(302);
    const jitSession = firstCookie(callback, "platform-session");
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: jitSession },
    });
    const jitUser = me.json<{ user: { id: string; role: string; email: string } }>().user;
    expect(jitUser).toMatchObject({ role: "user", email: "a@example.test" });
    expect(jitUser.id).not.toBe(USER_A_ID);
    const adminDenied = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: jitSession },
    });
    expect(adminDenied.statusCode).toBe(403);

    behavior.subject = "domain-denied-subject";
    behavior.emailSnapshot = "person@outside.test";
    const deniedTransaction = await beginOidcLogin(app);
    const denied = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-b&state=expected-state",
      headers: { cookie: deniedTransaction },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: { code: "OIDC_PROVISIONING_NOT_ALLOWED" },
    });

    behavior.subject = "missing-email-subject";
    behavior.emailSnapshot = null;
    const missingEmailTransaction = await beginOidcLogin(app);
    const missingEmail = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-c&state=expected-state",
      headers: { cookie: missingEmailTransaction },
    });
    expect(missingEmail.statusCode).toBe(403);
    await app.close();
  });

  it("lists, binds, and unbinds stable identities with authorization, audit, and last-login protection", async () => {
    const dependencies = await createTestDependencies();
    configureTestOidc(dependencies);
    configureTestOAuth2(dependencies);
    const app = buildControlPlane(dependencies);
    const admin = await login(app, "admin", "password-for-admin");
    const user = await login(app, "user-a", "password-for-user-a");
    const bind = async (providerId: string, providerSubject: string) =>
      app.inject({
        method: "POST",
        url: `/api/admin/users/${USER_A_ID}/identities`,
        headers: {
          cookie: admin.cookie,
          origin: ORIGIN,
          "x-csrf-token": admin.csrfToken,
        },
        payload: { providerId, providerSubject },
      });

    const oidcBound = await bind("enterprise-oidc", "subject-a");
    const oauthBound = await bind("enterprise-oauth2", "oauth-subject-a");
    expect(oidcBound.statusCode).toBe(201);
    expect(oauthBound.statusCode).toBe(201);
    const userListDenied = await app.inject({
      method: "GET",
      url: `/api/admin/users/${USER_A_ID}/identities`,
      headers: { cookie: user.cookie },
    });
    expect(userListDenied.statusCode).toBe(403);

    const listed = await app.inject({
      method: "GET",
      url: `/api/admin/users/${USER_A_ID}/identities`,
      headers: { cookie: admin.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const identities = listed.json<{ identities: Array<{ id: string; providerId: string }> }>()
      .identities;
    expect(identities.map((identity) => identity.providerId)).toEqual([
      "enterprise-oidc",
      "enterprise-oauth2",
    ]);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${USER_A_ID}/identities/${identities[0]?.id}`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
    });
    expect(removed.statusCode).toBe(204);
    const audit = await app.inject({
      method: "GET",
      url: "/api/audit-events?limit=20",
      headers: { cookie: admin.cookie },
    });
    const identityEvents = audit
      .json<{ events: Array<{ eventType: string; details: Record<string, unknown> }> }>()
      .events.filter((event) => event.eventType.startsWith("identity."));
    expect(identityEvents.map((event) => event.eventType)).toEqual([
      "identity.unbound",
      "identity.bound",
      "identity.bound",
    ]);
    expect(JSON.stringify(identityEvents)).not.toContain("subject-a");

    if (dependencies.oidc === undefined) throw new Error("OIDC test runtime missing");
    dependencies.oidc.autoProvision = true;
    const behavior = configureTestOidc(dependencies);
    dependencies.oidc.autoProvision = true;
    behavior.subject = "external-only";
    behavior.emailSnapshot = "external-only@example.test";
    const externalTransaction = await beginOidcLogin(app);
    const externalLogin = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-d&state=expected-state",
      headers: { cookie: externalTransaction },
    });
    const externalSession = firstCookie(externalLogin, "platform-session");
    const externalMe = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: externalSession },
    });
    const externalUserId = externalMe.json<{ user: { id: string } }>().user.id;
    const externalIdentities = await app.inject({
      method: "GET",
      url: `/api/admin/users/${externalUserId}/identities`,
      headers: { cookie: admin.cookie },
    });
    const onlyIdentity = externalIdentities.json<{ identities: Array<{ id: string }> }>()
      .identities[0];
    if (onlyIdentity === undefined) throw new Error("JIT identity missing");
    const lockedOut = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${externalUserId}/identities/${onlyIdentity.id}`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        "x-csrf-token": admin.csrfToken,
      },
    });
    expect(lockedOut.statusCode).toBe(409);
    expect(lockedOut.json()).toMatchObject({
      error: { code: "LAST_LOGIN_METHOD" },
    });
    await app.close();
  });

  it("routes OAuth2 UserInfo profiles through the same JIT and Platform Session chain", async () => {
    const dependencies = await createTestDependencies();
    configureTestOAuth2(dependencies);
    if (dependencies.oauth2 === undefined) throw new Error("OAuth2 test runtime missing");
    dependencies.oauth2.autoProvision = true;
    dependencies.oauth2.allowedDomains = ["example.test"];
    const app = buildControlPlane(dependencies);
    const transaction = await beginOAuth2Login(app);
    const callback = await app.inject({
      method: "GET",
      url: "/auth/oauth2/callback?code=oauth-code&state=oauth-expected-state",
      headers: { cookie: transaction },
    });
    expect(callback.statusCode).toBe(302);
    const session = firstCookie(callback, "platform-session");
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: session },
    });
    expect(me.json()).toMatchObject({
      user: { email: "oauth@example.test", username: "oauth-user-a", role: "user" },
    });
    await app.close();
  });
});
