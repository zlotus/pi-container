import { type FormEvent, useCallback, useEffect, useState } from "react";

import { api } from "../api.js";
import type { SessionResponse, Workspace, WorkspaceOpenResponse } from "../types.js";

export function WorkspacesPage({ session }: { session: SessionResponse }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);

  const loadWorkspaces = useCallback(async () => {
    const result = await api<{ workspaces: Workspace[] }>("/api/workspaces");
    setWorkspaces(result.workspaces);
  }, []);

  useEffect(() => {
    let active = true;
    void loadWorkspaces()
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Unable to load Workspaces");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadWorkspaces]);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    setError(null);
    setPendingWorkspaceId(workspace.id);
    try {
      await api(`/api/workspaces/${workspace.id}/${action}`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: "{}",
      });
      await loadWorkspaces();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Runtime operation failed");
      await loadWorkspaces();
    } finally {
      setPendingWorkspaceId(null);
    }
  }

  async function openWorkspace(workspace: Workspace) {
    if (workspace.state !== "RUNNING") return;
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
    } catch (caught) {
      workspaceTab.close();
      setError(caught instanceof Error ? caught.message : "Unable to open Workspace");
      await loadWorkspaces();
    } finally {
      setPendingWorkspaceId(null);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR COMPUTE</p>
          <h1>Workspaces</h1>
          <p>每个 Workspace 都有独立、持久的运行环境。</p>
        </div>
        <form className="create-form" onSubmit={createWorkspace}>
          <input name="name" placeholder="workspace-name" maxLength={80} required />
          <button type="submit">新建 Workspace</button>
        </form>
      </div>
      <section className="platform-summary" aria-label="Workspace 概览">
        <div className="summary-stat">
          <span>持久 Workspace</span>
          <strong>{workspaces.length}</strong>
        </div>
        <div className="summary-stat">
          <span>正在运行</span>
          <strong>{workspaces.filter((workspace) => workspace.state === "RUNNING").length}</strong>
        </div>
      </section>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      {loading ? (
        <section className="page-state">正在载入 Workspace…</section>
      ) : workspaces.length === 0 ? (
        <section className="empty-state">
          <span>＋</span>
          <h2>还没有 Workspace</h2>
          <p>创建第一个工作环境，由 Scheduler 选择 compatible Worker 启动 pi-web。</p>
        </section>
      ) : (
        <section className="workspace-grid" aria-label="Workspace 列表">
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
                  disabled={workspace.state !== "RUNNING" || pendingWorkspaceId === workspace.id}
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
    </>
  );
}
