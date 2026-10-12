import type { DatabaseClient } from "./index.js";

/** A running Workspace old enough, by the database's records, to be considered idle. */
export interface IdleStopCandidate {
  workspaceId: string;
  userId: string;
  workerId: string;
  runtimeImage: string;
  lastAccessAt: Date | null;
}

/**
 * Idle stop bookkeeping (specs.md Phase 18.5). The database holds the last Gateway access
 * (written at most once a minute per Workspace) and the start of the current run; the
 * Control Plane checks live connections and CPU activity itself.
 */
export function createIdleRepository(database: DatabaseClient) {
  return {
    /** Moves `last_access_at` forward only; older writes never move it back. */
    async recordWorkspaceAccess(entries: ReadonlyArray<{ workspaceId: string; at: Date }>): Promise<void> {
      if (entries.length === 0) return;
      const ids = entries.map((entry) => entry.workspaceId);
      const times = entries.map((entry) => entry.at.toISOString());
      await database`
        update workspaces
        set last_access_at = greatest(coalesce(workspaces.last_access_at, '-infinity'), access.at)
        from unnest(${ids}::uuid[], ${times}::timestamptz[]) as access(id, at)
        where workspaces.id = access.id
      `;
    },

    async listIdleStopCandidates(input: { cutoff: Date; limit: number }): Promise<IdleStopCandidate[]> {
      const rows = await database<
        Array<{
          id: string;
          user_id: string;
          worker_id: string;
          runtime_image: string;
          last_access_at: Date | null;
        }>
      >`
        select w.id, w.user_id, w.worker_id, w.runtime_image, w.last_access_at
        from workspaces w
        join workers on workers.id = w.worker_id and workers.enabled and workers.status = 'ONLINE'
        where w.state = 'RUNNING'
          and w.desired_state = 'RUNNING'
          and w.last_activity_at <= ${input.cutoff}
          and coalesce(w.last_access_at, '-infinity') <= ${input.cutoff}
        order by coalesce(w.last_access_at, w.last_activity_at) asc, w.id asc
        limit ${input.limit}
      `;
      return rows.map((row) => ({
        workspaceId: row.id,
        userId: row.user_id,
        workerId: row.worker_id,
        runtimeImage: row.runtime_image,
        lastAccessAt: row.last_access_at,
      }));
    },

    /**
     * Starts an idle stop only if the Workspace is still running, still meant to run and
     * still not accessed since the cutoff; an access racing with the sweep wins.
     */
    async beginIdleStop(input: {
      workspaceId: string;
      workerId: string;
      cutoff: Date;
      idleAfterHours: number;
      cpuThresholdCores: number;
    }): Promise<boolean> {
      return database.begin(async (transaction) => {
        const rows = await transaction<Array<{ user_id: string; last_access_at: Date | null }>>`
          update workspaces
          set
            state = 'STOPPING',
            desired_state = 'STOPPED',
            last_stop_reason = 'idle',
            updated_at = now(),
            last_activity_at = now()
          where id = ${input.workspaceId}
            and worker_id = ${input.workerId}
            and state = 'RUNNING'
            and desired_state = 'RUNNING'
            and last_activity_at <= ${input.cutoff}
            and coalesce(last_access_at, '-infinity') <= ${input.cutoff}
          returning user_id, last_access_at
        `;
        const row = rows[0];
        if (row === undefined) return false;
        await transaction`
          insert into platform_audit_events (event_type, owner_user_id, workspace_id, worker_id, details)
          values (
            'workspace.idle_stopped', ${row.user_id}, ${input.workspaceId}, ${input.workerId},
            ${transaction.json({
              idleAfterHours: input.idleAfterHours,
              cpuThresholdCores: input.cpuThresholdCores,
              lastAccessAt: row.last_access_at?.toISOString() ?? null,
            })}
          )
        `;
        return true;
      });
    },
  };
}
