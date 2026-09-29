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
import { formatAbsoluteTime } from "./labels.js";
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
      "禁用用户“user-phase9”？",
    );
    expect(adminUserUpdateConfirmation(user, { status: "active" })).toBe(
      "启用用户“user-phase9”？",
    );
    expect(adminUserUpdateConfirmation(user, { role: "admin" })).toBe(
      "将“user-phase9”的角色从普通用户改为管理员？",
    );
    expect(
      adminUserUpdateConfirmation(
        { ...user, username: null, role: "admin" },
        { role: "user" },
      ),
    ).toBe("将“user@example.test”的角色从管理员改为普通用户？");
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
    ).toBe("必须至少保留一个可用的本地管理员（LAST_ACTIVE_LOCAL_ADMIN）");
    expect(
      adminUsersErrorMessage(
        new ApiError("Email or username already exists", 409, "USER_ALREADY_EXISTS"),
        "fallback",
      ),
    ).toBe("邮箱或用户名已存在（USER_ALREADY_EXISTS）");
    expect(
      adminUsersErrorMessage(new ApiError("Server rejected request", 500), "fallback"),
    ).toBe("Server rejected request");
    // An unknown code keeps the server message instead of guessing a translation.
    expect(
      adminUsersErrorMessage(new ApiError("Brand new failure", 409, "BRAND_NEW_CODE"), "fallback"),
    ).toBe("Brand new failure（BRAND_NEW_CODE）");
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
    expect(renderAudit()).toContain("<p>user-a · 本地账户</p>");
    expect(renderAudit()).toContain("<strong>登录成功</strong>");
    expect(renderAudit({ eventType: "auth.logout" })).toContain(
      "<strong>已退出登录</strong>",
    );
    expect(renderAudit({ eventType: "auth.logout" })).toContain(
      "<p>user-a · 本地账户</p>",
    );
  });

  it("distinguishes the target user from the actor on management events", () => {
    const markup = renderAudit({
      eventType: "user.disabled",
      actorUserId: adminId,
      details: { fromStatus: "active", toStatus: "disabled" },
    });
    expect(markup).toContain("<strong>用户已禁用</strong>");
    expect(markup).toContain("<p>user-a · 操作者 admin · 正常 → 已禁用</p>");
  });

  it("keeps unresolved users visible with an eight-character UUID fallback", () => {
    expect(renderAudit({}, {
      users: [{ id: userId, username: null, email: "user-a@example.test" }],
    })).toContain("<p>user-a@example.test · 本地账户</p>");

    const markup = renderAudit({
      eventType: "auth.session_revoked",
      actorUserId: adminId,
    }, { users: [] });
    expect(markup).toContain("<strong>登录会话已撤销</strong>");
    expect(markup).toContain("<p>11111111 · 操作者 22222222 · 本地账户</p>");
  });

  it("preserves workspace and worker subjects and hides admin names for regular users", () => {
    const workspaceId = "33333333-3333-4333-8333-333333333333";
    const workspace = renderAudit({
      eventType: "workspace.stopped",
      workspaceId,
      workerId: "worker-a",
      details: { fromState: "RUNNING", toState: "STOPPED" },
    }, { workspaces: [{ id: workspaceId, name: "build" }] });
    // Admins see whose Workspace it is; regular users (Activity) see only the name.
    expect(workspace).toContain("<p>build（user-a） · worker-a · 运行中 → 已停止</p>");

    const worker = renderAudit({
      eventType: "worker.online",
      actorUserId: adminId,
      ownerUserId: null,
      workerId: "worker-a",
      details: {},
    });
    expect(worker).toContain("<p>平台 · worker-a</p>");

    const paused = renderAudit({
      eventType: "worker.scheduling_paused",
      actorUserId: adminId,
      ownerUserId: null,
      workerId: "worker-a",
      details: { requestId: "req-1", ipAddress: "127.0.0.1", userAgent: null },
    });
    expect(paused).toContain("<strong>Worker 已暂停调度</strong>");
    expect(paused).toContain("<p>操作者 admin · worker-a</p>");
    expect(paused).toContain("audit-warning");

    const ordinaryUser = renderAudit({}, { isAdmin: false });
    expect(ordinaryUser).toContain("<p>平台 · 本地账户</p>");
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
    expect(markup).toContain("Workspace");
    expect(markup).toContain('href="/activity"');
    expect(markup).toContain("活动");
    expect(markup).not.toContain('href="/admin/');
    expect(markup).not.toContain("用户");
    expect(markup).not.toContain("审计");
  });

  it("shows every workspace and admin destination to an admin", () => {
    const markup = renderNavigation(adminSession);
    expect(markup).toContain("Workspace");
    expect(markup).toContain('href="/admin/users"');
    expect(markup).toContain('href="/admin/workspaces"');
    expect(markup).toContain('href="/admin/workers"');
    expect(markup).toContain('href="/admin/audit"');
    expect(markup).not.toContain('href="/activity"');
  });

  it("renders the Activity page for a regular user", () => {
    const markup = renderRoute("/activity", userSession);
    expect(markup).toContain("<h1>活动</h1>");
    expect(markup).toContain("你的 Workspace 的状态变化和操作记录，按时间倒序。");
  });

  it("maps deep links to their dedicated admin pages", () => {
    expect(renderRoute("/admin/users")).toContain("<h1>用户</h1>");
    expect(renderRoute("/admin/workspaces")).toContain("<h1>全部 Workspace</h1>");
    expect(renderRoute("/admin/workers")).toContain("<h1>Worker</h1>");
    expect(renderRoute("/admin/audit")).toContain("<h1>审计</h1>");
  });

  it("denies direct all-Workspace access to a regular user", () => {
    const markup = renderRoute("/admin/workspaces", userSession);
    expect(markup).toContain("无权访问 Admin 页面");
    expect(markup).not.toContain("全部 Workspace</h1>");
  });

  it("denies direct Admin Audit access to a regular user", () => {
    const markup = renderRoute("/admin/audit", userSession);
    expect(markup).toContain("无权访问 Admin 页面");
    expect(markup).not.toContain("audit-panel");
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
    expect(markup).toContain("<p>build · worker-a · 启动中 → 运行中</p>");
    // Log rows show a precise absolute timestamp, with the relative age only as a hover hint.
    expect(markup).toContain(`>${formatAbsoluteTime("2026-09-28T08:00:00.000Z")}</time>`);
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
