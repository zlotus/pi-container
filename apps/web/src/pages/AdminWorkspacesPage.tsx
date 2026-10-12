import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../api.js";
import { DiskUsage } from "../components/DiskUsage.js";
import { ResourceUsage } from "../components/ResourceUsage.js";
import { ConfirmDialog, useTextPrompt } from "../components/Modal.js";
import { RelativeTime } from "../components/RelativeTime.js";
import { formatBytes, parseGibInput, runtimeLabel, workspaceStateLabel } from "../labels.js";
import type { AdminWorkspace, SessionResponse } from "../types.js";

export interface AdminWorkspaceFilter {
  query: string;
  state: string;
  workerId: string;
}

export function ownerName(owner: AdminWorkspace["owner"]): string {
  return owner.username ?? owner.email ?? owner.id.slice(0, 8);
}

export function filterAdminWorkspaces(
  workspaces: readonly AdminWorkspace[],
  filter: AdminWorkspaceFilter,
): AdminWorkspace[] {
  const query = filter.query.trim().toLowerCase();
  return workspaces.filter((workspace) => {
    if (filter.state !== "" && workspace.state !== filter.state) return false;
    if (filter.workerId === "__none__" && workspace.workerId !== null) return false;
    if (filter.workerId !== "" && filter.workerId !== "__none__" && workspace.workerId !== filter.workerId) {
      return false;
    }
    if (query === "") return true;
    return [workspace.name, workspace.id, workspace.owner.username, workspace.owner.email]
      .some((value) => value?.toLowerCase().includes(query));
  });
}

/** Whether an admin may switch this Workspace's Runtime now (stopped, or a change was interrupted). */
export function runtimeChangeable(workspace: Pick<AdminWorkspace, "state" | "runtime" | "offeredImages">): boolean {
  return (
    (workspace.state === "STOPPED" || workspace.runtime?.changeIncomplete === true) &&
    workspace.offeredImages.length > 1
  );
}

export function AdminWorkspacesPage({ session }: { session: SessionResponse }) {
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [prompt, promptDialog] = useTextPrompt();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AdminWorkspaceFilter>({ query: "", state: "", workerId: "" });
  const [runtimeTarget, setRuntimeTarget] = useState<AdminWorkspace | null>(null);
  const [runtimeImage, setRuntimeImage] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ workspaces: AdminWorkspace[] }>("/api/admin/workspaces");
      setWorkspaces(result.workspaces);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法载入 Workspace");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const states = useMemo(
    () => [...new Set(workspaces.map((workspace) => workspace.state))].sort(),
    [workspaces],
  );
  const workerIds = useMemo(
    () => [...new Set(workspaces.flatMap((workspace) => workspace.workerId ?? []))].sort(),
    [workspaces],
  );
  const visible = filterAdminWorkspaces(workspaces, filter);

  async function changeDiskLimit(workspace: AdminWorkspace) {
    const answer = await prompt({
      title: "调整磁盘上限",
      label: "新的上限（GiB，1～1024）",
      confirmLabel: "保存",
      maxLength: 12,
      description: (
        <>
          <p>
            Workspace <strong>{workspace.name}</strong> 当前上限 {formatBytes(workspace.disk.limitBytes)}，
            已用 {formatBytes(workspace.disk.usedBytes)}。调整立即生效，无需重启。
          </p>
          <p className="muted">低于当前用量时，该 Workspace 的写入会立即失败，直到用户删除文件。</p>
        </>
      ),
    });
    if (answer === null) return;
    const diskLimitBytes = parseGibInput(answer);
    if (diskLimitBytes === null) {
      setError("请输入以 GiB 为单位的正数，例如 20 或 1.5");
      return;
    }
    setPendingId(workspace.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ applied: boolean }>(`/api/admin/workspaces/${workspace.id}`, {
        method: "PATCH",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ diskLimitBytes }),
      });
      setNotice(
        result.applied
          ? `已将 ${workspace.name} 的磁盘上限调整为 ${formatBytes(diskLimitBytes)}，已立即生效。`
          : `已将 ${workspace.name} 的磁盘上限调整为 ${formatBytes(diskLimitBytes)}；所在 Worker 当前未连接，将在下次启动时生效。`,
      );
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "调整失败");
    } finally {
      setPendingId(null);
    }
  }

  async function switchRuntime(workspace: AdminWorkspace, image: string) {
    setPendingId(workspace.id);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/admin/workspaces/${workspace.id}/runtime`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ image }),
      });
      setNotice(`已将 ${workspace.name} 的 Runtime 切换为 ${image}。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Runtime 切换失败");
    } finally {
      setRuntimeTarget(null);
      setPendingId(null);
      await refresh();
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>全部 Workspace</h1>
          <p>平台所有用户的 Workspace 元数据与磁盘上限。管理员不因此获得 Workspace 内容访问权。</p>
        </div>
        <button className="secondary" onClick={() => void refresh()}>刷新</button>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      {notice === null ? null : <p className="notice banner" role="status">{notice}</p>}
      <section className="user-panel" aria-label="全部 Workspace">
        <div className="filter-bar">
          <input
            type="search"
            placeholder="搜索名称、所有者或 UUID"
            aria-label="搜索 Workspace"
            value={filter.query}
            onChange={(event) => setFilter({ ...filter, query: event.target.value })}
          />
          <select
            aria-label="按状态筛选"
            value={filter.state}
            onChange={(event) => setFilter({ ...filter, state: event.target.value })}
          >
            <option value="">全部状态</option>
            {states.map((state) => <option key={state} value={state}>{workspaceStateLabel(state)}</option>)}
          </select>
          <select
            aria-label="按 Worker 筛选"
            value={filter.workerId}
            onChange={(event) => setFilter({ ...filter, workerId: event.target.value })}
          >
            <option value="">全部 Worker</option>
            {workerIds.map((workerId) => <option key={workerId} value={workerId}>{workerId}</option>)}
            <option value="__none__">未分配</option>
          </select>
          <span className="filter-count">{visible.length} / {workspaces.length}</span>
        </div>
        {loading ? (
          <p className="muted">正在载入 Workspace…</p>
        ) : visible.length === 0 ? (
          <p className="muted">{workspaces.length === 0 ? "平台尚无 Workspace。" : "没有符合条件的 Workspace。"}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Workspace</th><th>所有者</th><th>状态</th><th>Worker</th><th>磁盘</th><th>CPU / 内存</th><th>Runtime</th><th>创建于</th><th>最近访问</th><th>操作</th></tr>
              </thead>
              <tbody>
                {visible.map((workspace) => (
                  <tr key={workspace.id}>
                    <td><strong>{workspace.name}</strong><small title={workspace.id}>{workspace.id.slice(0, 8)}…</small></td>
                    <td><strong>{ownerName(workspace.owner)}</strong>{workspace.owner.email === null || workspace.owner.username === null ? null : <small>{workspace.owner.email}</small>}</td>
                    <td><span className={`state state-${workspace.state.toLowerCase()}`}>{workspaceStateLabel(workspace.state)}</span></td>
                    <td>{workspace.workerId ?? "未分配"}</td>
                    <td><DiskUsage disk={workspace.disk} /></td>
                    <td>{workspace.usage === undefined || workspace.usage === null ? "—" : <ResourceUsage usage={workspace.usage} />}</td>
                    <td title={workspace.runtime?.image}>
                      {workspace.runtime === undefined || workspace.runtime === null ? "—" : runtimeLabel(workspace.runtime)}
                      {workspace.runtime?.changeIncomplete === true ? <small className="error">切换未完成</small> : null}
                    </td>
                    <td><RelativeTime value={workspace.createdAt} /></td>
                    <td><RelativeTime value={workspace.lastAccessAt ?? workspace.lastActivityAt} /></td>
                    <td>
                      <span className="row-actions">
                        <button
                          className="secondary compact-button"
                          disabled={pendingId === workspace.id || workspace.state === "DELETING"}
                          onClick={() => void changeDiskLimit(workspace)}
                        >调整上限</button>
                        <button
                          className="secondary compact-button"
                          disabled={pendingId === workspace.id || !runtimeChangeable(workspace)}
                          title={runtimeChangeable(workspace) ? "以所在 Worker 提供的其他镜像重建容器" : "仅已停止、且所在 Worker 提供多个镜像时可切换"}
                          onClick={() => {
                            setRuntimeImage(
                              workspace.offeredImages.find((image) => image.image !== workspace.runtime?.image)?.image ?? "",
                            );
                            setRuntimeTarget(workspace);
                          }}
                        >切换 Runtime</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {promptDialog}
      <ConfirmDialog
        open={runtimeTarget !== null}
        title="切换 Runtime"
        confirmLabel="切换"
        tone="primary"
        pending={runtimeTarget !== null && pendingId === runtimeTarget.id}
        onConfirm={() => {
          if (runtimeTarget !== null && runtimeImage !== "") void switchRuntime(runtimeTarget, runtimeImage);
        }}
        onCancel={() => setRuntimeTarget(null)}
      >
        <p>
          以所选镜像重新创建 <strong>{runtimeTarget?.name}</strong>（所有者 {runtimeTarget === null ? "" : ownerName(runtimeTarget.owner)}）
          的容器。文件、主目录、Pi 会话与配置保留不变；不会启动或打开该 Workspace。
        </p>
        <label>
          目标镜像
          <select value={runtimeImage} onChange={(event) => setRuntimeImage(event.target.value)}>
            {runtimeTarget?.offeredImages.map((image) => (
              <option key={image.image} value={image.image}>
                {image.runtimeVersion}（{image.image}）{image.image === runtimeTarget.runtime?.image ? " · 当前" : ""}
              </option>
            ))}
          </select>
        </label>
      </ConfirmDialog>
    </>
  );
}
