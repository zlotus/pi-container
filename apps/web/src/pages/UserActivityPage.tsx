import { useCallback, useEffect, useState } from "react";

import { api } from "../api.js";
import { AuditEventList } from "../components/AuditEventList.js";
import type { AuditEvent, Workspace } from "../types.js";

export function UserActivityPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    const result = await api<{ events: AuditEvent[] }>("/api/audit-events?limit=50");
    setEvents(result.events);
  }, []);

  const refreshEvents = useCallback(async () => {
    setError(null);
    try {
      await loadEvents();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法载入事件");
    }
  }, [loadEvents]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadEvents(),
      api<{ workspaces: Workspace[] }>("/api/workspaces")
        .then((result) => setWorkspaces(result.workspaces)),
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
  }, [loadEvents]);

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>活动</h1>
          <p>你的 Workspace 最近 50 条状态变化和操作记录。</p>
        </div>
        <button className="secondary" onClick={() => void refreshEvents()}>刷新</button>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      <section className="audit-panel" aria-label="最近活动">
        <AuditEventList
          events={events}
          workspaces={workspaces}
          isAdmin={false}
          loading={loading}
          loadingMessage="正在载入活动…"
          emptyMessage="你的 Workspace 暂无活动记录。"
        />
      </section>
    </>
  );
}
