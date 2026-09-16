import type { DatabaseClient } from "./index.js";
import { createPhase6Repository } from "./phase6.js";
import type { WorkerSelector } from "./phase5.js";

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

export function createPhase8Repository(
  database: DatabaseClient,
  selectWorker: WorkerSelector,
) {
  return {
    ...createPhase6Repository(database, selectWorker),

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
    }): Promise<PlatformAuditEvent[]> {
      const rows = input.includeAllUsers
        ? await database<PlatformAuditEventRow[]>`
            select
              id::text, event_type, actor_user_id, owner_user_id,
              workspace_id, worker_id, details, created_at
            from platform_audit_events
            where (${input.beforeId}::bigint is null or id < ${input.beforeId}::bigint)
            order by id desc
            limit ${input.limit}
          `
        : await database<PlatformAuditEventRow[]>`
            select
              id::text, event_type, actor_user_id, owner_user_id,
              workspace_id, worker_id, details, created_at
            from platform_audit_events
            where owner_user_id = ${input.userId}
              and (${input.beforeId}::bigint is null or id < ${input.beforeId}::bigint)
            order by id desc
            limit ${input.limit}
          `;
      return rows.map(mapAuditEvent);
    },
  };
}

export type Phase8Repository = ReturnType<typeof createPhase8Repository>;
