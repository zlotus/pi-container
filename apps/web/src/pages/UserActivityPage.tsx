import { useEffect, useState } from "react";

import { api } from "../api.js";
import { EMPTY_AUDIT_FILTER, type AuditFilter, useAuditEvents } from "../audit.js";
import { AuditEventList } from "../components/AuditEventList.js";
import type { Workspace } from "../types.js";

export function UserActivityPage() {
  const [filter, setFilter] = useState<AuditFilter>(EMPTY_AUDIT_FILTER);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const activity = useAuditEvents(filter);

  useEffect(() => {
    let active = true;
    void api<{ workspaces: Workspace[] }>("/api/workspaces")
      .then((result) => {
        if (active) setWorkspaces(result.workspaces);
      })
      .catch((caught: unknown) => {
        if (active) setLookupError(caught instanceof Error ? caught.message : "无法载入 Workspace");
      });
    return () => {
      active = false;
    };
  }, []);

  const error = activity.error ?? lookupError;

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>活动</h1>
          <p>你的 Workspace 的状态变化和操作记录，按时间倒序。</p>
        </div>
        <button className="secondary" onClick={activity.refresh}>刷新</button>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      <section className="audit-panel" aria-label="最近活动">
        {workspaces.length > 1 ? (
          <div className="filter-bar">
            <select
              aria-label="按 Workspace 筛选"
              value={filter.workspaceId}
              onChange={(event) => setFilter({ ...filter, workspaceId: event.target.value })}
            >
              <option value="">全部 Workspace</option>
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </div>
        ) : null}
        <AuditEventList
          events={activity.events}
          workspaces={workspaces}
          isAdmin={false}
          loading={activity.loading}
          loadingMessage="正在载入活动…"
          emptyMessage="你的 Workspace 暂无活动记录。"
        />
        {activity.hasMore && !activity.loading ? (
          <div className="load-more">
            <button className="secondary" disabled={activity.loadingMore} onClick={() => void activity.loadMore()}>
              {activity.loadingMore ? "正在加载…" : "加载更多"}
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}
