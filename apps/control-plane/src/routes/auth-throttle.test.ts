import * as auth from "@agent-runtime/auth";
import type * as AuthModule from "@agent-runtime/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildControlPlane } from "../app.js";
import { AddressSet } from "../login-guard.js";
import {
  ADMIN_ID,
  beginOidcLogin,
  configureTestOidc,
  createTestDependencies,
  login,
  NOW,
  ORIGIN,
  USER_A_ID,
  type TestControlPlaneDependencies,
} from "./test-fixtures.js";

vi.mock("@agent-runtime/auth", async (importOriginal) => {
  const original = await importOriginal<typeof AuthModule>();
  return { ...original, verifyPassword: vi.fn(original.verifyPassword) };
});

const ATTACKER = "198.51.100.7";
const OTHER_CLIENT = "198.51.100.8";

type App = ReturnType<typeof buildControlPlane>;

function attempt(app: App, login: string, password: string, remoteAddress = ATTACKER, headers = {}) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress,
    headers: { origin: ORIGIN, ...headers },
    payload: { login, password },
  });
}

async function failTimes(app: App, count: number, login: string, remoteAddress = ATTACKER) {
  for (let index = 0; index < count; index += 1) {
    const response = await attempt(app, login, "wrong-password", remoteAddress);
    expect(response.statusCode).toBe(401);
  }
}

function lockEvents(dependencies: TestControlPlaneDependencies) {
  return dependencies.store
    .listAuditEvents({ userId: ADMIN_ID, includeAllUsers: true, limit: 1_000, beforeId: null })
    .then((events) => events.filter((event) => event.eventType === "auth.login_locked"));
}

afterEach(() => {
  vi.mocked(auth.verifyPassword).mockClear();
});

describe("local login throttling", () => {
  it("locks an account for one address after five failures without checking the password", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
    await failTimes(app, 5, "user-a");

    vi.mocked(auth.verifyPassword).mockClear();
    const locked = await attempt(app, "user-a", "password-for-user-a");
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBe("900");
    expect(locked.json()).toMatchObject({ error: { code: "AUTH_RATE_LIMITED" } });
    expect(locked.headers["set-cookie"]).toBeUndefined();
    expect(auth.verifyPassword).not.toHaveBeenCalled();

    // The same account from another address is unaffected.
    const elsewhere = await attempt(app, "a@example.test", "password-for-user-a", OTHER_CLIENT);
    expect(elsewhere.statusCode).toBe(200);
    await app.close();
  });

  it("counts email and username of one User as one account", async () => {
    const app = buildControlPlane(await createTestDependencies());
    await failTimes(app, 3, "user-a");
    await failTimes(app, 2, "A@Example.test");
    expect((await attempt(app, "user-a", "password-for-user-a")).statusCode).toBe(429);
    await app.close();
  });

  it("treats unknown logins exactly like existing ones", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const existing: Array<[number, string]> = [];
    const unknown: Array<[number, string]> = [];
    for (let index = 0; index < 6; index += 1) {
      const a = await attempt(app, "user-a", "wrong-password", "198.51.100.10");
      const b = await attempt(app, "nobody@example.test", "wrong-password", "198.51.100.11");
      existing.push([a.statusCode, a.body]);
      unknown.push([b.statusCode, b.body]);
    }
    expect(unknown).toEqual(existing);
    expect(existing.at(-1)?.[0]).toBe(429);
    await app.close();
  });

  it("locks an address that guesses across many accounts", async () => {
    const app = buildControlPlane(await createTestDependencies());
    for (let index = 0; index < 20; index += 1) {
      expect((await attempt(app, `guess-${index}@example.test`, "wrong")).statusCode).toBe(401);
    }
    expect((await attempt(app, "user-b", "password-for-user-b")).statusCode).toBe(429);
    expect((await attempt(app, "user-b", "password-for-user-b", OTHER_CLIENT)).statusCode).toBe(200);
    await app.close();
  });

  it("locks an account under a distributed attack except from trusted networks", async () => {
    const app = buildControlPlane(await createTestDependencies());
    for (let index = 0; index < 50; index += 1) {
      const response = await attempt(app, "admin", "wrong", `203.0.113.${index + 1}`);
      expect(response.statusCode).toBe(401);
    }
    expect((await attempt(app, "admin", "password-for-admin", "203.0.113.200")).statusCode).toBe(
      429,
    );
    // Break-glass: the management network still reaches the password check.
    expect((await attempt(app, "admin", "password-for-admin", "127.0.0.1")).statusCode).toBe(200);
    await app.close();
  });

  it("still applies the account+address lock on trusted networks", async () => {
    const app = buildControlPlane(await createTestDependencies());
    await failTimes(app, 5, "admin", "127.0.0.1");
    expect((await attempt(app, "admin", "password-for-admin", "127.0.0.1")).statusCode).toBe(429);
    await app.close();
  });

  it("forgives only the account+address counter after a successful login", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
    await failTimes(app, 4, "user-a");
    expect((await attempt(app, "user-a", "password-for-user-a")).statusCode).toBe(200);
    await failTimes(app, 4, "user-a");
    expect((await attempt(app, "user-a", "password-for-user-a")).statusCode).toBe(200);

    const rows = [...dependencies.testState.authThrottle.values()];
    expect(rows.find((row) => row.scope === "login")?.failures).toBe(8);
    expect(rows.find((row) => row.scope === "ip")?.failures).toBe(8);
    expect(rows.some((row) => row.scope === "login_ip")).toBe(false);
    await app.close();
  });

  it("records one lock event without the typed login or password", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
    await failTimes(app, 5, "user-a");
    await attempt(app, "user-a", "wrong-password");
    await attempt(app, "user-a", "wrong-password");

    const events = await lockEvents(dependencies);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ownerUserId: USER_A_ID,
      details: { scope: "login_ip", ipAddress: ATTACKER, protocol: "LOCAL" },
    });
    const stored = JSON.stringify([events, [...dependencies.testState.authThrottle.values()]]);
    expect(stored).not.toContain("user-a");
    expect(stored).not.toContain("a@example.test");
    expect(stored).not.toContain("wrong-password");
    await app.close();
  });

  it("unlocks by itself when the lock expires", async () => {
    const dependencies = await createTestDependencies();
    let clock = NOW;
    dependencies.now = () => clock;
    const app = buildControlPlane(dependencies);
    await failTimes(app, 5, "user-a");
    expect((await attempt(app, "user-a", "password-for-user-a")).statusCode).toBe(429);
    clock = new Date(NOW.getTime() + 15 * 60_000 + 1);
    expect((await attempt(app, "user-a", "password-for-user-a")).statusCode).toBe(200);
    await app.close();
  });

  it("counts malformed requests against the address", async () => {
    const app = buildControlPlane(await createTestDependencies());
    for (let index = 0; index < 20; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: ATTACKER,
        headers: { origin: ORIGIN },
        payload: { login: "x" },
      });
      expect(response.statusCode).toBe(400);
    }
    expect((await attempt(app, "user-a", "password-for-user-a")).statusCode).toBe(429);
    await app.close();
  });

  it("fails closed when the throttle store is unavailable", async () => {
    const dependencies = await createTestDependencies();
    dependencies.testState.failAuthThrottle = true;
    const app = buildControlPlane(dependencies);
    const response = await attempt(app, "user-a", "password-for-user-a");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "AUTH_UNAVAILABLE" } });
    expect(response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });
});

describe("client address", () => {
  it("ignores X-Forwarded-For from a peer that is not a trusted proxy", async () => {
    const app = buildControlPlane(await createTestDependencies());
    for (let index = 0; index < 5; index += 1) {
      await attempt(app, "user-a", "wrong", ATTACKER, {
        "x-forwarded-for": `192.0.2.${index + 1}`,
      });
    }
    const response = await attempt(app, "user-a", "password-for-user-a", ATTACKER, {
      "x-forwarded-for": "192.0.2.99",
    });
    expect(response.statusCode).toBe(429);
    await app.close();
  });

  it("uses the right-most untrusted hop behind a trusted proxy", async () => {
    const dependencies = await createTestDependencies();
    dependencies.trustedProxies = new AddressSet(["10.0.0.0/8"]);
    const app = buildControlPlane(dependencies);
    const viaProxy = (forwardedFor: string, password: string) =>
      attempt(app, "user-a", password, "10.0.0.2", { "x-forwarded-for": forwardedFor });
    for (let index = 0; index < 5; index += 1) {
      // A client-supplied left-most entry does not change who is counted.
      expect((await viaProxy(`192.0.2.${index}, ${ATTACKER}, 10.0.0.3`, "wrong")).statusCode).toBe(
        401,
      );
    }
    expect((await viaProxy(ATTACKER, "password-for-user-a")).statusCode).toBe(429);
    expect((await viaProxy(OTHER_CLIENT, "password-for-user-a")).statusCode).toBe(200);
    await app.close();
  });
});

describe("SSO throttling", () => {
  it("limits how often one address can start SSO", async () => {
    const dependencies = await createTestDependencies();
    configureTestOidc(dependencies);
    const app = buildControlPlane(dependencies);
    for (let index = 0; index < 30; index += 1) {
      const response = await app.inject({ method: "GET", url: "/auth/oidc/login", remoteAddress: ATTACKER });
      expect(response.statusCode).toBe(302);
    }
    const limited = await app.inject({ method: "GET", url: "/auth/oidc/login", remoteAddress: ATTACKER });
    expect(limited.statusCode).toBe(429);
    const other = await app.inject({ method: "GET", url: "/auth/oidc/login", remoteAddress: OTHER_CLIENT });
    expect(other.statusCode).toBe(302);
    await app.close();
  });

  it("turns away callbacks from a locked address before consuming the transaction", async () => {
    const dependencies = await createTestDependencies();
    configureTestOidc(dependencies);
    const app = buildControlPlane(dependencies);
    for (let index = 0; index < 20; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/auth/oidc/callback?code=x&state=y",
        remoteAddress: ATTACKER,
      });
      expect(response.statusCode).toBe(400);
    }
    const transactionCookie = await beginOidcLogin(app);
    const oidc = dependencies.oidc;
    if (oidc === undefined) throw new Error("OIDC is not configured");
    const consume = vi.spyOn(oidc.transactions, "consume");
    const locked = await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=code-a&state=expected-state",
      remoteAddress: ATTACKER,
      headers: { cookie: transactionCookie },
    });
    expect(locked.statusCode).toBe(429);
    expect(consume).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("admin login locks", () => {
  async function lockedApp() {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
    await failTimes(app, 5, "user-a");
    return { dependencies, app };
  }

  it("lists and clears locks for administrators only", async () => {
    const { dependencies, app } = await lockedApp();
    expect((await app.inject({ method: "GET", url: "/api/admin/auth/locks" })).statusCode).toBe(401);
    const user = await login(app, "user-b", "password-for-user-b");
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/auth/locks",
      headers: { cookie: user.cookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const admin = await login(app, "admin", "password-for-admin");
    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/auth/locks",
      headers: { cookie: admin.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const locks = listed.json<{ locks: Array<{ id: string; scope: string }> }>().locks;
    expect(locks).toEqual([
      expect.objectContaining({
        scope: "login_ip",
        ipAddress: ATTACKER,
        user: { id: USER_A_ID, email: "a@example.test" },
        failures: 5,
      }),
    ]);
    expect(JSON.stringify(listed.json())).not.toMatch(/keyHash|key_hash/);

    const id = locks[0]?.id ?? "";
    const noCsrf = await app.inject({
      method: "DELETE",
      url: `/api/admin/auth/locks/${id}`,
      headers: { cookie: admin.cookie, origin: ORIGIN },
    });
    expect(noCsrf.statusCode).toBe(403);
    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/admin/auth/locks/${id}`,
      headers: { cookie: admin.cookie, origin: ORIGIN, "x-csrf-token": admin.csrfToken },
    });
    expect(cleared.statusCode).toBe(204);
    const again = await app.inject({
      method: "DELETE",
      url: `/api/admin/auth/locks/${id}`,
      headers: { cookie: admin.cookie, origin: ORIGIN, "x-csrf-token": admin.csrfToken },
    });
    expect(again.statusCode).toBe(404);

    const events = await dependencies.store.listAuditEvents({
      userId: ADMIN_ID,
      includeAllUsers: true,
      limit: 100,
      beforeId: null,
    });
    expect(events.find((event) => event.eventType === "auth.lock_cleared")).toMatchObject({
      actorUserId: ADMIN_ID,
      ownerUserId: USER_A_ID,
      details: { scope: "login_ip", source: "admin" },
    });
    expect((await attempt(app, "user-a", "password-for-user-a")).statusCode).toBe(200);
    await app.close();
  });

  it("clears a User's locks when an administrator resets the password", async () => {
    const { app } = await lockedApp();
    const admin = await login(app, "admin", "password-for-admin");
    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/reset-password`,
      headers: { cookie: admin.cookie, origin: ORIGIN, "x-csrf-token": admin.csrfToken },
      payload: { password: "a-brand-new-password" },
    });
    expect(reset.statusCode).toBe(204);
    expect((await attempt(app, "user-a", "a-brand-new-password")).statusCode).toBe(200);
    await app.close();
  });
});
