import type { DatabaseClient } from "./index.js";

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
      return database.begin(async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
          update workspaces
          set
            state = 'DELETING',
            desired_state = 'DELETED',
            updated_at = now(),
            last_activity_at = now()
          where id = ${input.workspaceId}
            and user_id = ${input.userId}
            and worker_id = ${input.workerId}
            and state not in ('STARTING', 'STOPPING', 'DELETING', 'UPGRADING')
          returning id
        `;
        if (rows.length !== 1) return false;
        // The model key stops working now, not only once the Worker confirmed the delete.
        await transaction`
          select model_keys_request_revoke(${input.workspaceId}::uuid, null, 'workspace_deleted')
        `;
        return true;
      });
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
          and state in ('STARTING', 'STOPPING', 'DELETING', 'UPGRADING')
      `;
    },
  };
}
