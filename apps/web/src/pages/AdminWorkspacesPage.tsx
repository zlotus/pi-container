import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../api.js";
import { RelativeTime } from "../components/RelativeTime.js";
import { workspaceStateLabel } from "../labels.js";
import type { AdminWorkspace } from "../types.js";

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

export function AdminWorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AdminWorkspaceFilter>({ query: "", state: "", workerId: "" });

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

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>全部 Workspace</h1>
          <p>平台所有用户的 Workspace 元数据，只读。管理员不因此获得 Workspace 内容访问权。</p>
        </div>
        <button className="secondary" onClick={() => void refresh()}>刷新</button>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      <section className="user-panel" aria-label="全部 Workspace">
        <div className="filter-bar">
          <input
            type="search"
            placeholder="搜索名称、所有者或 ID"
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
                <tr><th>Workspace</th><th>所有者</th><th>状态</th><th>Worker</th><th>创建于</th><th>最近活动</th></tr>
              </thead>
              <tbody>
                {visible.map((workspace) => (
                  <tr key={workspace.id}>
                    <td><strong>{workspace.name}</strong><small title={workspace.id}>{workspace.id.slice(0, 8)}…</small></td>
                    <td><strong>{ownerName(workspace.owner)}</strong>{workspace.owner.email === null || workspace.owner.username === null ? null : <small>{workspace.owner.email}</small>}</td>
                    <td><span className={`state state-${workspace.state.toLowerCase()}`}>{workspaceStateLabel(workspace.state)}</span></td>
                    <td>{workspace.workerId ?? "未分配"}</td>
                    <td><RelativeTime value={workspace.createdAt} /></td>
                    <td><RelativeTime value={workspace.lastActivityAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
