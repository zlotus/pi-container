import type { DatabaseClient } from "./index.js";
import {
  mapUser,
  type AuthenticatedSessionRecord,
  type AuthenticationAuditMetadata,
  type UserRecord,
  type UserRole,
  type UserRow,
  type UserStatus,
} from "./records.js";

export interface AdminUserRecord {
  id: string;
  email: string | null;
  username: string | null;
  role: UserRole;
  status: UserStatus;
  source: "local" | "external";
  workspaceCount: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UpdateManagedUserResult =
  | { outcome: "UPDATED"; user: AdminUserRecord }
  | { outcome: "NOT_FOUND" }
  | { outcome: "LAST_ACTIVE_LOCAL_ADMIN" };

interface AdminUserRow {
  id: string;
  email: string | null;
  username: string | null;
  password_hash: string | null;
  role: UserRole;
  status: UserStatus;
  workspace_count: number;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapAdminUser(row: AdminUserRow): AdminUserRecord {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    status: row.status,
    source: row.password_hash === null ? "external" : "local",
    workspaceCount: row.workspace_count,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ADMIN_USER_COLUMNS = `
  users.id,
  users.email,
  users.username,
  users.password_hash,
  users.role,
  users.status,
  users.last_login_at,
  users.created_at,
  users.updated_at,
  count(workspaces.id)::int as workspace_count
`;

export function createUserRepository(database: DatabaseClient) {
  return {
    async findUserByLogin(login: string): Promise<UserRecord | null> {
      const normalized = login.trim().toLowerCase();
      const rows = await database<UserRow[]>`
        select
          id, email, username, password_hash, role, status,
          last_login_at, created_at, updated_at
        from users
        where password_hash is not null
          and (email = ${normalized} or username = ${normalized})
        limit 1
      `;
      const row = rows[0];
      return row === undefined ? null : mapUser(row);
    },

    async createUser(input: {
      id: string;
      email: string;
      username: string | null;
      passwordHash: string;
      role: UserRole;
      actorUserId?: string;
    }): Promise<UserRecord> {
      return database.begin(async (transaction) => {
        const rows = await transaction<UserRow[]>`
          insert into users (id, email, username, password_hash, role)
          values (
            ${input.id},
            ${input.email},
            ${input.username},
            ${input.passwordHash},
            ${input.role}
          )
          returning
            id, email, username, password_hash, role, status,
            last_login_at, created_at, updated_at
        `;
        const row = rows[0];
        if (row === undefined) {
          throw new Error("user insert did not return a row");
        }
        if (input.actorUserId !== undefined) {
          await transaction`
            insert into platform_audit_events (
              event_type, actor_user_id, owner_user_id, details
            ) values (
              'user.created',
              ${input.actorUserId},
              ${input.id},
              ${transaction.json({ source: "local", role: input.role })}
            )
          `;
        }
        return mapUser(row);
      });
    },

    async createSession(input: {
      id: string;
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      audit?: AuthenticationAuditMetadata;
    }): Promise<boolean> {
      return database.begin(async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
          insert into user_sessions (id, user_id, token_hash, expires_at)
          select ${input.id}, id, ${input.tokenHash}, ${input.expiresAt}
          from users
          where id = ${input.userId} and status = 'active'
          returning id
        `;
        if (rows.length === 0) return false;
        await transaction`
          update users
          set last_login_at = now(), updated_at = now()
          where id = ${input.userId} and status = 'active'
        `;
        if (input.audit !== undefined) {
          await transaction`
            insert into platform_audit_events (
              event_type, actor_user_id, owner_user_id, details
            ) values (
              'auth.login_succeeded',
              ${input.userId},
              ${input.userId},
              ${transaction.json({ ...input.audit })}
            )
          `;
        }
        return true;
      });
    },

    async findActiveSession(
      tokenHash: string,
      now: Date,
    ): Promise<AuthenticatedSessionRecord | null> {
      const rows = await database<
        Array<{
          session_id: string;
          expires_at: Date;
          id: string;
          email: string | null;
          username: string | null;
          role: UserRole;
          status: UserStatus;
          last_login_at: Date | null;
          created_at: Date;
          updated_at: Date;
        }>
      >`
        select
          sessions.id as session_id,
          sessions.expires_at,
          users.id,
          users.email,
          users.username,
          users.role,
          users.status,
          users.last_login_at,
          users.created_at,
          users.updated_at
        from user_sessions sessions
        join users on users.id = sessions.user_id
        where sessions.token_hash = ${tokenHash}
          and sessions.revoked_at is null
          and sessions.expires_at > ${now}
          and users.status = 'active'
        limit 1
      `;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        sessionId: row.session_id,
        expiresAt: row.expires_at,
        user: {
          id: row.id,
          email: row.email,
          username: row.username,
          role: row.role,
          status: row.status,
          lastLoginAt: row.last_login_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      };
    },

    async revokeSession(
      tokenHash: string,
      now: Date,
      audit?: AuthenticationAuditMetadata & { actorUserId: string },
    ): Promise<void> {
      await database.begin(async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
          update user_sessions
          set revoked_at = ${now}
          where token_hash = ${tokenHash} and revoked_at is null
          returning id
        `;
        if (rows.length === 1 && audit !== undefined) {
          const { actorUserId, ...details } = audit;
          await transaction`
            insert into platform_audit_events (
              event_type, actor_user_id, owner_user_id, details
            ) values (
              'auth.logout',
              ${actorUserId},
              ${actorUserId},
              ${transaction.json(details)}
            )
          `;
        }
      });
    },

    async listUsers(): Promise<AdminUserRecord[]> {
      const rows = await database.unsafe<AdminUserRow[]>(`
        select ${ADMIN_USER_COLUMNS}
        from users
        left join workspaces on workspaces.user_id = users.id
        group by users.id
        order by users.created_at asc, users.id asc
      `);
      return rows.map(mapAdminUser);
    },

    async updateManagedUser(input: {
      userId: string;
      role?: UserRole;
      status?: UserStatus;
      audit?: AuthenticationAuditMetadata & { actorUserId: string };
    }): Promise<UpdateManagedUserResult> {
      return database.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(708_913_429)`;
        const current = await transaction<
          Array<{ id: string; role: UserRole; status: UserStatus }>
        >`
          select id, role, status
          from users
          where id = ${input.userId}
          for update
        `;
        const target = current[0];
        if (target === undefined) return { outcome: "NOT_FOUND" };
        const role = input.role ?? target.role;
        const status = input.status ?? target.status;

        const removesActiveAdmin =
          target.role === "admin" &&
          target.status === "active" &&
          (role !== "admin" || status !== "active");
        if (removesActiveAdmin) {
          const remaining = await transaction<{ count: number }[]>`
            select count(*)::int as count
            from users
            where id <> ${input.userId}
              and role = 'admin'
              and status = 'active'
              and password_hash is not null
              and (email is not null or username is not null)
          `;
          if ((remaining[0]?.count ?? 0) === 0) {
            return { outcome: "LAST_ACTIVE_LOCAL_ADMIN" };
          }
        }

        const rows = await transaction<AdminUserRow[]>`
          update users
          set role = ${role}, status = ${status}, updated_at = now()
          where id = ${input.userId}
          returning
            id, email, username, password_hash, role, status, last_login_at,
            created_at, updated_at,
            (select count(*)::int from workspaces where user_id = users.id)
              as workspace_count
        `;
        const row = rows[0];
        if (row === undefined) return { outcome: "NOT_FOUND" };
        if (status === "disabled") {
          await transaction`
            update user_sessions
            set revoked_at = now()
            where user_id = ${input.userId} and revoked_at is null
          `;
        }
        if (input.audit !== undefined) {
          const { actorUserId, ...request } = input.audit;
          if (target.status !== status) {
            await transaction`
              insert into platform_audit_events (
                event_type, actor_user_id, owner_user_id, details
              ) values (
                ${status === "active" ? "user.enabled" : "user.disabled"},
                ${actorUserId},
                ${input.userId},
                ${transaction.json({
                  ...request,
                  fromStatus: target.status,
                  toStatus: status,
                })}
              )
            `;
            if (status === "disabled") {
              await transaction`
                insert into platform_audit_events (
                  event_type, actor_user_id, owner_user_id, details
                ) values (
                  'auth.session_revoked',
                  ${actorUserId},
                  ${input.userId},
                  ${transaction.json({ ...request, reason: "user_disabled" })}
                )
              `;
            }
          }
          if (target.role !== role) {
            await transaction`
              insert into platform_audit_events (
                event_type, actor_user_id, owner_user_id, details
              ) values (
                'user.role_changed',
                ${actorUserId},
                ${input.userId},
                ${transaction.json({
                  ...request,
                  fromRole: target.role,
                  toRole: role,
                })}
              )
            `;
          }
        }
        return { outcome: "UPDATED", user: mapAdminUser(row) };
      });
    },

    async resetLocalPassword(input: {
      userId: string;
      passwordHash: string;
      audit?: AuthenticationAuditMetadata & { actorUserId: string };
    }): Promise<boolean> {
      return database.begin(async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
          update users
          set password_hash = ${input.passwordHash}, updated_at = now()
          where id = ${input.userId} and password_hash is not null
          returning id
        `;
        if (rows.length === 1 && input.audit !== undefined) {
          const { actorUserId, ...request } = input.audit;
          await transaction`
            insert into platform_audit_events (
              event_type, actor_user_id, owner_user_id, details
            ) values (
              'user.password_reset',
              ${actorUserId},
              ${input.userId},
              ${transaction.json({ ...request, method: "local" })}
            )
          `;
        }
        return rows.length === 1;
      });
    },

    async revokeUserSessions(
      userId: string,
      revokedAt: Date,
      audit?: AuthenticationAuditMetadata & { actorUserId: string },
    ): Promise<boolean> {
      return database.begin(async (transaction) => {
        const users = await transaction<{ id: string }[]>`
          select id from users where id = ${userId}
        `;
        if (users.length === 0) return false;
        await transaction`
          update user_sessions
          set revoked_at = ${revokedAt}
          where user_id = ${userId} and revoked_at is null
        `;
        if (audit !== undefined) {
          const { actorUserId, ...request } = audit;
          await transaction`
            insert into platform_audit_events (
              event_type, actor_user_id, owner_user_id, details
            ) values (
              'auth.session_revoked',
              ${actorUserId},
              ${userId},
              ${transaction.json({ ...request, reason: "admin_request" })}
            )
          `;
        }
        return true;
      });
    },
  };
}
