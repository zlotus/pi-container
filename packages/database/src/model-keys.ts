import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "./index.js";

/**
 * Virtual keys of the model gateway (specs.md Phase 16.6). The platform never stores a
 * secret: a row is the record that the gateway was asked for `key_alias`, and whether that
 * key must still be deleted there. Disable and delete paths revoke through database
 * triggers (migration 0012), so no code path can leave a usable key behind.
 */
export type ModelKeyStatus = "issuing" | "active" | "revoking" | "revoked";
export type ModelKeyIssueReason = "start" | "reissue" | "rotation";
export type ModelKeyRevokeReason =
  | "workspace_deleted"
  | "user_disabled"
  | "lost"
  | "admin"
  | "issue_failed";

export interface ModelKeyIssue {
  id: string;
  workspaceId: string;
  userId: string;
  keyAlias: string;
  workerId: string;
}

export type BeginModelKeyIssueResult =
  | { outcome: "ISSUING"; key: ModelKeyIssue }
  | { outcome: "ALREADY_LIVE"; keyAlias: string; status: "issuing" | "active" }
  | { outcome: "USER_DISABLED" | "WORKSPACE_UNAVAILABLE" | "RELAY_DISABLED" };

/** What the Portal shows about platform model access for one Workspace (Phase 16.8). */
export interface WorkspaceModelKeyState {
  workspaceId: string;
  keyStatus: "issuing" | "active" | null;
  relayEnabled: boolean;
}

export interface PendingModelKeyRevocation {
  id: string;
  keyAlias: string;
  userId: string;
  workspaceId: string | null;
  workerId: string | null;
  reason: ModelKeyRevokeReason;
  attempts: number;
}

export interface ModelKeyOverview {
  pendingRevocations: number;
  oldestPendingAt: Date | null;
  lastErrorCode: string | null;
  activeKeys: number;
}

/** Retry delay after `attempts` failed deletions: 30 s doubling, at most 10 minutes. */
export function modelKeyRetryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.min(attempts, 10), 600);
}

export function createModelKeyRepository(database: DatabaseClient) {
  async function requestModelKeyRevoke(input: {
    keyIds?: readonly string[];
    workspaceId?: string;
    userId?: string;
    reason: ModelKeyRevokeReason;
    errorCode?: string | null;
    actorUserId?: string | null;
    requestId?: string | null;
  }): Promise<number> {
    return database.begin(async (transaction) => {
      const rows = await transaction<Array<{ user_id: string; workspace_id: string | null; key_alias: string }>>`
        update model_keys
        set status = 'revoking',
            revoke_reason = ${input.reason},
            revoke_requested_at = now(),
            next_attempt_at = now(),
            last_error_code = ${input.errorCode ?? null}
        where status in ('issuing', 'active')
          and (${input.keyIds === undefined} or id = any(${[...(input.keyIds ?? [])]}::uuid[]))
          and (${input.workspaceId ?? null}::uuid is null or workspace_id = ${input.workspaceId ?? null}::uuid)
          and (${input.userId ?? null}::uuid is null or user_id = ${input.userId ?? null}::uuid)
        returning user_id, workspace_id, key_alias
      `;
      for (const row of rows) {
        await transaction`
          insert into platform_audit_events (event_type, actor_user_id, owner_user_id, workspace_id, details)
          values (
            'model.key_revoke_requested', ${input.actorUserId ?? null}, ${row.user_id}, ${row.workspace_id},
            ${transaction.json({
              keyAlias: row.key_alias,
              reason: input.reason,
              ...(input.requestId == null ? {} : { requestId: input.requestId }),
            })}
          )
        `;
      }
      return rows.length;
    });
  }

  return {
    /**
     * Reserves the next alias for a Workspace. Locks the owner row (as the disable path
     * does) and then the Workspace row (as the delete path does), so a key can never be
     * issued for a user who is being disabled or a Workspace that is being deleted.
     */
    async beginModelKeyIssue(input: {
      workspaceId: string;
      issueReason: ModelKeyIssueReason;
    }): Promise<BeginModelKeyIssueResult> {
      return database.begin(async (transaction) => {
        const owners = await transaction<Array<{ user_id: string; status: string }>>`
          select users.id as user_id, users.status
          from users
          join workspaces on workspaces.user_id = users.id
          where workspaces.id = ${input.workspaceId}
          for share of users
        `;
        const owner = owners[0];
        if (owner === undefined) return { outcome: "WORKSPACE_UNAVAILABLE" };
        if (owner.status !== "active") return { outcome: "USER_DISABLED" };
        const workspaces = await transaction<Array<{ worker_id: string | null; state: string }>>`
          select worker_id, state from workspaces
          where id = ${input.workspaceId}
          for share
        `;
        const workspace = workspaces[0];
        if (
          workspace === undefined ||
          workspace.worker_id === null ||
          workspace.state === "DELETING"
        ) {
          return { outcome: "WORKSPACE_UNAVAILABLE" };
        }
        // A key for a Worker without a relay could never be used; do not create one.
        const relays = await transaction<Array<{ model_relay_enabled: boolean }>>`
          select model_relay_enabled from workers where id = ${workspace.worker_id}
        `;
        if (relays[0]?.model_relay_enabled !== true) return { outcome: "RELAY_DISABLED" };
        const live = await transaction<Array<{ key_alias: string; status: "issuing" | "active" }>>`
          select key_alias, status from model_keys
          where workspace_id = ${input.workspaceId} and status in ('issuing', 'active')
        `;
        if (live[0] !== undefined) {
          return { outcome: "ALREADY_LIVE", keyAlias: live[0].key_alias, status: live[0].status };
        }
        const sequence = await transaction<Array<{ next: number }>>`
          select coalesce(max(substring(key_alias from '-([0-9]+)$')::int), 0) + 1 as next
          from model_keys
          where key_alias like ${`arw-${input.workspaceId}-%`}
        `;
        const keyAlias = `arw-${input.workspaceId}-${sequence[0]?.next ?? 1}`;
        const id = randomUUID();
        // A concurrent issue for the same Workspace wins the unique index; report it.
        const inserted = await transaction<Array<{ id: string }>>`
          insert into model_keys (id, workspace_id, user_id, key_alias, status, issue_reason)
          values (${id}, ${input.workspaceId}, ${owner.user_id}, ${keyAlias}, 'issuing', ${input.issueReason})
          on conflict do nothing
          returning id
        `;
        if (inserted.length === 0) {
          const winner = await transaction<Array<{ key_alias: string; status: "issuing" | "active" }>>`
            select key_alias, status from model_keys
            where workspace_id = ${input.workspaceId} and status in ('issuing', 'active')
          `;
          return winner[0] === undefined
            ? { outcome: "WORKSPACE_UNAVAILABLE" }
            : { outcome: "ALREADY_LIVE", keyAlias: winner[0].key_alias, status: winner[0].status };
        }
        return {
          outcome: "ISSUING",
          key: {
            id,
            workspaceId: input.workspaceId,
            userId: owner.user_id,
            keyAlias,
            workerId: workspace.worker_id,
          },
        };
      });
    },

    /**
     * The gateway created the key. False when the row was revoked meanwhile (the user was
     * disabled or the Workspace deleted while the gateway call was in flight): the caller
     * must not hand the secret to the Worker, and the pending revocation deletes the key.
     */
    async activateModelKey(id: string): Promise<boolean> {
      const rows = await database<Array<{ workspace_id: string; user_id: string; key_alias: string; issue_reason: string }>>`
        update model_keys set status = 'active'
        where id = ${id} and status = 'issuing'
        returning workspace_id, user_id, key_alias, issue_reason
      `;
      const row = rows[0];
      if (row === undefined) return false;
      await database`
        insert into platform_audit_events (event_type, owner_user_id, workspace_id, details)
        values (
          'model.key_issued', ${row.user_id}, ${row.workspace_id},
          ${database.json({ keyAlias: row.key_alias, reason: row.issue_reason })}
        )
      `;
      return true;
    },

    /** Starts revoking the given live keys (issue failure, a lost key, admin rotation). */
    requestModelKeyRevoke,

    async listDueModelKeyRevocations(now: Date, limit = 50): Promise<PendingModelKeyRevocation[]> {
      const rows = await database<Array<{
        id: string;
        key_alias: string;
        user_id: string;
        workspace_id: string | null;
        worker_id: string | null;
        revoke_reason: ModelKeyRevokeReason;
        revoke_attempts: number;
      }>>`
        select model_keys.id, model_keys.key_alias, model_keys.user_id, model_keys.workspace_id,
               workspaces.worker_id, model_keys.revoke_reason, model_keys.revoke_attempts
        from model_keys
        left join workspaces on workspaces.id = model_keys.workspace_id
        where model_keys.status = 'revoking' and model_keys.next_attempt_at <= ${now}
        order by model_keys.next_attempt_at
        limit ${limit}
      `;
      return rows.map((row) => ({
        id: row.id,
        keyAlias: row.key_alias,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        workerId: row.worker_id,
        reason: row.revoke_reason,
        attempts: row.revoke_attempts,
      }));
    },

    /** Only a confirmed gateway deletion makes a key `revoked` (specs.md Phase 16.6). */
    async recordModelKeyRevokeResult(
      id: string,
      result: { ok: true } | { ok: false; errorCode: string },
    ): Promise<void> {
      if (result.ok) {
        const rows = await database<Array<{ user_id: string; workspace_id: string | null; key_alias: string; revoke_reason: string }>>`
          update model_keys
          set status = 'revoked', revoked_at = now(), next_attempt_at = null, last_error_code = null
          where id = ${id} and status = 'revoking'
          returning user_id, workspace_id, key_alias, revoke_reason
        `;
        const row = rows[0];
        if (row === undefined) return;
        await database`
          insert into platform_audit_events (event_type, owner_user_id, workspace_id, details)
          values (
            'model.key_revoked', ${row.user_id}, ${row.workspace_id},
            ${database.json({ keyAlias: row.key_alias, reason: row.revoke_reason })}
          )
        `;
        return;
      }
      await database`
        update model_keys
        set revoke_attempts = revoke_attempts + 1,
            next_attempt_at = now() + make_interval(secs => least(30 * power(2, least(revoke_attempts, 10)), 600)),
            last_error_code = ${result.errorCode}
        where id = ${id} and status = 'revoking'
      `;
    },

    async findLiveModelKey(
      workspaceId: string,
    ): Promise<{ id: string; keyAlias: string; status: "issuing" | "active" } | null> {
      const rows = await database<Array<{ id: string; key_alias: string; status: "issuing" | "active" }>>`
        select id, key_alias, status from model_keys
        where workspace_id = ${workspaceId} and status in ('issuing', 'active')
      `;
      const row = rows[0];
      return row === undefined ? null : { id: row.id, keyAlias: row.key_alias, status: row.status };
    },

    /** Active keys of the Workspaces currently assigned to a Worker, by Workspace. */
    async listActiveModelKeysForWorker(
      workerId: string,
    ): Promise<Array<{ id: string; workspaceId: string; keyAlias: string }>> {
      const rows = await database<Array<{ id: string; workspace_id: string; key_alias: string }>>`
        select model_keys.id, model_keys.workspace_id, model_keys.key_alias
        from model_keys
        join workspaces on workspaces.id = model_keys.workspace_id
        where model_keys.status = 'active' and workspaces.worker_id = ${workerId}
      `;
      return rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, keyAlias: row.key_alias }));
    },

    /**
     * Running Workspaces of active users on online Workers with a listening relay that have
     * no live key: the background loop issues one (gateway was down, user re-enabled).
     */
    async listWorkspacesNeedingModelKey(limit = 20): Promise<Array<{ workspaceId: string; workerId: string }>> {
      const rows = await database<Array<{ id: string; worker_id: string }>>`
        select workspaces.id, workspaces.worker_id
        from workspaces
        join users on users.id = workspaces.user_id
        join workers on workers.id = workspaces.worker_id
        where workspaces.state = 'RUNNING'
          and users.status = 'active'
          and workers.status = 'ONLINE'
          and workers.enabled
          and workers.model_relay_enabled
          and workers.model_relay_listening
          and not exists (
            select 1 from model_keys
            where model_keys.workspace_id = workspaces.id
              and model_keys.status in ('issuing', 'active')
          )
        order by workspaces.updated_at
        limit ${limit}
      `;
      return rows.map((row) => ({ workspaceId: row.id, workerId: row.worker_id }));
    },

    /** Issuing rows a crash left behind: revoke them, the gateway may hold the key. */
    async expireStaleModelKeyIssues(olderThan: Date): Promise<number> {
      const rows = await database<Array<{ id: string }>>`
        select id from model_keys where status = 'issuing' and created_at < ${olderThan}
      `;
      if (rows.length === 0) return 0;
      return requestModelKeyRevoke({
        keyIds: rows.map((row) => row.id),
        reason: "issue_failed",
        errorCode: "ISSUE_INTERRUPTED",
      });
    },

    async listWorkspaceModelKeyStates(workspaceIds: readonly string[]): Promise<WorkspaceModelKeyState[]> {
      if (workspaceIds.length === 0) return [];
      const rows = await database<Array<{ id: string; key_status: "issuing" | "active" | null; relay: boolean | null }>>`
        select workspaces.id,
               (select status from model_keys
                 where model_keys.workspace_id = workspaces.id and status in ('issuing', 'active')) as key_status,
               workers.model_relay_enabled as relay
        from workspaces
        left join workers on workers.id = workspaces.worker_id
        where workspaces.id = any(${[...workspaceIds]}::uuid[])
      `;
      return rows.map((row) => ({ workspaceId: row.id, keyStatus: row.key_status, relayEnabled: row.relay === true }));
    },

    async modelKeyOverview(): Promise<ModelKeyOverview> {
      const rows = await database<Array<{
        pending: number;
        oldest: Date | null;
        active: number;
        last_error: string | null;
      }>>`
        select
          count(*) filter (where status = 'revoking')::int as pending,
          min(revoke_requested_at) filter (where status = 'revoking') as oldest,
          count(*) filter (where status = 'active')::int as active,
          (select last_error_code from model_keys
             where status = 'revoking' and last_error_code is not null
             order by next_attempt_at desc limit 1) as last_error
        from model_keys
      `;
      const row = rows[0];
      return {
        pendingRevocations: row?.pending ?? 0,
        oldestPendingAt: row?.oldest ?? null,
        lastErrorCode: row?.last_error ?? null,
        activeKeys: row?.active ?? 0,
      };
    },

    async findUserModelBudget(userId: string): Promise<{ found: boolean; budgetUsd: number | null }> {
      const rows = await database<Array<{ model_budget_usd: string | null }>>`
        select model_budget_usd::text as model_budget_usd from users where id = ${userId}
      `;
      const row = rows[0];
      if (row === undefined) return { found: false, budgetUsd: null };
      return { found: true, budgetUsd: row.model_budget_usd === null ? null : Number(row.model_budget_usd) };
    },

    async setUserModelBudget(input: {
      userId: string;
      budgetUsd: number | null;
      actorUserId: string;
      requestId: string;
    }): Promise<{ found: boolean; previousUsd: number | null }> {
      return database.begin(async (transaction) => {
        const current = await transaction<Array<{ model_budget_usd: string | null }>>`
          select model_budget_usd::text as model_budget_usd from users where id = ${input.userId} for update
        `;
        const row = current[0];
        if (row === undefined) return { found: false, previousUsd: null };
        const previousUsd = row.model_budget_usd === null ? null : Number(row.model_budget_usd);
        await transaction`
          update users set model_budget_usd = ${input.budgetUsd}, updated_at = now()
          where id = ${input.userId}
        `;
        await transaction`
          insert into platform_audit_events (event_type, actor_user_id, owner_user_id, details)
          values (
            'model.budget_changed', ${input.actorUserId}, ${input.userId},
            ${transaction.json({ fromUsd: previousUsd, toUsd: input.budgetUsd, requestId: input.requestId })}
          )
        `;
        return { found: true, previousUsd };
      });
    },
  };
}
