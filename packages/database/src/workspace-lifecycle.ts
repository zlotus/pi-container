import type { DatabaseClient } from "./index.js";
import { mapWorkspace, type WorkspaceRecord, type WorkspaceRow } from "./records.js";

export function createWorkspaceLifecycleRepository(database: DatabaseClient) {
  return {
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
        set
          state = 'STOPPING',
          desired_state = 'STOPPED',
          updated_at = now(),
          last_activity_at = now()
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
        set
          state = 'DELETING',
          desired_state = 'DELETED',
          updated_at = now(),
          last_activity_at = now()
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
