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
  runtimeVersion: string | null;
  maxWorkspaces: number | null;
  assignedWorkspaces: number;
  allocatedWorkspaces: number;
  lastHeartbeatAt: string | null;
}

interface SessionResponse {
  user: User;
  csrfToken: string;
}

interface WorkspaceOpenResponse {
  exchangeUrl: string;
  code: string;
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
        await loadWorkspaces();
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.status !== 401) {
          setError(caught instanceof Error ? caught.message : "Unable to load portal");
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [loadWorkspaces]);

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
      await loadWorkspaces();
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
      await loadWorkspaces();
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
      await loadWorkspaces();
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
      await loadWorkspaces();
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
                    <tr><th>Worker</th><th>状态</th><th>架构</th><th>Workspace</th><th>最后心跳</th></tr>
                  </thead>
                  <tbody>
                    {workers.map((worker) => (
                      <tr key={worker.id}>
                        <td><strong>{worker.id}</strong><small>{worker.hostname ?? "尚未连接"}</small></td>
                        <td><span className={`state worker-${worker.status.toLowerCase()}`}>{worker.status}</span></td>
                        <td>{worker.architecture ?? "—"}</td>
                        <td title={`Worker 最近上报 ${worker.allocatedWorkspaces} 个 Runtime`}>
                          {worker.assignedWorkspaces}/{worker.maxWorkspaces ?? "—"}
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
      </main>
    </div>
  );
}
