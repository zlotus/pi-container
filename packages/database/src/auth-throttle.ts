import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "./index.js";
import type { AuthenticationAuditMetadata } from "./records.js";

export type AuthThrottleScope = "login_ip" | "ip" | "login" | "sso_start";

/** One counter to consult or bump. `keyHash` is a hex HMAC-SHA256 computed by the Control Plane. */
export interface AuthThrottleKey {
  scope: AuthThrottleScope;
  keyHash: string;
}

export interface AuthThrottlePolicy {
  /** Failures within one window that start a lock. */
  threshold: number;
  windowMs: number;
  lockMs: number;
}

export interface AuthThrottleHit extends AuthThrottleKey {
  policy: AuthThrottlePolicy;
  /** Shown to administrators; only set for scopes that are about an address. */
  ipAddress: string | null;
  /** Shown to administrators when the login matched an existing local User. */
  userId: string | null;
}

export interface AuthThrottleState {
  windowStart: Date;
  failures: number;
  lockedUntil: Date | null;
}

export interface AuthLockRecord {
  id: string;
  scope: AuthThrottleScope;
  ipAddress: string | null;
  userId: string | null;
  userEmail: string | null;
  failures: number;
  lockedUntil: Date;
}

/**
 * The counter transition shared by the SQL upsert and the in-memory test store: a window
 * that ran out, or a lock that expired, starts over; reaching the threshold locks.
 */
export function nextAuthThrottleState(
  previous: AuthThrottleState | null,
  policy: AuthThrottlePolicy,
  now: Date,
): AuthThrottleState {
  const expired =
    previous === null ||
    previous.windowStart.getTime() + policy.windowMs <= now.getTime() ||
    (previous.lockedUntil !== null && previous.lockedUntil <= now);
  const windowStart = expired ? now : previous.windowStart;
  const failures = expired ? 1 : previous.failures + 1;
  const lockedUntil =
    failures >= policy.threshold
      ? new Date(now.getTime() + policy.lockMs)
      : expired
        ? null
        : previous.lockedUntil;
  return { windowStart, failures, lockedUntil };
}

interface AuthLockRow {
  id: string;
  scope: AuthThrottleScope;
  ip_address: string | null;
  user_id: string | null;
  user_email: string | null;
  failures: number;
  locked_until: Date;
}

function mapLock(row: AuthLockRow): AuthLockRecord {
  return {
    id: row.id,
    scope: row.scope,
    ipAddress: row.ip_address,
    userId: row.user_id,
    userEmail: row.user_email,
    failures: row.failures,
    lockedUntil: row.locked_until,
  };
}

export function createAuthThrottleRepository(database: DatabaseClient) {
  return {
    /** The latest lock end among the given counters, or null when none is locked. */
    async findAuthLock(keys: readonly AuthThrottleKey[], now: Date): Promise<Date | null> {
      if (keys.length === 0) return null;
      const scopes = keys.map((key) => key.scope);
      const hashes = keys.map((key) => key.keyHash);
      const rows = await database<{ locked_until: Date | null }[]>`
        select max(t.locked_until) as locked_until
        from auth_throttle t
        join unnest(${scopes}::text[], ${hashes}::text[]) as k(scope, key_hash)
          on t.scope = k.scope and t.key_hash = k.key_hash
        where t.locked_until > ${now}
      `;
      return rows[0]?.locked_until ?? null;
    },

    /**
     * Counts one failure (or one SSO start) on every given counter in a single transaction.
     * A counter that reaches its threshold exactly here records one `auth.login_locked`
     * event; concurrent requests past the threshold extend the lock without another event.
     */
    async recordAuthThrottleHits(input: {
      hits: readonly AuthThrottleHit[];
      now: Date;
      audit: AuthenticationAuditMetadata;
    }): Promise<AuthThrottleScope[]> {
      return database.begin(async (transaction) => {
        const locked: AuthThrottleScope[] = [];
        for (const hit of input.hits) {
          const windowStart = new Date(input.now.getTime() - hit.policy.windowMs);
          const lockedUntil = new Date(input.now.getTime() + hit.policy.lockMs);
          const rows = await transaction<{ failures: number; locked_until: Date | null }[]>`
            insert into auth_throttle (
              id, scope, key_hash, ip_address, user_id, window_start, failures, locked_until
            ) values (
              ${randomUUID()}, ${hit.scope}, ${hit.keyHash}, ${hit.ipAddress}::inet,
              ${hit.userId}, ${input.now}, 1,
              case when 1 >= ${hit.policy.threshold}::int then ${lockedUntil}::timestamptz end
            )
            on conflict (scope, key_hash) do update set
              ip_address = excluded.ip_address,
              user_id = excluded.user_id,
              window_start = case
                when auth_throttle.window_start <= ${windowStart}
                  or auth_throttle.locked_until <= ${input.now}
                then ${input.now}::timestamptz
                else auth_throttle.window_start
              end,
              failures = case
                when auth_throttle.window_start <= ${windowStart}
                  or auth_throttle.locked_until <= ${input.now}
                then 1
                else auth_throttle.failures + 1
              end,
              locked_until = case
                when (
                  case
                    when auth_throttle.window_start <= ${windowStart}
                      or auth_throttle.locked_until <= ${input.now}
                    then 1
                    else auth_throttle.failures + 1
                  end
                ) >= ${hit.policy.threshold}::int
                then ${lockedUntil}::timestamptz
                when auth_throttle.window_start <= ${windowStart}
                  or auth_throttle.locked_until <= ${input.now}
                then null
                else auth_throttle.locked_until
              end
            returning failures, locked_until
          `;
          const row = rows[0];
          if (row !== undefined && row.failures === hit.policy.threshold) {
            locked.push(hit.scope);
            await transaction`
              insert into platform_audit_events (event_type, owner_user_id, details)
              values (
                'auth.login_locked',
                ${hit.userId},
                ${transaction.json({
                  ...input.audit,
                  scope: hit.scope,
                  lockedUntil: (row.locked_until ?? lockedUntil).toISOString(),
                })}
              )
            `;
          }
        }
        return locked;
      });
    },

    /** Forgets counters, e.g. the account+address counter after a successful login. */
    async clearAuthThrottle(keys: readonly AuthThrottleKey[]): Promise<void> {
      if (keys.length === 0) return;
      const scopes = keys.map((key) => key.scope);
      const hashes = keys.map((key) => key.keyHash);
      await database`
        delete from auth_throttle t
        using unnest(${scopes}::text[], ${hashes}::text[]) as k(scope, key_hash)
        where t.scope = k.scope and t.key_hash = k.key_hash
      `;
    },

    async listAuthLocks(now: Date): Promise<AuthLockRecord[]> {
      const rows = await database<AuthLockRow[]>`
        select
          t.id, t.scope, host(t.ip_address) as ip_address, t.user_id,
          u.email as user_email, t.failures, t.locked_until
        from auth_throttle t
        left join users u on u.id = t.user_id
        where t.locked_until > ${now}
        order by t.locked_until desc, t.id
        limit 1000
      `;
      return rows.map(mapLock);
    },

    /** Removes locks and their counters; every removed lock gets an `auth.lock_cleared` event. */
    async clearAuthLocks(input: {
      target:
        | { kind: "id"; id: string }
        | { kind: "user"; userId: string }
        | { kind: "keys"; keys: readonly AuthThrottleKey[] }
        | { kind: "ip"; ipAddress: string }
        | { kind: "all" };
      now: Date;
      source: "admin" | "cli" | "password_reset";
      actorUserId: string | null;
      requestId: string | null;
    }): Promise<number> {
      return database.begin(async (transaction) => {
        const target = input.target;
        const where =
          target.kind === "id"
            ? transaction`t.id = ${target.id}`
            : target.kind === "user"
              ? transaction`t.user_id = ${target.userId}`
              : target.kind === "ip"
                ? transaction`t.ip_address = ${target.ipAddress}::inet`
                : target.kind === "keys"
                  ? transaction`(t.scope, t.key_hash) in (
                      select * from unnest(
                        ${target.keys.map((key) => key.scope)}::text[],
                        ${target.keys.map((key) => key.keyHash)}::text[]
                      )
                    )`
                  : transaction`true`;
        const removed = await transaction<
          { scope: AuthThrottleScope; user_id: string | null; ip_address: string | null; locked: boolean }[]
        >`
          delete from auth_throttle t
          where ${where}
          returning
            t.scope, t.user_id, host(t.ip_address) as ip_address,
            coalesce(t.locked_until > ${input.now}, false) as locked
        `;
        for (const row of removed.filter((entry) => entry.locked)) {
          await transaction`
            insert into platform_audit_events (
              event_type, actor_user_id, owner_user_id, details
            ) values (
              'auth.lock_cleared',
              ${input.actorUserId},
              ${row.user_id},
              ${transaction.json({
                scope: row.scope,
                ipAddress: row.ip_address,
                source: input.source,
                requestId: input.requestId,
              })}
            )
          `;
        }
        return removed.filter((entry) => entry.locked).length;
      });
    },

    /** Drops counters whose window and lock are both over. */
    async deleteExpiredAuthThrottle(now: Date, maxWindowMs: number): Promise<number> {
      const rows = await database<{ id: string }[]>`
        delete from auth_throttle
        where window_start <= ${new Date(now.getTime() - maxWindowMs)}
          and (locked_until is null or locked_until <= ${now})
        returning id
      `;
      return rows.length;
    },
  };
}
