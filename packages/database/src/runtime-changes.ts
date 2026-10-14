import type { DatabaseClient } from "./index.js";

/** Why a Runtime change was requested (specs.md Phase 18.4). */
export type RuntimeChangeDirection = "upgrade" | "rollback" | "retry" | "admin";

/** What a Workspace's Runtime fields were before a change, to restore on a clean refusal. */
export interface RuntimeChangeRestore {
  runtimeImage: string;
  previousRuntimeImage: string | null;
  runtimeChangedAt: Date | null;
  state: "STOPPED" | "ERROR";
}

/**
 * A Runtime change is persisted as intent before the Worker command (state UPGRADING,
 * `runtime_image` = target, `previous_runtime_image` = source, `runtime_changed_at` null)
 * and completed, reverted or failed afterwards. An interrupted change is ERROR with a
 * previous image and no completion time; it can be retried or rolled back.
 */
export function createRuntimeChangeRepository(database: DatabaseClient) {
  return {
    async beginWorkspaceRuntimeChange(input: {
      workspaceId: string;
      workerId: string;
      fromImage: string;
      toImage: string;
      direction: RuntimeChangeDirection;
      actorUserId: string;
    }): Promise<boolean> {
      return database.begin(async (transaction) => {
        const rows = await transaction<Array<{ user_id: string }>>`
          update workspaces
          set
            state = 'UPGRADING',
            runtime_image = ${input.toImage},
            previous_runtime_image = ${input.fromImage},
            runtime_changed_at = null,
            updated_at = now()
          where id = ${input.workspaceId}
            and worker_id = ${input.workerId}
            and desired_state = 'STOPPED'
            and (
              (state = 'STOPPED' and runtime_image = ${input.fromImage})
              or (
                state = 'ERROR'
                and previous_runtime_image is not null
                and runtime_changed_at is null
                and runtime_image in (${input.fromImage}, ${input.toImage})
                and previous_runtime_image in (${input.fromImage}, ${input.toImage})
              )
            )
          returning user_id
        `;
        const row = rows[0];
        if (row === undefined) return false;
        await transaction`
          insert into platform_audit_events (
            event_type, actor_user_id, owner_user_id, workspace_id, worker_id, details
          ) values (
            'workspace.runtime_change_requested', ${input.actorUserId}, ${row.user_id},
            ${input.workspaceId}, ${input.workerId},
            ${transaction.json({
              fromImage: input.fromImage,
              toImage: input.toImage,
              direction: input.direction,
            })}
          )
        `;
        return true;
      });
    },

    async finishWorkspaceRuntimeChange(input: {
      workspaceId: string;
      workerId: string;
      toImage: string;
      actorUserId: string;
    }): Promise<boolean> {
      return database.begin(async (transaction) => {
        const rows = await transaction<Array<{ user_id: string; previous_runtime_image: string }>>`
          update workspaces
          set state = 'STOPPED', runtime_changed_at = now(), updated_at = now()
          where id = ${input.workspaceId}
            and worker_id = ${input.workerId}
            and state = 'UPGRADING'
            and runtime_image = ${input.toImage}
          returning user_id, previous_runtime_image
        `;
        const row = rows[0];
        if (row === undefined) return false;
        await transaction`
          insert into platform_audit_events (
            event_type, actor_user_id, owner_user_id, workspace_id, worker_id, details
          ) values (
            'workspace.runtime_changed', ${input.actorUserId}, ${row.user_id},
            ${input.workspaceId}, ${input.workerId},
            ${transaction.json({ fromImage: row.previous_runtime_image, toImage: input.toImage })}
          )
        `;
        return true;
      });
    },

    /** The Worker refused before changing anything: the Workspace is as it was. */
    async revertWorkspaceRuntimeChange(input: {
      workspaceId: string;
      workerId: string;
      restore: RuntimeChangeRestore;
      code: string;
      actorUserId: string;
    }): Promise<boolean> {
      return database.begin(async (transaction) => {
        const rows = await transaction<Array<{ user_id: string }>>`
          update workspaces
          set
            state = ${input.restore.state},
            runtime_image = ${input.restore.runtimeImage},
            previous_runtime_image = ${input.restore.previousRuntimeImage},
            runtime_changed_at = ${input.restore.runtimeChangedAt},
            updated_at = now()
          where id = ${input.workspaceId}
            and worker_id = ${input.workerId}
            and state = 'UPGRADING'
          returning user_id
        `;
        const row = rows[0];
        if (row === undefined) return false;
        await transaction`
          insert into platform_audit_events (
            event_type, actor_user_id, owner_user_id, workspace_id, worker_id, details
          ) values (
            'workspace.runtime_change_reverted', ${input.actorUserId}, ${row.user_id},
            ${input.workspaceId}, ${input.workerId},
            ${transaction.json({ runtimeImage: input.restore.runtimeImage, code: input.code })}
          )
        `;
        return true;
      });
    },
  };
}
