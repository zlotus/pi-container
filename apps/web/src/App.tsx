import { type FormEvent, useEffect, useState } from "react";

import { api, ApiError } from "./api.js";
import { AppShell } from "./components/AppShell.js";
import { AuditEventRow } from "./components/AuditEventRow.js";
import { AdminAuditPage } from "./pages/AdminAuditPage.js";
import {
  adminUserUpdateConfirmation,
  adminUsersErrorMessage,
  AdminUsersPage,
  runConfirmedAdminUserUpdate,
} from "./pages/AdminUsersPage.js";
import { AdminWorkersPage } from "./pages/AdminWorkersPage.js";
import { AdminWorkspacesPage } from "./pages/AdminWorkspacesPage.js";
import { UserActivityPage } from "./pages/UserActivityPage.js";
import { WorkspacesPage } from "./pages/WorkspacesPage.js";
import { canAccessRoute, type PortalRoute, usePortalRouter } from "./router.js";
import type { AuthMethodsResponse, SessionResponse } from "./types.js";

export {
  adminUserUpdateConfirmation,
  adminUsersErrorMessage,
  AuditEventRow,
  ApiError,
  runConfirmedAdminUserUpdate,
};

function AccessDeniedPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <section className="status-page">
      <p className="eyebrow">403</p>
      <h1>无权访问 Admin 页面</h1>
      <p>当前账户没有管理员权限。服务端仍会对所有 Admin API 请求执行授权校验。</p>
      <button onClick={() => onNavigate("/")}>返回 Workspace 列表</button>
    </section>
  );
}

function NotFoundPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <section className="status-page">
      <p className="eyebrow">404</p>
      <h1>页面不存在</h1>
      <p>该 Portal 路径不存在。</p>
      <button onClick={() => onNavigate("/")}>返回 Workspace 列表</button>
    </section>
  );
}

export function PortalRouteContent({
  route,
  session,
  oidcProviderId,
  oauth2ProviderId,
  onNavigate,
  onSessionChanged,
  onSessionEnded,
}: {
  route: PortalRoute;
  session: SessionResponse;
  oidcProviderId: string | null;
  oauth2ProviderId: string | null;
  onNavigate: (path: string) => void;
  onSessionChanged: (session: SessionResponse) => void;
  onSessionEnded: () => void;
}) {
  if (!canAccessRoute(route, session.user.role)) {
    return <AccessDeniedPage onNavigate={onNavigate} />;
  }

  switch (route) {
    case "workspaces":
      return <WorkspacesPage session={session} />;
    case "activity":
      return <UserActivityPage />;
    case "admin-users":
      return (
        <AdminUsersPage
          session={session}
          oidcProviderId={oidcProviderId}
          oauth2ProviderId={oauth2ProviderId}
          onSessionChanged={onSessionChanged}
          onSessionEnded={onSessionEnded}
        />
      );
    case "admin-workspaces":
      return <AdminWorkspacesPage />;
    case "admin-workers":
      return <AdminWorkersPage session={session} />;
    case "admin-audit":
      return <AdminAuditPage />;
    case "not-found":
      return <NotFoundPage onNavigate={onNavigate} />;
  }
}

export function App() {
  const { route, navigate } = usePortalRouter();
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [authMethods, setAuthMethods] = useState<AuthMethodsResponse>({
    oidc: { enabled: false, providerId: null },
    oauth2: { enabled: false, providerId: null },
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setAuthMethods(await api<AuthMethodsResponse>("/api/auth/methods"));
      } catch {
        // Local login remains available if auth-method discovery fails.
      }
      try {
        setSession(await api<SessionResponse>("/api/me"));
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.status !== 401) {
          setError(caught instanceof Error ? caught.message : "Unable to load portal");
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      setSession(await api<SessionResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          login: form.get("login"),
          password: form.get("password"),
        }),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed");
    }
  }

  async function logout() {
    if (session === null) return;
    await api("/api/auth/logout", {
      method: "POST",
      headers: { "x-csrf-token": session.csrfToken },
      body: "{}",
    });
    setSession(null);
  }

  if (loading) {
    return <main className="center-card">正在载入…</main>;
  }

  if (session === null) {
    return (
      <main className="login-shell">
        <section className="login-copy">
          <p className="eyebrow">AGENT WORKSPACE</p>
          <h1>智能体工作平台</h1>
          <p>登录后创建 Workspace，使用对话、终端和文件等工作能力。</p>
        </section>
        <form className="login-card" onSubmit={login}>
          <div>
            <span className="mark">π</span>
            <h2>登录平台</h2>
            <p>使用平台账户继续</p>
          </div>
          <label>
            邮箱或用户名
            <input name="login" autoComplete="username" required />
          </label>
          <label>
            密码
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error === null ? null : <p className="error">{error}</p>}
          <button type="submit">登录</button>
          {authMethods.oidc.enabled ? (
            <>
              <div className="login-divider"><span>或</span></div>
              <a className="sso-link" href="/auth/oidc/login">使用企业 SSO 登录</a>
            </>
          ) : null}
          {authMethods.oauth2.enabled ? (
            <a className="sso-link" href="/auth/oauth2/login">使用企业 OAuth2 登录</a>
          ) : null}
        </form>
      </main>
    );
  }

  return (
    <AppShell
      route={route}
      user={session.user}
      onNavigate={navigate}
      onLogout={() => void logout()}
    >
      <PortalRouteContent
        route={route}
        session={session}
        oidcProviderId={authMethods.oidc.providerId}
        oauth2ProviderId={authMethods.oauth2.providerId}
        onNavigate={navigate}
        onSessionChanged={setSession}
        onSessionEnded={() => setSession(null)}
      />
    </AppShell>
  );
}
