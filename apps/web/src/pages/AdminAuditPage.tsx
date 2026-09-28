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
    const result = await api<{ events: AuditEvent[] }>("/api/audit-events?limit=30");
    setEvents(result.events);
  }, []);

  const refreshAuditEvents = useCallback(async () => {
    setError(null);
    try {
      await loadAuditEvents();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load Audit events");
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
        if (active) setError(caught instanceof Error ? caught.message : "Unable to load Audit events");
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
          <p className="eyebrow">ADMIN</p>
          <h1>Audit</h1>
          <p>查看平台最近发生的登录、用户管理和运行状态变更。</p>
        </div>
        <div className="page-toolbar">
          <button className="secondary" onClick={() => void refreshAuditEvents()}>刷新</button>
        </div>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      <section className="audit-panel" aria-labelledby="audit-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">RECENT EVENTS</p>
            <h2 id="audit-title">最近平台事件</h2>
          </div>
        </div>
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
