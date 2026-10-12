import type { WorkspaceDesiredState } from "@agent-runtime/protocol";

import type { DatabaseClient } from "./index.js";
import { mapWorkspace, type WorkspaceRecord, type WorkspaceRow } from "./records.js";

export interface WorkspaceRecoveryRecord extends WorkspaceRecord {
  desiredState: WorkspaceDesiredState;
}

type WorkspaceRecoveryRow = WorkspaceRow & {
  worker_id: string;
  desired_state: WorkspaceDesiredState;
};

function mapRecoveryWorkspace(
  row: WorkspaceRecoveryRow,
): WorkspaceRecoveryRecord {
  return { ...mapWorkspace(row), desiredState: row.desired_state };
}

export function createRecoveryRepository(database: DatabaseClient) {
  return {
    async markAllWorkersOfflineForRecovery(startedAt: Date): Promise<number> {
      return database.begin(async (transaction) => {
        const workers = await transaction<{ id: string }[]>`
          update workers
          set status = case when enabled then 'OFFLINE' else 'DISABLED' end,
              updated_at = now()
          where status = 'ONLINE'
            and (last_heartbeat_at is null or last_heartbeat_at < ${startedAt})
          returning id
        `;
        const workerIds = workers.map((worker) => worker.id);
        if (workerIds.length > 0) {
          await transaction`
            update workspaces
            set state = 'WORKER_OFFLINE', updated_at = now()
            where worker_id = any(${workerIds})
              and state <> 'WORKER_OFFLINE'
          `;
        }
        return workers.length;
      });
    },

    async beginWorkerReconciliation(
      workerId: string,
    ): Promise<WorkspaceRecoveryRecord[]> {
      const rows = await database<WorkspaceRecoveryRow[]>`
        update workspaces
        set state = 'WORKER_OFFLINE', updated_at = now()
        where worker_id = ${workerId}
        returning
          id, user_id, name, worker_id, state, desired_state, runtime_image,
          created_at, updated_at, last_activity_at,
          disk_limit_bytes::text as disk_limit_bytes, disk_used_bytes::text as disk_used_bytes,
          disk_used_inodes::text as disk_used_inodes, pi_used_bytes::text as pi_used_bytes,
          pi_limit_bytes::text as pi_limit_bytes, disk_usage_at,
          previous_runtime_image, runtime_changed_at, last_access_at, last_stop_reason
      `;
      return rows.map(mapRecoveryWorkspace).sort((left, right) =>
        left.id.localeCompare(right.id),
      );
    },

    async reconcileWorkspaceRecovery(input: {
      workspaceId: string;
      workerId: string;
      runtimeImage: string;
      desiredState: WorkspaceDesiredState;
      state: "RUNNING" | "STOPPED" | "ERROR";
    }): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        update workspaces
        set
          state = ${input.state},
          desired_state = case
            when desired_state = 'UNKNOWN'
              and ${input.state} in ('RUNNING', 'STOPPED')
            then ${input.state}
            else desired_state
          end,
          -- A Runtime change interrupted by the disconnect is complete when the Worker
          -- observes the Workspace on its new image (specs.md Phase 18.4).
          runtime_changed_at = case
            when ${input.state} in ('RUNNING', 'STOPPED')
              and previous_runtime_image is not null
              and runtime_changed_at is null
            then now()
            else runtime_changed_at
          end,
          updated_at = now()
        where id = ${input.workspaceId}
          and worker_id = ${input.workerId}
          and runtime_image = ${input.runtimeImage}
          and desired_state = ${input.desiredState}
          and state = 'WORKER_OFFLINE'
        returning id
      `;
      return rows.length === 1;
    },

    async deleteRecoveredWorkspace(input: {
      workspaceId: string;
      userId: string;
      workerId: string;
      runtimeImage: string;
    }): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        delete from workspaces
        where id = ${input.workspaceId}
          and user_id = ${input.userId}
          and worker_id = ${input.workerId}
          and runtime_image = ${input.runtimeImage}
          and desired_state = 'DELETED'
          and state = 'WORKER_OFFLINE'
        returning id
      `;
      return rows.length === 1;
    },
  };
}
