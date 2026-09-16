import { type FormEvent, useCallback, useEffect, useState } from "react";

interface User {
  id: string;
  email: string;
  username: string | null;
  role: "user" | "admin";
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

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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
      error?: { message?: string };
    } | null;
    throw new ApiError(body?.error?.message ?? "Request failed", response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);

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

  const refreshWorkers = useCallback(async () => {
    try {
      await loadWorkers();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load Workers");
    }
  }, [loadWorkers]);

  useEffect(() => {
    void (async () => {
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
    const timer = window.setInterval(() => void refreshWorkers(), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshWorkers, session?.user.role]);

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
          <article>
            <strong>{workspaces.length}</strong>
            <span>持久 Workspace</span>
          </article>
          <article>
            <strong>{workspaces.filter((workspace) => workspace.state === "RUNNING").length}</strong>
            <span>正在运行</span>
          </article>
          <article>
            <strong>{session.user.role === "admin" ? workers.filter((worker) => worker.status === "ONLINE").length : "隔离"}</strong>
            <span>{session.user.role === "admin" ? "在线 Worker" : "每 Workspace Runtime"}</span>
          </article>
          <article>
            <strong>{auditEvents.length}</strong>
            <span>最近平台事件</span>
          </article>
        </section>
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
                <div className="workspace-icon">{workspace.name.slice(0, 1).toUpperCase()}</div>
                <div className="workspace-title">
                  <h2>{workspace.name}</h2>
                  <span className="state">{workspace.state}</span>
                </div>
                <dl>
                  <div><dt>Worker</dt><dd>{workspace.workerId ?? "等待分配"}</dd></div>
                  <div><dt>Workspace ID</dt><dd title={workspace.id}>{workspace.id.slice(0, 8)}…</dd></div>
                  <div><dt>创建时间</dt><dd>{new Date(workspace.createdAt).toLocaleString()}</dd></div>
                </dl>
                <p className="artifact-note">成果保存在 <code>/workspace</code>，运行后通过 pi-web Files 安全查看或下载。</p>
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
        <section className="demo-panels">
          <article className="security-panel">
            <p className="eyebrow">SECURITY BOUNDARY</p>
            <h2>默认隔离，不绕过 Gateway</h2>
            <ul>
              <li>普通用户、非 privileged、无 Docker socket</li>
              <li>每个 Workspace 独立 bridge 与持久目录</li>
              <li>CPU / Memory / PID limits 由 Worker 强制执行</li>
              <li>HTTP、SSE、WebSocket 每次均校验 session 与 ownership</li>
            </ul>
            <p className="scope-note">面向可信企业内部用户的 Docker-based isolation，不宣称 VM-grade 或绝对安全。</p>
          </article>
          <article className="artifact-panel">
            <p className="eyebrow">ARTIFACT FLOW</p>
            <h2>成果留在真实工作目录</h2>
            <p>让 Agent 将报告、代码、PDF、Office 或媒体文件写入 <code>/workspace</code>，再使用 pi-web 已有 Files 能力预览和下载。</p>
            <p className="scope-note">平台不复制文件、不扫描 Pi 会话，也不另建重复的 Artifact registry。</p>
          </article>
        </section>
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
