import type { DatabaseClient } from "./index.js";
import type { AuthenticationAuditMetadata } from "./records.js";

export interface PlatformAuditEvent {
  id: string;
  eventType: string;
  actorUserId: string | null;
  ownerUserId: string | null;
  workspaceId: string | null;
  workerId: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export const AUDIT_EVENT_CATEGORIES = [
  "workspace",
  "worker",
  "auth",
  "user",
  "identity",
] as const;

export type AuditEventCategory = (typeof AUDIT_EVENT_CATEGORIES)[number];

/** Optional narrowing filters; they only ever intersect the caller's visibility scope. */
export interface AuditEventFilter {
  category?: AuditEventCategory | null;
  /** Matches either the acting user or the owning/target user. */
  userId?: string | null;
  workspaceId?: string | null;
  workerId?: string | null;
  from?: Date | null;
  to?: Date | null;
}

interface PlatformAuditEventRow {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  owner_user_id: string | null;
  workspace_id: string | null;
  worker_id: string | null;
  details: Record<string, unknown>;
  created_at: Date;
}

function mapAuditEvent(row: PlatformAuditEventRow): PlatformAuditEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    workerId: row.worker_id,
    details: row.details,
    createdAt: row.created_at,
  };
}

export type AuthenticationFailureCategory =
  | "invalid_request"
  | "invalid_credentials"
  | "provider_unavailable"
  | "transaction_invalid"
  | "protocol_validation_failed"
  | "identity_not_bound"
  | "provisioning_not_allowed"
  | "user_disabled";

export function createAuditRepository(database: DatabaseClient) {
  return {
    async recordWorkspaceOpened(input: {
      actorUserId: string;
      ownerUserId: string;
      workspaceId: string;
      workerId: string;
    }): Promise<void> {
      await database`
        insert into platform_audit_events (
          event_type, actor_user_id, owner_user_id, workspace_id, worker_id
        ) values (
          'workspace.opened',
          ${input.actorUserId},
          ${input.ownerUserId},
          ${input.workspaceId},
          ${input.workerId}
        )
      `;
    },

    async listAuditEvents(input: {
      userId: string;
      includeAllUsers: boolean;
      limit: number;
      beforeId: string | null;
      filter?: AuditEventFilter;
    }): Promise<PlatformAuditEvent[]> {
      const filter = input.filter ?? {};
      const typePrefix = filter.category == null ? null : `${filter.category}.%`;
      const userId = filter.userId ?? null;
      const workspaceId = filter.workspaceId ?? null;
      const workerId = filter.workerId ?? null;
      const from = filter.from ?? null;
      const to = filter.to ?? null;
      const filters = database`
        and (${typePrefix}::text is null or event_type like ${typePrefix}::text)
        and (
          ${userId}::uuid is null
          or actor_user_id = ${userId}::uuid
          or owner_user_id = ${userId}::uuid
        )
        and (${workspaceId}::uuid is null or workspace_id = ${workspaceId}::uuid)
        and (${workerId}::text is null or worker_id = ${workerId}::text)
        and (${from}::timestamptz is null or created_at >= ${from}::timestamptz)
        and (${to}::timestamptz is null or created_at < ${to}::timestamptz)
      `;
      const rows = input.includeAllUsers
        ? await database<PlatformAuditEventRow[]>`
            select
              id::text, event_type, actor_user_id, owner_user_id,
              workspace_id, worker_id, details, created_at
            from platform_audit_events
            where (${input.beforeId}::bigint is null or id < ${input.beforeId}::bigint)
              ${filters}
            order by platform_audit_events.id desc
            limit ${input.limit}
          `
        : await database<PlatformAuditEventRow[]>`
            select
              id::text, event_type, actor_user_id, owner_user_id,
              workspace_id, worker_id, details, created_at
            from platform_audit_events
            where owner_user_id = ${input.userId}
              and event_type like 'workspace.%'
              and (${input.beforeId}::bigint is null or id < ${input.beforeId}::bigint)
              ${filters}
            order by platform_audit_events.id desc
            limit ${input.limit}
          `;
      return rows.map(mapAuditEvent);
    },

    async recordAuthenticationFailure(input: {
      category: AuthenticationFailureCategory;
      audit: AuthenticationAuditMetadata;
    }): Promise<void> {
      await database`
        insert into platform_audit_events (event_type, details)
        values (
          'auth.login_failed',
          ${database.json({ ...input.audit, category: input.category })}
        )
      `;
    },
  };
}
