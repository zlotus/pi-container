import type { WorkspaceRecord } from "@agent-runtime/database";
import { describe, expect, it } from "vitest";

import { buildControlPlane } from "../app.js";
import {
  createTestDependencies,
  login,
  ORIGIN,
  USER_A_ID,
  USER_B_ID,
} from "./test-fixtures.js";

describe("workspace ownership", () => {
  it("narrows audit queries by filters without widening a regular user's scope", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const userA = await login(app, "user-a", "password-for-user-a");
    const admin = await login(app, "admin", "password-for-admin");
    await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: userA.cookie, origin: ORIGIN, "x-csrf-token": userA.csrfToken },
      payload: { name: "audited" },
    });
    const query = async (session: { cookie: string }, search: string) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/audit-events?${search}`,
        headers: { cookie: session.cookie },
      });
      return {
        status: response.statusCode,
        events: response.statusCode === 200
          ? response.json<{ events: Array<{ eventType: string; actorUserId: string | null; ownerUserId: string | null }> }>().events
          : [],
      };
    };

    const auth = await query(admin, "category=auth");
    expect(auth.events.length).toBeGreaterThan(0);
    expect(auth.events.every((event) => event.eventType.startsWith("auth."))).toBe(true);
    const byUser = await query(admin, `userId=${USER_A_ID}`);
    expect(byUser.events.length).toBeGreaterThan(0);
    expect(byUser.events.every((event) =>
      event.actorUserId === USER_A_ID || event.ownerUserId === USER_A_ID)).toBe(true);
    expect((await query(admin, "from=2099-01-01T00:00:00Z")).events).toEqual([]);

    // A regular user asking for auth events or another user's events still sees only own workspace.* events.
    expect((await query(userA, "category=auth")).events).toEqual([]);
    const otherUser = await query(userA, `userId=${USER_B_ID}`);
    expect(otherUser.events).toEqual([]);

    for (const invalid of ["category=secrets", "userId=not-a-uuid", "from=yesterday", "unknown=1"]) {
      expect((await query(admin, invalid)).status).toBe(400);
    }
    await app.close();
  });

  it("lists every Workspace with its owner only for an admin, as metadata", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const userA = await login(app, "user-a", "password-for-user-a");
    const userB = await login(app, "user-b", "password-for-user-b");
    const admin = await login(app, "admin", "password-for-admin");
    for (const [session, name] of [[userA, "alpha"], [userB, "beta"]] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: { cookie: session.cookie, origin: ORIGIN, "x-csrf-token": session.csrfToken },
        payload: { name },
      });
      expect(created.statusCode).toBe(201);
    }

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/workspaces",
      headers: { cookie: userA.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    const anonymous = await app.inject({ method: "GET", url: "/api/admin/workspaces" });
    expect(anonymous.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/admin/workspaces",
      headers: { cookie: admin.cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["cache-control"]).toBe("no-store");
    const body = allowed.json<{
      workspaces: Array<{ name: string; owner: { id: string; username: string | null } }>;
    }>();
    expect(body.workspaces.map((workspace) => [workspace.name, workspace.owner.username]).sort())
      .toEqual([["alpha", "user-a"], ["beta", "user-b"]]);
    expect(JSON.stringify(body)).not.toContain("runtimeImage");

    // The overview grants no content access: the admin still cannot open another user's Workspace.
    const betaId = (body.workspaces.find((workspace) => workspace.name === "beta") as unknown as { id: string }).id;
    const open = await app.inject({
      method: "POST",
      url: `/api/workspaces/${betaId}/open`,
      headers: { cookie: admin.cookie, origin: ORIGIN, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(open.statusCode).toBe(404);
    await app.close();
  });

  it("keeps User A and User B workspace lists isolated", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const userA = await login(app, "user-a", "password-for-user-a");
    const userB = await login(app, "b@example.test", "password-for-user-b");

    const createA = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userA.cookie,
        origin: ORIGIN,
        "x-csrf-token": userA.csrfToken,
      },
      payload: { name: "workspace-a" },
    });
    const createB = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userB.cookie,
        origin: ORIGIN,
        "x-csrf-token": userB.csrfToken,
      },
      payload: { name: "workspace-b" },
    });

    expect(createA.statusCode).toBe(201);
    expect(createB.statusCode).toBe(201);
    const workspaceA = createA.json<{ workspace: WorkspaceRecord }>().workspace;

    const listA = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: userA.cookie },
    });
    const listB = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: userB.cookie },
    });
    expect(listA.json()).toMatchObject({
      workspaces: [{ name: "workspace-a" }],
    });
    expect(listB.json()).toMatchObject({
      workspaces: [{ name: "workspace-b" }],
    });

    const foreignGet = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceA.id}`,
      headers: { cookie: userB.cookie },
    });
    const foreignDelete = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceA.id}`,
      headers: {
        cookie: userB.cookie,
        origin: ORIGIN,
        "x-csrf-token": userB.csrfToken,
      },
    });
    expect(foreignGet.statusCode).toBe(404);
    expect(foreignDelete.statusCode).toBe(404);

    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceA.id}`,
      headers: {
        cookie: userA.cookie,
        origin: ORIGIN,
        "x-csrf-token": userA.csrfToken,
      },
    });
    expect(ownerDelete.statusCode).toBe(204);
    await app.close();
  });

  it("requires both a trusted Origin and the session-bound CSRF token", async () => {
    const dependencies = await createTestDependencies();
    dependencies.portalAllowedOrigins = ["http://192.168.1.124:5173"];
    const app = buildControlPlane(dependencies);
    const userA = await login(app, "user-a", "password-for-user-a");

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: userA.cookie, origin: "http://192.168.1.124:5173" },
      payload: { name: "blocked" },
    });
    const allowedOrigin = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userA.cookie,
        origin: "http://192.168.1.124:5173",
        "x-csrf-token": userA.csrfToken,
      },
      payload: { name: "allowed" },
    });
    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userA.cookie,
        origin: "https://attacker.test",
        "x-csrf-token": userA.csrfToken,
      },
      payload: { name: "blocked" },
    });
    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userA.cookie,
        "x-csrf-token": userA.csrfToken,
      },
      payload: { name: "blocked" },
    });

    expect(missingCsrf.statusCode).toBe(403);
    expect(allowedOrigin.statusCode).toBe(201);
    expect(wrongOrigin.statusCode).toBe(403);
    expect(missingOrigin.statusCode).toBe(403);
    await app.close();
  });
});
