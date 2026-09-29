import { useCallback, useEffect, useState } from "react";

import { api } from "../api.js";
import { AuditEventList } from "../components/AuditEventList.js";
import type { AdminUser, AuditEvent, Workspace } from "../types.js";

export function AdminAuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAuditEvents = useCallback(async () => {
    const result = await api<{ events: AuditEvent[] }>("/api/audit-events?limit=50");
    setEvents(result.events);
  }, []);

  const refreshAuditEvents = useCallback(async () => {
    setError(null);
    try {
      await loadAuditEvents();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法载入事件");
    }
  }, [loadAuditEvents]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadAuditEvents(),
      api<{ workspaces: Workspace[] }>("/api/workspaces").then((result) => setWorkspaces(result.workspaces)),
      api<{ users: AdminUser[] }>("/api/admin/users").then((result) => setUsers(result.users)),
    ])
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "无法载入事件");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadAuditEvents]);

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>审计</h1>
          <p>平台最近 50 条登录、用户管理和运行状态事件。</p>
        </div>
        <div className="page-toolbar">
          <button className="secondary" onClick={() => void refreshAuditEvents()}>刷新</button>
        </div>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      <section className="audit-panel" aria-label="最近平台事件">
        <AuditEventList
          events={events}
          workspaces={workspaces}
          adminUsers={users}
          isAdmin
          loading={loading}
          loadingMessage="正在载入事件…"
          emptyMessage="尚无平台事件。"
        />
      </section>
    </>
  );
}
