import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  adminUserUpdateConfirmation,
  adminUsersErrorMessage,
  AuditEventRow,
  ApiError,
  PortalRouteContent,
  runConfirmedAdminUserUpdate,
} from "./App.js";
import { AuditEventList } from "./components/AuditEventList.js";
import { Navigation } from "./components/Navigation.js";
import { beginWorkerPolling } from "./pages/AdminWorkersPage.js";
import { routeFromPathname } from "./router.js";
import type { SessionResponse } from "./types.js";

const user = {
  email: "user@example.test",
  username: "user-phase9",
  role: "user" as const,
};

describe("Admin Users interactions", () => {
  it("describes status and role changes with the preferred user identifier", () => {
    expect(adminUserUpdateConfirmation(user, { status: "disabled" })).toBe(
      'Disable user "user-phase9"?',
    );
    expect(adminUserUpdateConfirmation(user, { status: "active" })).toBe(
      'Enable user "user-phase9"?',
    );
    expect(adminUserUpdateConfirmation(user, { role: "admin" })).toBe(
      'Change "user-phase9" role from user to admin?',
    );
    expect(
      adminUserUpdateConfirmation(
        { ...user, username: null, role: "admin" },
        { role: "user" },
      ),
    ).toBe('Change "user@example.test" role from admin to user?');
  });

  it("sends no managed-user request when confirmation is cancelled", async () => {
    const confirm = vi.fn(() => false);
    const request = vi.fn(async () => undefined);

    await expect(
      runConfirmedAdminUserUpdate(user, { status: "disabled" }, confirm, request),
    ).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps Admin Users API codes visible in the local error message", () => {
    expect(
      adminUsersErrorMessage(
        new ApiError("At least one active Local Admin is required", 409, "LAST_ACTIVE_LOCAL_ADMIN"),
        "fallback",
      ),
    ).toBe(
      "LAST_ACTIVE_LOCAL_ADMIN: At least one active Local Admin is required",
    );
    expect(
      adminUsersErrorMessage(
        new ApiError("Email or username already exists", 409, "USER_ALREADY_EXISTS"),
        "fallback",
      ),
    ).toBe("USER_ALREADY_EXISTS: Email or username already exists");
    expect(
      adminUsersErrorMessage(new ApiError("Server rejected request", 500), "fallback"),
    ).toBe("Server rejected request");
  });
});

describe("Audit event display", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const adminId = "22222222-2222-4222-8222-222222222222";
  const event: Parameters<typeof AuditEventRow>[0]["event"] = {
    id: "1000",
    eventType: "auth.login_succeeded",
    actorUserId: userId,
    ownerUserId: userId,
    workspaceId: null,
    workerId: null,
    details: { protocol: "LOCAL" },
    createdAt: "2026-09-24T08:00:00.000Z",
  };
  const users = [
    { id: userId, username: "user-a", email: "user-a@example.test" },
    { id: adminId, username: "admin", email: "admin@example.test" },
  ];

  function renderAudit(overrides: Partial<typeof event> = {}, options: {
    users?: Parameters<typeof AuditEventRow>[0]["adminUsers"];
    workspaces?: Parameters<typeof AuditEventRow>[0]["workspaces"];
    isAdmin?: boolean;
  } = {}) {
    return renderToStaticMarkup(createElement(AuditEventRow, {
      event: { ...event, ...overrides },
      workspaces: options.workspaces ?? [],
      adminUsers: options.users ?? users,
      isAdmin: options.isAdmin ?? true,
    }));
  }

  it("shows the account name for admin login and logout events", () => {
    expect(renderAudit()).toContain("<p>user-a · LOCAL</p>");
    expect(renderAudit()).toContain("<strong>登录成功</strong>");
    expect(renderAudit({ eventType: "auth.logout" })).toContain(
      "<strong>已退出登录</strong>",
    );
    expect(renderAudit({ eventType: "auth.logout" })).toContain(
      "<p>user-a · LOCAL</p>",
    );
  });

  it("distinguishes the target user from the actor on management events", () => {
    const markup = renderAudit({
      eventType: "user.disabled",
      actorUserId: adminId,
      details: { fromStatus: "active", toStatus: "disabled" },
    });
    expect(markup).toContain("<strong>User 已禁用</strong>");
    expect(markup).toContain("<p>user-a · 操作者 admin · active → disabled</p>");
  });

  it("keeps unresolved users visible with an eight-character UUID fallback", () => {
    expect(renderAudit({}, {
      users: [{ id: userId, username: null, email: "user-a@example.test" }],
    })).toContain("<p>user-a@example.test · LOCAL</p>");

    const markup = renderAudit({
      eventType: "auth.session_revoked",
      actorUserId: adminId,
    }, { users: [] });
    expect(markup).toContain("<strong>登录会话已撤销</strong>");
    expect(markup).toContain("<p>11111111 · 操作者 22222222 · LOCAL</p>");
  });

  it("preserves workspace and worker subjects and hides admin names for regular users", () => {
    const workspaceId = "33333333-3333-4333-8333-333333333333";
    const workspace = renderAudit({
      eventType: "workspace.stopped",
      workspaceId,
      workerId: "worker-a",
      details: { fromState: "RUNNING", toState: "STOPPED" },
    }, { workspaces: [{ id: workspaceId, name: "build" }] });
    expect(workspace).toContain("<p>build · worker-a · RUNNING → STOPPED</p>");

    const worker = renderAudit({
      eventType: "worker.online",
      actorUserId: adminId,
      ownerUserId: null,
      workerId: "worker-a",
      details: {},
    });
    expect(worker).toContain("<p>平台 · worker-a</p>");

    const ordinaryUser = renderAudit({}, { isAdmin: false });
    expect(ordinaryUser).toContain("<p>平台 · LOCAL</p>");
    expect(ordinaryUser).not.toContain("user-a");
  });
});

describe("Portal navigation and routes", () => {
  const adminSession: SessionResponse = {
    csrfToken: "csrf-admin",
    user: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "admin@example.test",
      username: "admin",
      role: "admin",
      status: "active",
    },
  };
  const userSession: SessionResponse = {
    csrfToken: "csrf-user",
    user: {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      email: "user@example.test",
      username: "user",
      role: "user",
      status: "active",
    },
  };

  function renderNavigation(session: SessionResponse) {
    return renderToStaticMarkup(createElement(Navigation, {
      route: "workspaces",
      role: session.user.role,
      onNavigate: vi.fn(),
    }));
  }

  function renderRoute(pathname: string, session = adminSession) {
    return renderToStaticMarkup(createElement(PortalRouteContent, {
      route: routeFromPathname(pathname),
      session,
      oidcProviderId: "enterprise-oidc",
      oauth2ProviderId: "enterprise-oauth2",
      onNavigate: vi.fn(),
      onSessionChanged: vi.fn(),
      onSessionEnded: vi.fn(),
    }));
  }

  it("shows Workspaces and Activity navigation to a regular user", () => {
    const markup = renderNavigation(userSession);
    expect(markup).toContain('href="/"');
    expect(markup).toContain("Workspaces");
    expect(markup).toContain('href="/activity"');
    expect(markup).toContain("Activity");
    expect(markup).not.toContain("Users");
    expect(markup).not.toContain("Workers");
    expect(markup).not.toContain("Audit");
  });

  it("shows every workspace and admin destination to an admin", () => {
    const markup = renderNavigation(adminSession);
    expect(markup).toContain("Workspaces");
    expect(markup).toContain('href="/admin/users"');
    expect(markup).toContain('href="/admin/workers"');
    expect(markup).toContain('href="/admin/audit"');
    expect(markup).not.toContain('href="/activity"');
  });

  it("renders the Activity page for a regular user", () => {
    const markup = renderRoute("/activity", userSession);
    expect(markup).toContain("<h1>Activity</h1>");
    expect(markup).toContain("查看你的 Workspace 最近发生的状态变化和操作记录。");
  });

  it("maps deep links to their dedicated admin pages", () => {
    expect(renderRoute("/admin/users")).toContain("<h1>Users</h1>");
    expect(renderRoute("/admin/workers")).toContain("<h1>Workers</h1>");
    expect(renderRoute("/admin/audit")).toContain("<h1>Audit</h1>");
  });

  it("denies direct Admin Audit access to a regular user", () => {
    const markup = renderRoute("/admin/audit", userSession);
    expect(markup).toContain("无权访问 Admin 页面");
    expect(markup).not.toContain("最近平台事件");
  });
});

describe("Activity event display", () => {
  it("renders a Workspace event without admin identity details", () => {
    const workspaceId = "33333333-3333-4333-8333-333333333333";
    const markup = renderToStaticMarkup(createElement(AuditEventList, {
      events: [{
        id: "2000",
        eventType: "workspace.running",
        actorUserId: "22222222-2222-4222-8222-222222222222",
        ownerUserId: "11111111-1111-4111-8111-111111111111",
        workspaceId,
        workerId: "worker-a",
        details: { fromState: "STARTING", toState: "RUNNING" },
        createdAt: "2026-09-28T08:00:00.000Z",
      }],
      workspaces: [{
        id: workspaceId,
        name: "build",
        workerId: "worker-a",
        state: "RUNNING",
        createdAt: "2026-09-28T07:00:00.000Z",
      }],
      isAdmin: false,
      loading: false,
      loadingMessage: "正在载入活动…",
      emptyMessage: "暂无活动。",
    }));

    expect(markup).toContain("<strong>Workspace 已启动</strong>");
    expect(markup).toContain("<p>build · worker-a · STARTING → RUNNING</p>");
    expect(markup).not.toContain("操作者");
  });
});

describe("Worker polling lifecycle", () => {
  it("cancels the page-owned polling interval during cleanup", () => {
    const refresh = vi.fn();
    let scheduledCallback: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void, delay: number) => {
      scheduledCallback = callback;
      expect(delay).toBe(5_000);
      return 42;
    });
    const cancel = vi.fn();

    const cleanup = beginWorkerPolling(refresh, schedule, cancel);
    scheduledCallback?.();
    expect(refresh).toHaveBeenCalledOnce();

    cleanup();
    expect(cancel).toHaveBeenCalledWith(42);
  });
});
