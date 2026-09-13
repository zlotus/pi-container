import type { WorkspaceState } from "@agent-runtime/protocol";

import type { DatabaseClient } from "./index.js";
import { createPhase2Repository } from "./phase2.js";
import type { WorkspaceRecord } from "./phase1.js";

interface WorkspaceRow {
  id: string;
  user_id: string;
  name: string;
  worker_id: string | null;
  state: WorkspaceState;
  runtime_image: string;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
}

function mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    workerId: row.worker_id,
    state: row.state,
    runtimeImage: row.runtime_image,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  };
}

export function createPhase3Repository(database: DatabaseClient) {
  return {
    ...createPhase2Repository(database),

    async markWorkersOffline(cutoff: Date): Promise<number> {
      return database.begin(async (transaction) => {
        const offlineWorkers = await transaction<{ id: string }[]>`
          update workers
          set status = 'OFFLINE', updated_at = now()
          where enabled
            and status = 'ONLINE'
            and (last_heartbeat_at is null or last_heartbeat_at <= ${cutoff})
          returning id
        `;
        for (const worker of offlineWorkers) {
          await transaction`
            update workspaces
            set state = 'WORKER_OFFLINE', updated_at = now()
            where worker_id = ${worker.id}
              and state in ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR')
          `;
        }
        return offlineWorkers.length;
      });
    },

    async listEligibleWorkerIds(input: {
      workspaceId: string;
      userId: string;
      heartbeatCutoff: Date;
    }): Promise<string[]> {
      const rows = await database<Array<{ id: string }>>`
        select workers.id
        from workspaces workspace
        join workers on
          workers.enabled
          and workers.status = 'ONLINE'
          and workers.last_heartbeat_at > ${input.heartbeatCutoff}
          and workers.runtime_image = workspace.runtime_image
          and workers.max_workspaces is not null
          and (
            select count(*)
            from workspaces assigned
            where assigned.worker_id = workers.id
          ) < workers.max_workspaces
          and (
            workspace.required_architecture is null
            or workers.architecture = workspace.required_architecture
          )
          and workers.capabilities @> workspace.required_capabilities
        where workspace.id = ${input.workspaceId}
          and workspace.user_id = ${input.userId}
        order by workers.id asc
      `;
      return rows.map((row) => row.id);
    },

    async listWorkerOfflineWorkspaces(
      workerId: string,
    ): Promise<WorkspaceRecord[]> {
      const rows = await database<WorkspaceRow[]>`
        select
          id, user_id, name, worker_id, state, runtime_image,
          created_at, updated_at, last_activity_at
        from workspaces
        where worker_id = ${workerId}
          and state = 'WORKER_OFFLINE'
        order by id asc
      `;
      return rows.map(mapWorkspace);
    },

    async reconcileWorkerOfflineWorkspace(input: {
      workspaceId: string;
      workerId: string;
      runtimeImage: string;
      state: "RUNNING" | "STOPPED" | "ERROR";
    }): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        update workspaces
        set state = ${input.state}, updated_at = now()
        where id = ${input.workspaceId}
          and worker_id = ${input.workerId}
          and runtime_image = ${input.runtimeImage}
          and state = 'WORKER_OFFLINE'
        returning id
      `;
      return rows.length === 1;
    },

    async beginWorkspaceStart(input: {
      workspaceId: string;
      userId: string;
      workerId: string;
    }): Promise<WorkspaceRecord | null> {
      const rows = await database<WorkspaceRow[]>`
        update workspaces
        set
          worker_id = coalesce(worker_id, ${input.workerId}),
          state = 'STARTING',
          updated_at = now(),
          last_activity_at = now()
        where id = ${input.workspaceId}
          and user_id = ${input.userId}
          and (worker_id is null or worker_id = ${input.workerId})
          and state in ('CREATED', 'STOPPED', 'ERROR', 'WORKER_OFFLINE')
        returning
          id, user_id, name, worker_id, state, runtime_image,
          created_at, updated_at, last_activity_at
      `;
      return rows[0] === undefined ? null : mapWorkspace(rows[0]);
    },

    async finishWorkspaceStart(input: {
      workspaceId: string;
      workerId: string;
    }): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        update workspaces
        set state = 'RUNNING', updated_at = now(), last_activity_at = now()
        where id = ${input.workspaceId}
          and worker_id = ${input.workerId}
          and state = 'STARTING'
        returning id
      `;
      return rows.length === 1;
    },

    async beginWorkspaceStop(input: {
      workspaceId: string;
      userId: string;
      workerId: string;
    }): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        update workspaces
        set state = 'STOPPING', updated_at = now(), last_activity_at = now()
        where id = ${input.workspaceId}
          and user_id = ${input.userId}
          and worker_id = ${input.workerId}
          and state = 'RUNNING'
        returning id
      `;
      return rows.length === 1;
    },

    async finishWorkspaceStop(input: {
      workspaceId: string;
      workerId: string;
    }): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        update workspaces
        set state = 'STOPPED', updated_at = now(), last_activity_at = now()
        where id = ${input.workspaceId}
          and worker_id = ${input.workerId}
          and state = 'STOPPING'
        returning id
      `;
      return rows.length === 1;
    },

    async beginWorkspaceDelete(input: {
      workspaceId: string;
      userId: string;
      workerId: string;
    }): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        update workspaces
        set state = 'DELETING', updated_at = now(), last_activity_at = now()
        where id = ${input.workspaceId}
          and user_id = ${input.userId}
          and worker_id = ${input.workerId}
          and state not in ('STARTING', 'STOPPING', 'DELETING')
        returning id
      `;
      return rows.length === 1;
    },

    async deleteConfirmedWorkspace(input: {
      workspaceId: string;
      userId: string;
      workerId: string;
    }): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        delete from workspaces
        where id = ${input.workspaceId}
          and user_id = ${input.userId}
          and worker_id = ${input.workerId}
          and state = 'DELETING'
        returning id
      `;
      return rows.length === 1;
    },

    async markWorkspaceRuntimeFailure(input: {
      workspaceId: string;
      workerId: string;
      workerOffline: boolean;
    }): Promise<void> {
      await database`
        update workspaces
        set
          state = ${input.workerOffline ? "WORKER_OFFLINE" : "ERROR"},
          updated_at = now()
        where id = ${input.workspaceId}
          and worker_id = ${input.workerId}
          and state in ('STARTING', 'STOPPING', 'DELETING')
      `;
    },
  };
}

export type Phase3Repository = ReturnType<typeof createPhase3Repository>;
