import { useEffect, useMemo, useState } from "react";

import { api } from "../api.js";
import {
  AUDIT_CATEGORY_LABELS,
  auditEventsCsv,
  downloadTextFile,
  EMPTY_AUDIT_FILTER,
  type AuditFilter,
  useAuditEvents,
} from "../audit.js";
import { AuditEventList } from "../components/AuditEventList.js";
import { describeAuditEvent } from "../components/AuditEventRow.js";
import type { AdminUser, AdminWorkspace, Worker } from "../types.js";

export function AdminAuditPage() {
  const [filter, setFilter] = useState<AuditFilter>(EMPTY_AUDIT_FILTER);
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const audit = useAuditEvents(filter);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api<{ workspaces: AdminWorkspace[] }>("/api/admin/workspaces").then((result) => {
        if (active) setWorkspaces(result.workspaces);
      }),
      api<{ users: AdminUser[] }>("/api/admin/users").then((result) => {
        if (active) setUsers(result.users);
      }),
      api<{ workers: Worker[] }>("/api/admin/workers").then((result) => {
        if (active) setWorkers(result.workers);
      }),
    ]).catch((caught: unknown) => {
      if (active) setLookupError(caught instanceof Error ? caught.message : "无法载入筛选项");
    });
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(
    () => Object.values(filter).some((value) => value !== ""),
    [filter],
  );
  const error = audit.error ?? lookupError;

  function update(patch: Partial<AuditFilter>) {
    setFilter((current) => ({ ...current, ...patch }));
  }

  function exportCsv() {
    const csv = auditEventsCsv(audit.events, (event) =>
      describeAuditEvent(event, workspaces, users, true));
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    downloadTextFile(`platform-audit-${stamp}.csv`, csv, "text/csv;charset=utf-8");
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>审计</h1>
          <p>平台登录、用户管理、Worker 与 Workspace 运行状态事件，按时间倒序。</p>
        </div>
        <div className="page-toolbar">
          <button className="secondary" onClick={audit.refresh}>刷新</button>
          <button
            className="secondary"
            disabled={audit.events.length === 0}
            title="导出当前已加载的事件"
            onClick={exportCsv}
          >导出 CSV（{audit.events.length} 条）</button>
        </div>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      <section className="audit-panel" aria-label="平台事件">
        <div className="filter-bar">
          <select aria-label="事件类别" value={filter.category} onChange={(event) => update({ category: event.target.value })}>
            <option value="">全部类别</option>
            {Object.entries(AUDIT_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="按用户筛选" value={filter.userId} onChange={(event) => update({ userId: event.target.value })}>
            <option value="">全部用户</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.username ?? user.email ?? user.id.slice(0, 8)}</option>)}
          </select>
          <select aria-label="按 Workspace 筛选" value={filter.workspaceId} onChange={(event) => update({ workspaceId: event.target.value })}>
            <option value="">全部 Workspace</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}（{workspace.owner.username ?? workspace.owner.email ?? workspace.owner.id.slice(0, 8)}）
              </option>
            ))}
          </select>
          <select aria-label="按 Worker 筛选" value={filter.workerId} onChange={(event) => update({ workerId: event.target.value })}>
            <option value="">全部 Worker</option>
            {workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.id}</option>)}
          </select>
          <label className="date-field">
            <span>从</span>
            <input type="date" value={filter.fromDate} max={filter.toDate || undefined} onChange={(event) => update({ fromDate: event.target.value })} />
          </label>
          <label className="date-field">
            <span>至</span>
            <input type="date" value={filter.toDate} min={filter.fromDate || undefined} onChange={(event) => update({ toDate: event.target.value })} />
          </label>
          {filtered ? <button className="quiet" onClick={() => setFilter(EMPTY_AUDIT_FILTER)}>清除筛选</button> : null}
        </div>
        <AuditEventList
          events={audit.events}
          workspaces={workspaces}
          adminUsers={users}
          isAdmin
          loading={audit.loading}
          loadingMessage="正在载入事件…"
          emptyMessage={filtered ? "没有符合条件的事件。" : "尚无平台事件。"}
        />
        {audit.hasMore && !audit.loading ? (
          <div className="load-more">
            <button className="secondary" disabled={audit.loadingMore} onClick={() => void audit.loadMore()}>
              {audit.loadingMore ? "正在加载…" : "加载更多"}
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}
