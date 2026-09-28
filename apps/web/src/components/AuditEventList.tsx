import type { AdminUser, AuditEvent, Workspace } from "../types.js";
import { AuditEventRow } from "./AuditEventRow.js";

export function AuditEventList({
  events,
  workspaces,
  adminUsers = [],
  isAdmin,
  loading,
  loadingMessage,
  emptyMessage,
}: {
  events: AuditEvent[];
  workspaces: Workspace[];
  adminUsers?: AdminUser[];
  isAdmin: boolean;
  loading: boolean;
  loadingMessage: string;
  emptyMessage: string;
}) {
  if (loading) return <p className="muted">{loadingMessage}</p>;
  if (events.length === 0) return <p className="muted">{emptyMessage}</p>;

  return (
    <ol className="audit-list">
      {events.map((event) => (
        <AuditEventRow
          key={event.id}
          event={event}
          workspaces={workspaces}
          adminUsers={adminUsers}
          isAdmin={isAdmin}
        />
      ))}
    </ol>
  );
}
