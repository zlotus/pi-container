import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api.js";
import { ConfirmDialog } from "../components/Modal.js";
import { RelativeTime } from "../components/RelativeTime.js";
import {
  STARTABLE_WORKSPACE_STATES,
  TRANSITIONAL_WORKSPACE_STATES,
  workspaceStateLabel,
} from "../labels.js";
import type { SessionResponse, Workspace, WorkspaceOpenResponse } from "../types.js";

export const WORKSPACE_POLL_INTERVAL_MS = 3_000;

export function hasTransitionalWorkspace(workspaces: readonly Pick<Workspace, "state">[]): boolean {
  return workspaces.some((workspace) => TRANSITIONAL_WORKSPACE_STATES.includes(workspace.state));
}

export function workspaceSummary(workspaces: readonly Pick<Workspace, "state">[]): string {
  const running = workspaces.filter((workspace) => workspace.state === "RUNNING").length;
  return `共 ${workspaces.length} 个 Workspace，${running} 个运行中。`;
}

export function WorkspacesPage({ session }: { session: SessionResponse }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const loadWorkspaces = useCallback(async () => {
    const result = await api<{ workspaces: Workspace[] }>("/api/workspaces");
    setWorkspaces(result.workspaces);
  }, []);

  useEffect(() => {
    let active = true;
    void loadWorkspaces()
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "无法载入 Workspace");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadWorkspaces]);

  const polling = hasTransitionalWorkspace(workspaces);
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      void loadWorkspaces().catch(() => undefined);
    }, WORKSPACE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [polling, loadWorkspaces]);

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
      setError(caught instanceof Error ? caught.message : "创建失败");
    }
  }

  async function deleteWorkspace(workspace: Workspace) {
    setError(null);
    setPendingWorkspaceId(workspace.id);
    try {
      await api(`/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers: { "x-csrf-token": session.csrfToken },
      });
      setDeleteTarget(null);
      await loadWorkspaces();
    } catch (caught) {
      setDeleteTarget(null);
      setError(caught instanceof Error ? caught.message : "删除失败");
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
      setError(caught instanceof Error ? caught.message : "操作失败");
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
      setError(caught instanceof Error ? caught.message : "无法打开 Workspace");
      await loadWorkspaces();
    } finally {
      setPendingWorkspaceId(null);
    }
  }

  function actionButtons(workspace: Workspace) {
    const pending = pendingWorkspaceId === workspace.id;
    const running = workspace.state === "RUNNING";
    const openButton = (
      <button
        key="open"
        className={running ? "card-primary" : "secondary"}
        disabled={!running || pending}
        title={running ? "在新标签页打开 Workspace" : "请先启动 Workspace"}
        onClick={() => void openWorkspace(workspace)}
      >打开 ↗</button>
    );
    const runtimeButton = running ? (
      <button
        key="runtime"
        className="secondary"
        disabled={pending}
        onClick={() => void changeWorkspaceRuntime(workspace, "stop")}
      >停止</button>
    ) : (
      <button
        key="runtime"
        className="card-primary"
        disabled={pending || !STARTABLE_WORKSPACE_STATES.includes(workspace.state)}
        onClick={() => void changeWorkspaceRuntime(workspace, "start")}
      >启动</button>
    );
    return running ? [openButton, runtimeButton] : [runtimeButton, openButton];
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Workspace</h1>
          <p>
            创建和管理你的 Workspace，并打开运行中的工作环境。
            {loading || workspaces.length === 0 ? null : ` ${workspaceSummary(workspaces)}`}
          </p>
        </div>
        <form className="create-form" onSubmit={createWorkspace}>
          <input
            ref={nameInputRef}
            name="name"
            placeholder="新 Workspace 名称"
            aria-label="新 Workspace 名称"
            maxLength={80}
            required
          />
          <button type="submit">新建 Workspace</button>
        </form>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      {loading ? (
        <section className="page-state">正在载入 Workspace…</section>
      ) : workspaces.length === 0 ? (
        <section className="empty-state">
          <h2>还没有 Workspace</h2>
          <p>Workspace 是一台带完整工具链的隔离工作环境，可在其中使用对话、终端和文件。</p>
          <button onClick={() => nameInputRef.current?.focus()}>创建第一个 Workspace</button>
        </section>
      ) : (
        <section className="workspace-grid" aria-label="Workspace 列表">
          {workspaces.map((workspace) => (
            <article className="workspace-card" key={workspace.id}>
              <div className="workspace-title">
                <h2 title={`Workspace ID：${workspace.id}`}>{workspace.name}</h2>
                <span className={`state state-${workspace.state.toLowerCase()}`}>
                  {workspaceStateLabel(workspace.state)}
                </span>
              </div>
              <dl>
                <div><dt>运行节点</dt><dd>{workspace.workerId ?? "等待分配"}</dd></div>
                <div><dt>创建于</dt><dd><RelativeTime value={workspace.createdAt} /></dd></div>
              </dl>
              <div className="card-actions">
                {actionButtons(workspace)}
                <details className="more-menu">
                  <summary aria-label={`${workspace.name} 的更多操作`} title="更多操作">⋯</summary>
                  <div role="menu">
                    <button
                      role="menuitem"
                      className="danger"
                      disabled={pendingWorkspaceId === workspace.id}
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        setDeleteTarget(workspace);
                      }}
                    >删除 Workspace…</button>
                  </div>
                </details>
              </div>
            </article>
          ))}
        </section>
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="永久删除 Workspace"
        confirmLabel="永久删除"
        requiredText={deleteTarget?.name}
        pending={deleteTarget !== null && pendingWorkspaceId === deleteTarget.id}
        onConfirm={() => {
          if (deleteTarget !== null) void deleteWorkspace(deleteTarget);
        }}
        onCancel={() => setDeleteTarget(null)}
      >
        <p>
          将删除 Workspace <strong>{deleteTarget?.name}</strong> 的容器、<code>/workspace</code>{" "}
          中的全部文件以及所有 Pi 会话记录。此操作无法撤销。
        </p>
        <p className="muted">如只是暂时不用，请改用“停止”，数据会完整保留。</p>
      </ConfirmDialog>
    </>
  );
}
