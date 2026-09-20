import { Fragment, type FormEvent, useCallback, useEffect, useState } from "react";

interface User {
  id: string;
  email: string;
  username: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
}

interface AdminUser extends User {
  source: "local";
  workspaceCount: number;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Workspace {
  id: string;
  name: string;
  workerId: string | null;
  state: string;
  createdAt: string;
}

interface Worker {
  id: string;
  hostname: string | null;
  architecture: "amd64" | "arm64" | null;
  status: "ONLINE" | "OFFLINE" | "DISABLED";
  runtimeImage: string | null;
  runtimeVersion: string | null;
  capabilities: Record<string, boolean>;
  maxWorkspaces: number | null;
  assignedWorkspaces: number;
  allocatedWorkspaces: number;
  systemResources: {
    logicalCpuCount: number | null;
    memoryBytes: number | null;
  };
  lastHeartbeatAt: string | null;
}

interface AuditEvent {
  id: string;
  eventType: string;
  workspaceId: string | null;
  workerId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

interface SessionResponse {
  user: User;
  csrfToken: string;
}

interface AuthMethodsResponse {
  oidc: { enabled: boolean; providerId: string | null };
}

interface WorkspaceOpenResponse {
  exchangeUrl: string;
  code: string;
}

const CAPABILITY_LABELS: Record<string, string> = {
  browser: "Browser",
  office: "Office",
  ffmpeg: "Media",
  python: "Python",
  node: "Node",
  rust: "Rust",
};

const AUDIT_LABELS: Record<string, string> = {
  "workspace.created": "Workspace 已创建",
  "workspace.scheduled": "Scheduler 已分配 Worker",
  "workspace.starting": "Runtime 正在启动",
  "workspace.running": "Runtime 已运行",
  "workspace.opened": "已打开 pi-web",
  "workspace.stopping": "Runtime 正在停止",
  "workspace.stopped": "Runtime 已停止",
  "workspace.deleting": "Workspace 正在删除",
  "workspace.deleted": "Workspace 已永久删除",
  "workspace.error": "Runtime 进入错误状态",
  "workspace.worker_offline": "Worker 已离线",
  "worker.registered": "Worker 已预注册",
  "worker.online": "Worker 已上线",
  "worker.offline": "Worker 已离线",
  "worker.disabled": "Worker 已禁用",
  "worker.runtime_reported": "Runtime 能力已上报",
};

function formatBytes(value: number | null): string {
  if (value === null) return "—";
  return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GiB`;
}

function stateTransition(details: Record<string, unknown>): string | null {
  const from = details.fromState;
  const to = details.toState;
  return typeof from === "string" && typeof to === "string"
    ? `${from} → ${to}`
    : null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

type AdminUserUpdate = { role?: User["role"]; status?: User["status"] };

interface AdminUserUpdateTarget {
  email: string;
  username: string | null;
  role: User["role"];
}

export function adminUserUpdateConfirmation(
  user: AdminUserUpdateTarget,
  update: AdminUserUpdate,
): string {
  const identifier = user.username ?? user.email;
  if (update.status !== undefined) {
    return `${update.status === "active" ? "Enable" : "Disable"} user "${identifier}"?`;
  }
  return `Change "${identifier}" role from ${user.role} to ${update.role}?`;
}

export function confirmAdminUserUpdate(
  user: AdminUserUpdateTarget,
  update: AdminUserUpdate,
  confirm: (message: string) => boolean,
): boolean {
  return confirm(adminUserUpdateConfirmation(user, update));
}

export async function runConfirmedAdminUserUpdate(
  user: AdminUserUpdateTarget,
  update: AdminUserUpdate,
  confirm: (message: string) => boolean,
  request: () => Promise<void>,
): Promise<boolean> {
  if (!confirmAdminUserUpdate(user, update, confirm)) return false;
  await request();
  return true;
}

export function adminUsersErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) {
    return caught.code === undefined
      ? caught.message
      : `${caught.code}: ${caught.message}`;
  }
  return caught instanceof Error ? caught.message : fallback;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      body?.error?.message ?? "Request failed",
      response.status,
      body?.error?.code,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [oidcProviderId, setOidcProviderId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [managedWorkspaces, setManagedWorkspaces] = useState<Workspace[]>([]);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adminUsersError, setAdminUsersError] = useState<string | null>(null);
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  const loadWorkspaces = useCallback(async () => {
    const result = await api<{ workspaces: Workspace[] }>("/api/workspaces");
    setWorkspaces(result.workspaces);
  }, []);

  const loadWorkers = useCallback(async () => {
    const result = await api<{ workers: Worker[] }>("/api/admin/workers");
    setWorkers(result.workers);
  }, []);

  const loadAuditEvents = useCallback(async () => {
    const result = await api<{ events: AuditEvent[] }>("/api/audit-events?limit=30");
    setAuditEvents(result.events);
  }, []);

  const loadAdminUsers = useCallback(async () => {
    const result = await api<{ users: AdminUser[] }>("/api/admin/users");
    setAdminUsers(result.users);
  }, []);

  const refreshWorkers = useCallback(async () => {
    try {
      await loadWorkers();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load Workers");
    }
  }, [loadWorkers]);

  const refreshAdminUsers = useCallback(async () => {
    setAdminUsersError(null);
    try {
      await loadAdminUsers();
    } catch (caught) {
      setAdminUsersError(adminUsersErrorMessage(caught, "Unable to load Users"));
    }
  }, [loadAdminUsers]);

  useEffect(() => {
    void (async () => {
      try {
        const methods = await api<AuthMethodsResponse>("/api/auth/methods");
        setOidcEnabled(methods.oidc.enabled);
        setOidcProviderId(methods.oidc.providerId);
      } catch {
        // Local login remains available if auth-method discovery fails.
      }
      try {
        const current = await api<SessionResponse>("/api/me");
        setSession(current);
        await Promise.all([loadWorkspaces(), loadAuditEvents()]);
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.status !== 401) {
          setError(caught instanceof Error ? caught.message : "Unable to load portal");
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAuditEvents, loadWorkspaces]);

  useEffect(() => {
    if (session?.user.role !== "admin") return;
    void refreshWorkers();
    void refreshAdminUsers();
    const timer = window.setInterval(() => void refreshWorkers(), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshAdminUsers, refreshWorkers, session?.user.role]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const current = await api<SessionResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          login: form.get("login"),
          password: form.get("password"),
        }),
      });
      setSession(current);
      await Promise.all([loadWorkspaces(), loadAuditEvents()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed");
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === null) return;
    setError(null);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api("/api/workspaces", {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ name: form.get("name") }),
      });
      formElement.reset();
      await Promise.all([loadWorkspaces(), loadAuditEvents()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creation failed");
    }
  }

  async function createLocalUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === null) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setAdminUsersError(null);
    try {
      await api("/api/admin/users", {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify({
          email: form.get("email"),
          username: form.get("username") || undefined,
          password: form.get("password"),
        }),
      });
      formElement.reset();
      await loadAdminUsers();
    } catch (caught) {
      setAdminUsersError(
        adminUsersErrorMessage(caught, "Unable to create Local User"),
      );
    }
  }

  async function updateManagedUser(
    user: AdminUser,
    update: AdminUserUpdate,
  ) {
    if (session === null) return;
    await runConfirmedAdminUserUpdate(
      user,
      update,
      (message) => window.confirm(message),
      async () => {
        setAdminUsersError(null);
        setPendingUserId(user.id);
        try {
          const result = await api<{ user: AdminUser }>(
            `/api/admin/users/${user.id}`,
            {
              method: "PATCH",
              headers: { "x-csrf-token": session.csrfToken },
              body: JSON.stringify(update),
            },
          );
          if (user.id === session.user.id) {
            if (result.user.status === "disabled") {
              setSession(null);
              return;
            }
            setSession({
              ...session,
              user: {
                ...session.user,
                role: result.user.role,
                status: result.user.status,
              },
            });
          }
          await loadAdminUsers();
        } catch (caught) {
          setAdminUsersError(
            adminUsersErrorMessage(caught, "Unable to update User"),
          );
        } finally {
          setPendingUserId(null);
        }
      },
    );
  }

  async function resetManagedPassword(user: AdminUser) {
    if (session === null) return;
    const password = window.prompt(`为 ${user.username ?? user.email} 设置新密码（至少 12 个字符）`);
    if (password === null) return;
    setAdminUsersError(null);
    setPendingUserId(user.id);
    try {
      await api(`/api/admin/users/${user.id}/reset-password`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ password }),
      });
    } catch (caught) {
      setAdminUsersError(
        adminUsersErrorMessage(caught, "Unable to reset password"),
      );
    } finally {
      setPendingUserId(null);
    }
  }

  async function bindManagedOidcIdentity(user: AdminUser) {
    if (session === null || oidcProviderId === null) return;
    const providerSubject = window.prompt(
      `将 ${oidcProviderId} 的精确 subject 绑定到 ${user.username ?? user.email}`,
    );
    if (providerSubject === null || providerSubject.length === 0) return;
    setAdminUsersError(null);
    setPendingUserId(user.id);
    try {
      await api(`/api/admin/users/${user.id}/oidc-identities`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify({
          providerId: oidcProviderId,
          providerSubject,
        }),
      });
    } catch (caught) {
      setAdminUsersError(
        adminUsersErrorMessage(caught, "Unable to bind OIDC identity"),
      );
    } finally {
      setPendingUserId(null);
    }
  }

  async function revokeManagedSessions(user: AdminUser) {
    if (session === null) return;
    if (!window.confirm(`撤销 ${user.username ?? user.email} 的全部登录会话？`)) return;
    setAdminUsersError(null);
    setPendingUserId(user.id);
    try {
      await api(`/api/admin/users/${user.id}/revoke-sessions`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: "{}",
      });
      if (user.id === session.user.id) {
        setSession(null);
        return;
      }
    } catch (caught) {
      setAdminUsersError(
        adminUsersErrorMessage(caught, "Unable to revoke sessions"),
      );
    } finally {
      setPendingUserId(null);
    }
  }

  async function toggleManagedWorkspaces(user: AdminUser) {
    if (expandedUserId === user.id) {
      setExpandedUserId(null);
      setManagedWorkspaces([]);
      return;
    }
    setAdminUsersError(null);
    setPendingUserId(user.id);
    try {
      const result = await api<{ workspaces: Workspace[] }>(
        `/api/admin/users/${user.id}/workspaces`,
      );
      setManagedWorkspaces(result.workspaces);
      setExpandedUserId(user.id);
    } catch (caught) {
      setAdminUsersError(
        adminUsersErrorMessage(caught, "Unable to load Workspace metadata"),
      );
    } finally {
      setPendingUserId(null);
    }
  }

  async function deleteWorkspace(workspace: Workspace) {
    if (session === null) return;
    if (!window.confirm(`永久删除 Workspace “${workspace.name}”？`)) return;
    setError(null);
    setPendingWorkspaceId(workspace.id);
    try {
      await api(`/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers: { "x-csrf-token": session.csrfToken },
      });
      await Promise.all([loadWorkspaces(), loadAuditEvents()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Deletion failed");
    } finally {
      setPendingWorkspaceId(null);
    }
  }

  async function changeWorkspaceRuntime(
    workspace: Workspace,
    action: "start" | "stop",
  ) {
    if (session === null) return;
    setError(null);
    setPendingWorkspaceId(workspace.id);
    try {
      await api(`/api/workspaces/${workspace.id}/${action}`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: "{}",
      });
      await Promise.all([loadWorkspaces(), loadAuditEvents()]);
      if (session.user.role === "admin") await loadWorkers();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Runtime operation failed");
      await loadWorkspaces();
    } finally {
      setPendingWorkspaceId(null);
    }
  }

  async function openWorkspace(workspace: Workspace) {
    if (session === null || workspace.state !== "RUNNING") return;
    const workspaceTab = window.open("about:blank", "_blank");
    if (workspaceTab === null) {
      setError("浏览器阻止了新标签页，请允许弹出窗口后重试");
      return;
    }
    workspaceTab.opener = null;
    setError(null);
    setPendingWorkspaceId(workspace.id);
    try {
      const exchange = await api<WorkspaceOpenResponse>(
        `/api/workspaces/${workspace.id}/open`,
        {
          method: "POST",
          headers: { "x-csrf-token": session.csrfToken },
          body: "{}",
        },
      );
      const form = workspaceTab.document.createElement("form");
      form.method = "POST";
      form.action = exchange.exchangeUrl;
      const code = workspaceTab.document.createElement("input");
      code.type = "hidden";
      code.name = "code";
      code.value = exchange.code;
      form.append(code);
      workspaceTab.document.body.append(form);
      form.submit();
      void loadAuditEvents();
      setPendingWorkspaceId(null);
    } catch (caught) {
      workspaceTab.close();
      setError(caught instanceof Error ? caught.message : "Unable to open Workspace");
      setPendingWorkspaceId(null);
      await loadWorkspaces();
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
    setWorkspaces([]);
    setWorkers([]);
    setAdminUsers([]);
    setAdminUsersError(null);
    setManagedWorkspaces([]);
    setExpandedUserId(null);
    setAuditEvents([]);
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
          <p>登录后创建持久 Workspace。对话、终端和文件能力将在 Runtime 阶段由 pi-web 提供。</p>
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
          {oidcEnabled ? (
            <>
              <div className="login-divider"><span>或</span></div>
              <a className="sso-link" href="/auth/oidc/login">
                Sign in with SSO
              </a>
            </>
          ) : null}
        </form>
      </main>
    );
  }

  return (
    <div className="portal-shell">
      <header>
        <div className="brand"><span className="mark">π</span><span>Agent Runtime</span></div>
        <div className="account">
          <span>{session.user.username ?? session.user.email}</span>
          <button className="quiet" onClick={() => void logout()}>退出</button>
        </div>
      </header>
      <main className="workspace-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR COMPUTE</p>
            <h1>我的 Workspace</h1>
            <p>每个 Workspace 都有独立、持久的运行环境。</p>
          </div>
          <form className="create-form" onSubmit={createWorkspace}>
            <input name="name" placeholder="workspace-name" maxLength={80} required />
            <button type="submit">新建 Workspace</button>
          </form>
        </div>
        <section className="platform-summary" aria-label="平台概览">
          <div className="summary-stat">
            <span>持久 Workspace</span>
            <strong>{workspaces.length}</strong>
          </div>
          <div className="summary-stat">
            <span>正在运行</span>
            <strong>{workspaces.filter((workspace) => workspace.state === "RUNNING").length}</strong>
          </div>
          {session.user.role === "admin" ? (
            <div className="summary-stat">
              <span>在线 Worker</span>
              <strong>{workers.filter((worker) => worker.status === "ONLINE").length}</strong>
            </div>
          ) : null}
          <div className="summary-stat">
            <span>最近平台事件</span>
            <strong>{auditEvents.length}</strong>
          </div>
        </section>
        {session.user.role === "admin" ? (
          <section className="user-panel" aria-labelledby="user-panel-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">ADMIN</p>
                <h2 id="user-panel-title">Users</h2>
              </div>
              <button className="secondary" onClick={() => void refreshAdminUsers()}>
                刷新
              </button>
            </div>
            {adminUsersError === null ? null : (
              <p className="error banner" role="alert">{adminUsersError}</p>
            )}
            <form className="user-create-form" onSubmit={createLocalUser}>
              <input name="email" type="email" placeholder="email@example.com" maxLength={320} required />
              <input name="username" placeholder="username（可选）" minLength={3} maxLength={64} pattern="[a-z0-9][a-z0-9._-]{2,63}" />
              <input name="password" type="password" placeholder="初始密码（至少 12 位）" minLength={12} maxLength={1024} autoComplete="new-password" required />
              <button type="submit">创建 Local User</button>
            </form>
            {adminUsers.length === 0 ? (
              <p className="muted">尚无用户记录。</p>
            ) : (
              <div className="worker-table-wrap">
                <table>
                  <thead>
                    <tr><th>User</th><th>来源</th><th>Role</th><th>状态</th><th>Workspace</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    {adminUsers.map((user) => (
                      <Fragment key={user.id}>
                        <tr>
                          <td><strong>{user.username ?? user.email}</strong><small>{user.email}{user.lastLoginAt === null ? "" : ` · 最近登录 ${new Date(user.lastLoginAt).toLocaleString()}`}</small></td>
                          <td>Local</td>
                          <td><span className="state">{user.role}</span></td>
                          <td><span className={`state user-${user.status}`}>{user.status}</span></td>
                          <td>{user.workspaceCount}</td>
                          <td>
                            <div className="table-actions">
                              <button
                                className="secondary"
                                disabled={pendingUserId === user.id}
                                onClick={() => void updateManagedUser(user, { status: user.status === "active" ? "disabled" : "active" })}
                              >{user.status === "active" ? "禁用" : "启用"}</button>
                              <button
                                className="secondary"
                                disabled={pendingUserId === user.id}
                                onClick={() => void updateManagedUser(user, { role: user.role === "admin" ? "user" : "admin" })}
                              >设为 {user.role === "admin" ? "user" : "admin"}</button>
                              <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void resetManagedPassword(user)}>重置密码</button>
                              {oidcProviderId === null ? null : (
                                <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void bindManagedOidcIdentity(user)}>绑定 OIDC subject</button>
                              )}
                              <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void revokeManagedSessions(user)}>撤销会话</button>
                              <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void toggleManagedWorkspaces(user)}>Workspace metadata</button>
                            </div>
                          </td>
                        </tr>
                        {expandedUserId === user.id ? (
                          <tr className="metadata-row" key={`${user.id}-workspaces`}>
                            <td colSpan={6}>
                              {managedWorkspaces.length === 0 ? (
                                <span className="muted">该用户没有 Workspace。</span>
                              ) : (
                                <ul>
                                  {managedWorkspaces.map((workspace) => (
                                    <li key={workspace.id}>
                                      <strong>{workspace.name}</strong>
                                      <span>{workspace.state} · {workspace.workerId ?? "未分配"} · {workspace.id}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
        {session.user.role === "admin" ? (
          <section className="worker-panel" aria-labelledby="worker-panel-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">ADMIN</p>
                <h2 id="worker-panel-title">Workers</h2>
              </div>
              <button className="secondary" onClick={() => void refreshWorkers()}>
                刷新
              </button>
            </div>
            {workers.length === 0 ? (
              <p className="muted">尚未预注册 Worker。</p>
            ) : (
              <div className="worker-table-wrap">
                <table>
                  <thead>
                    <tr><th>Worker</th><th>状态</th><th>架构 / 主机</th><th>Runtime</th><th>实测能力</th><th>Workspace</th><th>最后心跳</th></tr>
                  </thead>
                  <tbody>
                    {workers.map((worker) => (
                      <tr key={worker.id}>
                        <td><strong>{worker.id}</strong><small>{worker.hostname ?? "尚未连接"}</small></td>
                        <td><span className={`state worker-${worker.status.toLowerCase()}`}>{worker.status}</span></td>
                        <td>{worker.architecture ?? "—"}<small>{worker.systemResources.logicalCpuCount ?? "—"} vCPU · {formatBytes(worker.systemResources.memoryBytes)}</small></td>
                        <td><strong>{worker.runtimeVersion ?? "—"}</strong><small title={worker.runtimeImage ?? undefined}>{worker.runtimeImage ?? "尚未上报"}</small></td>
                        <td><div className="capability-list">{Object.entries(CAPABILITY_LABELS).map(([key, label]) => (
                          <span className={worker.capabilities[key] ? "capability pass" : "capability fail"} key={key}>{label}</span>
                        ))}</div></td>
                        <td title={`Worker 最近上报 ${worker.allocatedWorkspaces} 个 Runtime；调度以平台 assignment 为准`}>
                          <strong>{worker.assignedWorkspaces}/{worker.maxWorkspaces ?? "—"}</strong>
                          <span className="capacity-track" aria-label="authoritative assignment capacity"><i style={{ width: `${worker.maxWorkspaces === null || worker.maxWorkspaces === 0 ? 0 : Math.min(100, worker.assignedWorkspaces / worker.maxWorkspaces * 100)}%` }} /></span>
                          <small>reported {worker.allocatedWorkspaces}</small>
                        </td>
                        <td>{worker.lastHeartbeatAt === null ? "—" : new Date(worker.lastHeartbeatAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
        {error === null ? null : <p className="error banner">{error}</p>}
        {workspaces.length === 0 ? (
          <section className="empty-state">
            <span>＋</span>
            <h2>还没有 Workspace</h2>
            <p>创建第一个工作环境，由 Scheduler 选择 compatible Worker 启动 pi-web。</p>
          </section>
        ) : (
          <section className="workspace-grid">
            {workspaces.map((workspace) => (
              <article className="workspace-card" key={workspace.id}>
                <div className="workspace-title">
                  <h2>{workspace.name}</h2>
                  <span className={`state state-${workspace.state.toLowerCase()}`}>{workspace.state}</span>
                </div>
                <dl>
                  <div><dt>Worker</dt><dd>{workspace.workerId ?? "等待分配"}</dd></div>
                  <div><dt>Workspace ID</dt><dd title={workspace.id}>{workspace.id.slice(0, 8)}…</dd></div>
                  <div><dt>创建时间</dt><dd>{new Date(workspace.createdAt).toLocaleString()}</dd></div>
                </dl>
                <div className="card-actions">
                  {workspace.state === "RUNNING" ? (
                    <button
                      className="secondary"
                      disabled={pendingWorkspaceId === workspace.id}
                      onClick={() => void changeWorkspaceRuntime(workspace, "stop")}
                    >停止</button>
                  ) : (
                    <button
                      disabled={
                        pendingWorkspaceId === workspace.id ||
                        ["STARTING", "STOPPING", "DELETING"].includes(workspace.state)
                      }
                      onClick={() => void changeWorkspaceRuntime(workspace, "start")}
                    >启动</button>
                  )}
                  <button
                    disabled={
                      workspace.state !== "RUNNING" ||
                      pendingWorkspaceId === workspace.id
                    }
                    title={workspace.state === "RUNNING" ? "在新标签页打开 pi-web" : "请先启动 Workspace"}
                    onClick={() => void openWorkspace(workspace)}
                  >打开 ↗</button>
                  <button
                    className="danger"
                    disabled={pendingWorkspaceId === workspace.id}
                    onClick={() => void deleteWorkspace(workspace)}
                  >删除</button>
                </div>
              </article>
            ))}
          </section>
        )}
        <section className="audit-panel" aria-labelledby="audit-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">PLATFORM AUDIT</p>
              <h2 id="audit-title">最近基础设施事件</h2>
              <p className="muted">只记录平台生命周期与路由事件，不保存 Pi message 或 tool stream。</p>
            </div>
            <button className="secondary" onClick={() => void loadAuditEvents()}>刷新</button>
          </div>
          {auditEvents.length === 0 ? (
            <p className="muted">尚无平台事件。</p>
          ) : (
            <ol className="audit-list">
              {auditEvents.map((event) => {
                const workspace = workspaces.find((candidate) => candidate.id === event.workspaceId);
                const recordedName = event.details.name;
                const subject = workspace?.name ??
                  (typeof recordedName === "string" ? recordedName : null) ??
                  (event.workspaceId === null ? "平台" : `${event.workspaceId.slice(0, 8)}…`);
                const transition = stateTransition(event.details);
                return (
                  <li key={event.id}>
                    <span className="audit-dot" aria-hidden="true" />
                    <div>
                      <strong>{AUDIT_LABELS[event.eventType] ?? event.eventType}</strong>
                      <p>{subject}{event.workerId === null ? "" : ` · ${event.workerId}`}{transition === null ? "" : ` · ${transition}`}</p>
                    </div>
                    <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </main>
    </div>
  );
}
