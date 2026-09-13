import type {
  WorkspaceDesiredState,
  WorkspaceState,
} from "@agent-runtime/protocol";

import type { DatabaseClient } from "./index.js";
import type { WorkspaceRecord } from "./phase1.js";
import { createPhase5Repository, type WorkerSelector } from "./phase5.js";

export interface WorkspaceRecoveryRecord extends WorkspaceRecord {
  desiredState: WorkspaceDesiredState;
}

interface WorkspaceRecoveryRow {
  id: string;
  user_id: string;
  name: string;
  worker_id: string;
  state: WorkspaceState;
  desired_state: WorkspaceDesiredState;
  runtime_image: string;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
}

function mapRecoveryWorkspace(
  row: WorkspaceRecoveryRow,
): WorkspaceRecoveryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    workerId: row.worker_id,
    state: row.state,
    desiredState: row.desired_state,
    runtimeImage: row.runtime_image,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  };
}

export function createPhase6Repository(
  database: DatabaseClient,
  selectWorker: WorkerSelector,
) {
  return {
    ...createPhase5Repository(database, selectWorker),

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
          created_at, updated_at, last_activity_at
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

export type Phase6Repository = ReturnType<typeof createPhase6Repository>;
