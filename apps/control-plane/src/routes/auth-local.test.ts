import { describe, expect, it } from "vitest";

import { buildControlPlane } from "../app.js";
import {
  createTestDependencies,
  firstCookie,
  login,
  ORIGIN,
  USER_A_ID,
} from "./test-fixtures.js";

describe("local authentication", () => {
  it("accepts email or username and sets an HTTP-only host cookie", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "password-for-user-a" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("platform-session=");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(response.json()).toMatchObject({
      user: { id: USER_A_ID, email: "a@example.test" },
    });
    await app.close();
  });

  it("accepts the canonical Portal Origin and multiple exact-match allowed origins", async () => {
    const dependencies = await createTestDependencies();
    dependencies.portalAllowedOrigins = [
      "http://192.168.1.124:5173",
      "http://100.64.0.10:5173",
    ];
    const app = buildControlPlane(dependencies);

    for (const origin of [
      ORIGIN,
      "http://192.168.1.124:5173",
      "http://100.64.0.10:5173",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { login: "user-a", password: "password-for-user-a" },
      });
      expect(response.statusCode).toBe(200);
    }
    const differentPort = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "http://192.168.1.124:5174" },
      payload: { login: "user-a", password: "password-for-user-a" },
    });
    expect(differentPort.statusCode).toBe(403);
    await app.close();
  });

  it("uses the __Host- cookie contract when Secure cookies are enabled", async () => {
    const dependencies = await createTestDependencies();
    dependencies.secureCookies = true;
    const app = buildControlPlane(dependencies);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "password-for-user-a" },
    });

    expect(response.headers["set-cookie"]).toContain(
      "__Host-platform-session=",
    );
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(response.headers["set-cookie"]).not.toContain("Domain=");
    await app.close();
  });

  it("replaces an attacker-supplied cookie with a fresh authenticated session", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const fixedCookie = "platform-session=attacker-fixed-session";
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN, cookie: fixedCookie },
      payload: { login: "user-a", password: "password-for-user-a" },
    });
    const issuedCookie = firstCookie(response, "platform-session");
    const fixedSession = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: fixedCookie },
    });
    const issuedSession = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: issuedCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(issuedCookie).not.toBe(fixedCookie);
    expect(fixedSession.statusCode).toBe(401);
    expect(issuedSession.statusCode).toBe(200);
    await app.close();
  });

  it("revokes the server-side session on logout", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const session = await login(app, "user-a", "password-for-user-a");
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: session.cookie,
        origin: ORIGIN,
        "x-csrf-token": session.csrfToken,
      },
      payload: {},
    });
    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: session.cookie },
    });

    expect(logout.statusCode).toBe(204);
    expect(afterLogout.statusCode).toBe(401);
    await app.close();
  });

  it("rejects invalid credentials, untrusted origins, and a missing Origin", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const invalidPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "wrong" },
    });
    const invalidOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://attacker.test" },
      payload: { login: "user-a", password: "password-for-user-a" },
    });
    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { login: "user-a", password: "password-for-user-a" },
    });

    expect(invalidPassword.statusCode).toBe(401);
    expect(invalidOrigin.statusCode).toBe(403);
    expect(missingOrigin.statusCode).toBe(403);
    await app.close();
  });
});
