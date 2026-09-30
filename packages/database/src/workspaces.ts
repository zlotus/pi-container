import type { DatabaseClient } from "./index.js";
import { mapWorkspace, type WorkspaceRecord, type WorkspaceRow } from "./records.js";

/** Read-only Workspace metadata for the admin overview; never includes Runtime content. */
export interface AdminWorkspaceRecord extends WorkspaceRecord {
  ownerUsername: string | null;
  ownerEmail: string | null;
}

export function createWorkspaceRepository(database: DatabaseClient) {
  return {
    async listWorkspaces(userId: string): Promise<WorkspaceRecord[]> {
      const rows = await database<WorkspaceRow[]>`
        select
          id, user_id, name, worker_id, state, runtime_image,
          created_at, updated_at, last_activity_at
        from workspaces
        where user_id = ${userId}
        order by created_at asc, id asc
      `;
      return rows.map(mapWorkspace);
    },

    async createWorkspace(input: {
      id: string;
      userId: string;
      name: string;
      runtimeImage: string;
    }): Promise<WorkspaceRecord> {
      const rows = await database<WorkspaceRow[]>`
        insert into workspaces (id, user_id, name, runtime_image)
        values (${input.id}, ${input.userId}, ${input.name}, ${input.runtimeImage})
        returning
          id, user_id, name, worker_id, state, runtime_image,
          created_at, updated_at, last_activity_at
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new Error("workspace insert did not return a row");
      }
      return mapWorkspace(row);
    },

    async findOwnedWorkspace(
      workspaceId: string,
      userId: string,
    ): Promise<WorkspaceRecord | null> {
      const rows = await database<WorkspaceRow[]>`
        select
          id, user_id, name, worker_id, state, runtime_image,
          created_at, updated_at, last_activity_at
        from workspaces
        where id = ${workspaceId} and user_id = ${userId}
        limit 1
      `;
      const row = rows[0];
      return row === undefined ? null : mapWorkspace(row);
    },

    async deleteOwnedWorkspace(
      workspaceId: string,
      userId: string,
    ): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        delete from workspaces
        where id = ${workspaceId}
          and user_id = ${userId}
          and worker_id is null
          and state = 'CREATED'
        returning id
      `;
      return rows.length === 1;
    },

    async listAllWorkspaces(): Promise<AdminWorkspaceRecord[]> {
      const rows = await database<
        Array<WorkspaceRow & { owner_username: string | null; owner_email: string | null }>
      >`
        select
          workspaces.id, workspaces.user_id, workspaces.name, workspaces.worker_id,
          workspaces.state, workspaces.runtime_image, workspaces.created_at,
          workspaces.updated_at, workspaces.last_activity_at,
          users.username as owner_username, users.email as owner_email
        from workspaces
        join users on users.id = workspaces.user_id
        order by workspaces.created_at desc, workspaces.id asc
      `;
      return rows.map((row) => ({
        ...mapWorkspace(row),
        ownerUsername: row.owner_username,
        ownerEmail: row.owner_email,
      }));
    },

    async listManagedUserWorkspaces(
      userId: string,
    ): Promise<WorkspaceRecord[] | null> {
      return database.begin(async (transaction) => {
        const users = await transaction<{ id: string }[]>`
          select id from users where id = ${userId}
        `;
        if (users.length === 0) return null;
        const rows = await transaction<WorkspaceRow[]>`
          select
            id, user_id, name, worker_id, state, runtime_image,
            created_at, updated_at, last_activity_at
          from workspaces
          where user_id = ${userId}
          order by created_at asc, id asc
        `;
        return rows.map(mapWorkspace);
      });
    },
  };
}
