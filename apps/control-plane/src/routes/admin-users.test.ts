import { describe, expect, it, vi } from "vitest";

import { buildControlPlane } from "../app.js";
import { SessionConnectionRegistry } from "../session-connections.js";
import {
  ADMIN_ID,
  createTestDependencies,
  login,
  ORIGIN,
  USER_A_ID,
  USER_B_ID,
} from "./test-fixtures.js";

describe("Phase 9 Admin Users", () => {
  it("rejects every Admin Users route for a non-admin", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const user = await login(app, "user-a", "password-for-user-a");
    const headers = {
      cookie: user.cookie,
      origin: ORIGIN,
      "x-csrf-token": user.csrfToken,
    };
    const requests = [
      app.inject({ method: "GET", url: "/api/admin/users", headers }),
      app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers,
        payload: {
          email: "blocked@example.test",
          password: "blocked-password",
        },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/admin/users/${USER_B_ID}`,
        headers,
        payload: { role: "admin" },
      }),
      app.inject({
        method: "POST",
        url: `/api/admin/users/${USER_B_ID}/reset-password`,
        headers,
        payload: { password: "replacement-password" },
      }),
      app.inject({
        method: "POST",
        url: `/api/admin/users/${USER_B_ID}/revoke-sessions`,
        headers,
        payload: {},
      }),
      app.inject({
        method: "GET",
        url: `/api/admin/users/${USER_B_ID}/workspaces`,
        headers,
      }),
    ];

    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.statusCode)).toEqual([
      403, 403, 403, 403, 403, 403,
    ]);
    await app.close();
  });

  it("creates only ordinary Local Users and exposes read-only Workspace metadata", async () => {
    const dependencies = await createTestDependencies();
    const app = buildControlPlane(dependencies);
    const admin = await login(app, "admin", "password-for-admin");
    const adminHeaders = {
      cookie: admin.cookie,
      origin: ORIGIN,
      "x-csrf-token": admin.csrfToken,
    };
    const forgedAdmin = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: adminHeaders,
      payload: {
        email: "forged-admin@example.test",
        username: "forged-admin",
        password: "phase-nine-password",
        role: "admin",
      },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: adminHeaders,
      payload: {
        email: "phase9@example.test",
        username: "user-phase9",
        password: "phase-nine-password",
      },
    });
    const createdUserId = created.json<{ user: { id: string } }>().user.id;
    const newUser = await login(app, "user-phase9", "phase-nine-password");
    const workspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: newUser.cookie,
        origin: ORIGIN,
        "x-csrf-token": newUser.csrfToken,
      },
      payload: { name: "phase9-owned" },
    });
    const metadata = await app.inject({
      method: "GET",
      url: `/api/admin/users/${createdUserId}/workspaces`,
      headers: { cookie: admin.cookie },
    });
    const adminOwnWorkspaces = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: admin.cookie },
    });
    const ownershipRewrite = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${createdUserId}`,
      headers: adminHeaders,
      payload: { workspaceOwnerId: ADMIN_ID },
    });

    expect(forgedAdmin.statusCode).toBe(400);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      user: { role: "user", status: "active", email: "phase9@example.test" },
    });
    expect(workspace.statusCode).toBe(201);
    expect(metadata.json()).toMatchObject({
      workspaces: [{ name: "phase9-owned" }],
    });
    expect(adminOwnWorkspaces.json()).toEqual({ workspaces: [] });
    expect(ownershipRewrite.statusCode).toBe(400);
    expect(
      dependencies.testState.workspaces.find(
        (candidate) => candidate.name === "phase9-owned",
      )?.userId,
    ).toBe(createdUserId);
    await app.close();
  });

  it("fails closed after disable or revoke and applies role and password changes", async () => {
    const dependencies = await createTestDependencies();
    const sessionConnections = new SessionConnectionRegistry();
    dependencies.sessionConnections = sessionConnections;
    const disabledConnection = vi.fn();
    sessionConnections.register(
      { userId: USER_A_ID, sessionId: "workspace-disabled" },
      disabledConnection,
    );
    const app = buildControlPlane(dependencies);
    const admin = await login(app, "admin", "password-for-admin");
    const user = await login(app, "user-a", "password-for-user-a");
    const preservedWorkspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: user.cookie,
        origin: ORIGIN,
        "x-csrf-token": user.csrfToken,
      },
      payload: { name: "preserved-after-disable" },
    });
    const adminHeaders = {
      cookie: admin.cookie,
      origin: ORIGIN,
      "x-csrf-token": admin.csrfToken,
    };
    const disable = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${USER_A_ID}`,
      headers: adminHeaders,
      payload: { status: "disabled" },
    });
    const existingDisabledSession = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: user.cookie },
    });
    const disabledLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "password-for-user-a" },
    });
    const enable = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${USER_A_ID}`,
      headers: adminHeaders,
      payload: { status: "active" },
    });
    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/reset-password`,
      headers: adminHeaders,
      payload: { password: "replacement-password" },
    });
    const oldPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "password-for-user-a" },
    });
    const replacementSession = await login(app, "user-a", "replacement-password");
    const preservedAfterEnable = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: replacementSession.cookie },
    });
    const promote = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${USER_A_ID}`,
      headers: adminHeaders,
      payload: { role: "admin" },
    });
    const promotedAccess = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: replacementSession.cookie },
    });
    const demote = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${USER_A_ID}`,
      headers: adminHeaders,
      payload: { role: "user" },
    });
    const demotedAccess = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: replacementSession.cookie },
    });
    const revoke = await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/revoke-sessions`,
      headers: adminHeaders,
      payload: {},
    });
    const revokedSession = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: replacementSession.cookie },
    });

    expect(disable.statusCode).toBe(200);
    expect(preservedWorkspace.statusCode).toBe(201);
    expect(existingDisabledSession.statusCode).toBe(401);
    expect(disabledLogin.statusCode).toBe(401);
    expect(disabledConnection).toHaveBeenCalledOnce();
    expect(enable.statusCode).toBe(200);
    expect(reset.statusCode).toBe(204);
    expect(oldPassword.statusCode).toBe(401);
    expect(preservedAfterEnable.json()).toMatchObject({
      workspaces: [{ name: "preserved-after-disable" }],
    });
    expect(promote.statusCode).toBe(200);
    expect(promotedAccess.statusCode).toBe(200);
    expect(demote.statusCode).toBe(200);
    expect(demotedAccess.statusCode).toBe(403);
    const revokedConnection = vi.fn();
    sessionConnections.register(
      { userId: USER_A_ID, sessionId: "workspace-revoked" },
      revokedConnection,
    );
    await app.inject({
      method: "POST",
      url: `/api/admin/users/${USER_A_ID}/revoke-sessions`,
      headers: adminHeaders,
      payload: {},
    });
    expect(revoke.statusCode).toBe(204);
    expect(revokedSession.statusCode).toBe(401);
    expect(revokedConnection).toHaveBeenCalledOnce();
    await app.close();
  });

  it("refuses to disable or demote the last active Local Admin", async () => {
    const app = buildControlPlane(await createTestDependencies());
    const admin = await login(app, "admin", "password-for-admin");
    const headers = {
      cookie: admin.cookie,
      origin: ORIGIN,
      "x-csrf-token": admin.csrfToken,
    };
    const disable = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${ADMIN_ID}`,
      headers,
      payload: { status: "disabled" },
    });
    const demote = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${ADMIN_ID}`,
      headers,
      payload: { role: "user" },
    });

    expect(disable.statusCode).toBe(409);
    expect(disable.json()).toMatchObject({
      error: { code: "LAST_ACTIVE_LOCAL_ADMIN" },
    });
    expect(demote.statusCode).toBe(409);
    await app.close();
  });
});
