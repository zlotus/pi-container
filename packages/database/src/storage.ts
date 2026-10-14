import type { WorkerStorageStatus, WorkspaceDiskUsage } from "@agent-runtime/protocol";
import type { TransactionSql } from "postgres";

import type { DatabaseClient } from "./index.js";
import { mapWorkspace, type WorkspaceRecord, type WorkspaceRow } from "./records.js";

type Transaction = TransactionSql;

export interface StorageAuditMetadata {
  actorUserId: string;
  requestId: string;
  ipAddress: string;
  userAgent: string | null;
}

export type UpdateWorkspaceDiskLimitResult =
  | { outcome: "UPDATED"; workspace: WorkspaceRecord; previousLimitBytes: number }
  | { outcome: "NOT_FOUND" };

/** Per-Worker quota state and per-Workspace disk limits and usage (specs.md Phase 15). */
export function createStorageRepository(database: DatabaseClient) {
  /**
   * Records what a Worker reports about its quota filesystem. A Worker that stops
   * enforcing has already stopped its Workspaces (Phase 15.6), so RUNNING ones become ERROR.
   */
  async function recordWorkerStorageInTransaction(
    transaction: Transaction,
    input: { workerId: string; storage: WorkerStorageStatus; receivedAt: Date },
  ): Promise<void> {
    const rows = await transaction<Array<{ storage_enforced: boolean }>>`
      select storage_enforced from workers where id = ${input.workerId} for update
    `;
    const previous = rows[0];
    if (previous === undefined) return;
    await transaction`
      update workers
      set
        storage_enforced = ${input.storage.enforced},
        storage_fs_type = ${input.storage.fsType},
        storage_total_bytes = ${input.storage.totalBytes},
        storage_free_bytes = ${input.storage.freeBytes},
        storage_checked_at = ${input.receivedAt}
      where id = ${input.workerId}
    `;
    if (previous.storage_enforced !== input.storage.enforced) {
      await transaction`
        insert into platform_audit_events (event_type, worker_id, details)
        values (
          ${input.storage.enforced ? "worker.storage_enforced" : "worker.storage_unenforced"},
          ${input.workerId},
          ${transaction.json({ fsType: input.storage.fsType })}
        )
      `;
    }
    if (!input.storage.enforced) {
      await transaction`
        update workspaces
        set state = 'ERROR', updated_at = now()
        where worker_id = ${input.workerId}
          and state = 'RUNNING'
      `;
    }
  }

  /**
   * Stores usage samples, but only for Workspaces assigned to the reporting Worker.
   * Returns how many samples were ignored because they named someone else's Workspace.
   */
  async function recordWorkspaceDiskUsageInTransaction(
    transaction: Transaction,
    input: { workerId: string; usage: readonly WorkspaceDiskUsage[]; receivedAt: Date },
  ): Promise<number> {
    if (input.usage.length === 0) return 0;
    const ids = input.usage.map((entry) => entry.workspaceId);
    const rows = await transaction<Array<{ id: string }>>`
      update workspaces w
      set
        disk_used_bytes = u.data_used,
        disk_used_inodes = u.data_inodes,
        pi_used_bytes = u.pi_used,
        pi_limit_bytes = u.pi_limit,
        disk_usage_at = ${input.receivedAt}
      from unnest(
        ${ids}::uuid[],
        ${input.usage.map((entry) => entry.dataUsedBytes)}::bigint[],
        ${input.usage.map((entry) => entry.dataUsedInodes)}::bigint[],
        ${input.usage.map((entry) => entry.piUsedBytes)}::bigint[],
        ${input.usage.map((entry) => entry.piLimitBytes)}::bigint[]
      ) as u(id, data_used, data_inodes, pi_used, pi_limit)
      where w.id = u.id and w.worker_id = ${input.workerId}
      returning w.id
    `;
    return input.usage.length - rows.length;
  }

  return {
    recordWorkerStorageInTransaction,
    recordWorkspaceDiskUsageInTransaction,

    async updateWorkspaceDiskLimit(input: {
      workspaceId: string;
      diskLimitBytes: number;
      audit: StorageAuditMetadata;
    }): Promise<UpdateWorkspaceDiskLimitResult> {
      return database.begin(async (transaction) => {
        const previous = await transaction<Array<{ disk_limit_bytes: string }>>`
          select disk_limit_bytes::text from workspaces
          where id = ${input.workspaceId} and state <> 'DELETING'
          for update
        `;
        const before = previous[0];
        if (before === undefined) return { outcome: "NOT_FOUND" as const };
        const rows = await transaction<WorkspaceRow[]>`
          update workspaces
          set disk_limit_bytes = ${input.diskLimitBytes}, updated_at = now()
          where id = ${input.workspaceId}
          returning
            id, user_id, name, worker_id, state, runtime_image,
            created_at, updated_at, last_activity_at,
            disk_limit_bytes::text as disk_limit_bytes, disk_used_bytes::text as disk_used_bytes,
            disk_used_inodes::text as disk_used_inodes, pi_used_bytes::text as pi_used_bytes,
            pi_limit_bytes::text as pi_limit_bytes, disk_usage_at,
          previous_runtime_image, runtime_changed_at, last_access_at, last_stop_reason
        `;
        const row = rows[0];
        if (row === undefined) return { outcome: "NOT_FOUND" as const };
        const { actorUserId, ...request } = input.audit;
        await transaction`
          insert into platform_audit_events (
            event_type, actor_user_id, owner_user_id, workspace_id, worker_id, details
          ) values (
            'workspace.storage_limit_changed',
            ${actorUserId},
            ${row.user_id},
            ${row.id},
            ${row.worker_id},
            ${transaction.json({
              ...request,
              previousLimitBytes: Number(before.disk_limit_bytes),
              limitBytes: input.diskLimitBytes,
            })}
          )
        `;
        return {
          outcome: "UPDATED" as const,
          workspace: mapWorkspace(row),
          previousLimitBytes: Number(before.disk_limit_bytes),
        };
      });
    },
  };
}
