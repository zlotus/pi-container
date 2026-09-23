import type { DatabaseClient } from "./index.js";
import {
  createPhase8Repository,
  type Phase8Repository,
} from "./phase8.js";
import type {
  AuthenticationAuditMetadata,
  UserRole,
  UserStatus,
  WorkspaceRecord,
} from "./phase1.js";
import type { WorkerSelector } from "./phase5.js";

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

interface WorkspaceRow {
  id: string;
  user_id: string;
  name: string;
  worker_id: string | null;
  state: WorkspaceRecord["state"];
  runtime_image: string;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
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

export function createPhase9Repository(
  database: DatabaseClient,
  selectWorker: WorkerSelector,
) {
  const phase8: Phase8Repository = createPhase8Repository(database, selectWorker);

  return {
    ...phase8,

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

export type Phase9Repository = ReturnType<typeof createPhase9Repository>;
