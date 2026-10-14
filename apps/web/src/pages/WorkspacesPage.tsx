import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api.js";
import { DiskUsage } from "../components/DiskUsage.js";
import { ResourceUsage } from "../components/ResourceUsage.js";
import { ConfirmDialog } from "../components/Modal.js";
import { RelativeTime } from "../components/RelativeTime.js";
import {
  formatAbsoluteTime,
  formatUsd,
  modelAccessLabel,
  runtimeLabel,
  STARTABLE_WORKSPACE_STATES,
  TRANSITIONAL_WORKSPACE_STATES,
  workspaceStateLabel,
} from "../labels.js";
import type {
  ModelAccess,
  ModelUsageResponse,
  SessionResponse,
  Workspace,
  WorkspaceOpenResponse,
} from "../types.js";

/** “本周期平台模型花费 …” for the page heading; null when platform models are off. */
export function modelUsageSummary(response: ModelUsageResponse | null): string | null {
  if (response === null || !response.enabled) return null;
  if (!response.available) return "平台模型用量暂时无法获取。";
  const usage = response.usage;
  if (usage === null) return "本周期尚未使用平台模型。";
  const reset = usage.budgetResetAt === null ? "" : `，${formatAbsoluteTime(usage.budgetResetAt)} 重置`;
  return `本周期平台模型花费 ${formatUsd(usage.spendUsd)} / 预算 ${formatUsd(usage.maxBudgetUsd)}${reset}。`;
}

function ModelAccessBadge({ access }: { access: ModelAccess }) {
  const label = modelAccessLabel(access);
  return (
    <span className={`model-access model-access-${label.tone}`} title={label.detail ?? undefined}>
      {label.text}
      {label.detail === null || access.reason !== "USER_CONFIG_INVALID" ? null : (
        <small role="status">{label.detail}</small>
      )}
    </span>
  );
}

export type RuntimeAction = "upgrade" | "rollback" | "retry";

/** The Runtime changes a Workspace card offers, in menu order (specs.md Phase 18.8). */
export function runtimeActions(workspace: Pick<Workspace, "runtime">): RuntimeAction[] {
  const runtime = workspace.runtime;
  if (runtime === undefined || runtime === null) return [];
  if (runtime.changeIncomplete) return runtime.rollbackAvailable ? ["retry", "rollback"] : ["retry"];
  return [
    ...(runtime.upgradeAvailable ? (["upgrade"] as const) : []),
    ...(runtime.rollbackAvailable ? (["rollback"] as const) : []),
  ];
}

const RUNTIME_ACTION_LABELS: Record<RuntimeAction, string> = {
  upgrade: "升级 Runtime…",
  rollback: "回滚到上一版本…",
  retry: "重试 Runtime 切换…",
};

function RuntimeSummary({ workspace }: { workspace: Workspace }) {
  const runtime = workspace.runtime;
  if (runtime === undefined || runtime === null) return <>—</>;
  return (
    <span title={runtime.image}>
      {runtimeLabel(runtime)}
      {runtime.changeIncomplete ? (
        <small className="error" role="status">Runtime 切换未完成，请在“⋯”中重试或回滚</small>
      ) : runtime.upgradeAvailable ? (
        <small className="muted">有新版本可升级（“⋯”菜单）</small>
      ) : null}
    </span>
  );
}

/** The idle-stop line of a card (specs.md Phase 18.5); null when there is nothing to say. */
export function idleNote(
  workspace: Pick<Workspace, "state" | "lastStopReason" | "idle">,
  idleStopAfterHours: number | null,
  now: Date = new Date(),
): string | null {
  if (workspace.state === "STOPPED" && workspace.lastStopReason === "idle") {
    return "因长时间空闲已自动停止，数据完整保留，可随时启动";
  }
  if (workspace.state !== "RUNNING" || idleStopAfterHours === null) return null;
  const idle = workspace.idle;
  if (idle === undefined || idle === null) {
    return `无连接、无访问且无计算活动 ${idleStopAfterHours} 小时后将自动停止`;
  }
  if (idle.connected) {
    return `当前有连接，不会被回收（无连接、无访问且无计算活动 ${idleStopAfterHours} 小时后自动停止）`;
  }
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(idle.idleSince)) / 60_000));
  const stopAt = new Date(idle.stopAt);
  const clock = `${String(stopAt.getHours()).padStart(2, "0")}:${String(stopAt.getMinutes()).padStart(2, "0")}`;
  const elapsed = minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  return stopAt.getTime() <= now.getTime()
    ? `已空闲 ${elapsed}，将在下一次检查（5 分钟内）自动停止`
    : `已空闲 ${elapsed}，约 ${clock} 自动停止；任何访问或计算活动都会重新计时`;
}

export const WORKSPACE_POLL_INTERVAL_MS = 3_000;
/** Refresh of observed CPU/memory while a Workspace runs and the page is visible (Phase 17.7). */
export const WORKSPACE_USAGE_POLL_INTERVAL_MS = 15_000;

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
  const [runtimeTarget, setRuntimeTarget] = useState<{ workspace: Workspace; action: RuntimeAction } | null>(null);
  const [modelUsage, setModelUsage] = useState<ModelUsageResponse | null>(null);
  const [idleStopAfterHours, setIdleStopAfterHours] = useState<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void api<ModelUsageResponse>("/api/me/model-usage")
      .then((result) => {
        if (active) setModelUsage(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const result = await api<{ workspaces: Workspace[]; idleStopAfterHours?: number | null }>("/api/workspaces");
    setWorkspaces(result.workspaces);
    setIdleStopAfterHours(result.idleStopAfterHours ?? null);
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

  const running = workspaces.some((workspace) => workspace.state === "RUNNING");
  useEffect(() => {
    if (!running || polling) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadWorkspaces().catch(() => undefined);
    }, WORKSPACE_USAGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [running, polling, loadWorkspaces]);

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

  async function changeRuntimeVersion(workspace: Workspace, action: RuntimeAction) {
    setError(null);
    setPendingWorkspaceId(workspace.id);
    try {
      await api(`/api/workspaces/${workspace.id}/runtime/${action}`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: "{}",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Runtime 切换失败");
    } finally {
      setRuntimeTarget(null);
      setPendingWorkspaceId(null);
      await loadWorkspaces().catch(() => undefined);
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

  const usageSummary = modelUsageSummary(modelUsage);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Workspace</h1>
          <p>
            创建和管理你的 Workspace，并打开运行中的工作环境。
            {loading || workspaces.length === 0 ? null : ` ${workspaceSummary(workspaces)}`}
            {usageSummary === null ? null : ` ${usageSummary}`}
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
                <div><dt>磁盘</dt><dd><DiskUsage disk={workspace.disk} /></dd></div>
                <div><dt>Runtime</dt><dd><RuntimeSummary workspace={workspace} /></dd></div>
                {idleNote(workspace, idleStopAfterHours) === null ? null : (
                  <div><dt>空闲回收</dt><dd className="muted">{idleNote(workspace, idleStopAfterHours)}</dd></div>
                )}
                {workspace.usage === undefined || workspace.usage === null ? null : (
                  <div><dt>实际用量</dt><dd><ResourceUsage usage={workspace.usage} /></dd></div>
                )}
                {workspace.modelAccess === undefined || workspace.modelAccess.status === "disabled" ? null : (
                  <div><dt>平台模型</dt><dd><ModelAccessBadge access={workspace.modelAccess} /></dd></div>
                )}
              </dl>
              <div className="card-actions">
                {actionButtons(workspace)}
                <details className="more-menu">
                  <summary aria-label={`${workspace.name} 的更多操作`} title="更多操作">⋯</summary>
                  <div role="menu">
                    {runtimeActions(workspace).map((action) => (
                      <button
                        key={action}
                        role="menuitem"
                        disabled={pendingWorkspaceId === workspace.id}
                        onClick={(event) => {
                          event.currentTarget.closest("details")?.removeAttribute("open");
                          setRuntimeTarget({ workspace, action });
                        }}
                      >{RUNTIME_ACTION_LABELS[action]}</button>
                    ))}
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
        open={runtimeTarget !== null}
        title={runtimeTarget === null ? "" : RUNTIME_ACTION_LABELS[runtimeTarget.action].replace("…", "")}
        confirmLabel={runtimeTarget?.action === "rollback" ? "回滚" : runtimeTarget?.action === "retry" ? "重试" : "升级"}
        tone="primary"
        pending={runtimeTarget !== null && pendingWorkspaceId === runtimeTarget.workspace.id}
        onConfirm={() => {
          if (runtimeTarget !== null) void changeRuntimeVersion(runtimeTarget.workspace, runtimeTarget.action);
        }}
        onCancel={() => setRuntimeTarget(null)}
      >
        <p>
          将以{runtimeTarget?.action === "rollback" ? "上一版本" : runtimeTarget?.action === "retry" ? "上次请求的版本" : "平台当前版本"}
          重新创建 Workspace <strong>{runtimeTarget?.workspace.name}</strong> 的容器。<code>/workspace</code>、
          主目录、Pi 会话与配置都保留不变；切换期间不能启动。
        </p>
        {runtimeTarget?.action === "rollback" ? (
          <p className="muted">新版本中产生的会话在旧版本中可能无法完整显示，文件不受影响。</p>
        ) : null}
      </ConfirmDialog>
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
