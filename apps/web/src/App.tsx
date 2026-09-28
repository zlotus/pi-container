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
      <p className="eyebrow">ACCESS DENIED</p>
      <h1>无权访问 Admin 页面</h1>
      <p>当前账户没有管理员权限。服务端仍会对所有 Admin API 请求执行授权校验。</p>
      <button onClick={() => onNavigate("/")}>返回 Workspaces</button>
    </section>
  );
}

function NotFoundPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <section className="status-page">
      <p className="eyebrow">NOT FOUND</p>
      <h1>页面不存在</h1>
      <p>该 Portal 路径不存在。</p>
      <button onClick={() => onNavigate("/")}>返回 Workspaces</button>
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
    case "admin-workers":
      return <AdminWorkersPage />;
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
          <p className="eyebrow">CONTAINERIZED AGENT RUNTIME</p>
          <h1>一台属于智能体的隔离工作机。</h1>
          <p>登录后创建持久 Workspace。对话、终端和文件能力由 Workspace 内的 pi-web 提供。</p>
        </section>
        <form className="login-card" onSubmit={login}>
          <div>
            <span className="mark">π</span>
            <h2>登录平台</h2>
            <p>使用本地企业账户继续</p>
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
              <a className="sso-link" href="/auth/oidc/login">Sign in with SSO</a>
            </>
          ) : null}
          {authMethods.oauth2.enabled ? (
            <a className="sso-link" href="/auth/oauth2/login">Sign in with Enterprise OAuth2</a>
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
