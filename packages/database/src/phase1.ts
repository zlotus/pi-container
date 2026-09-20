import type { DatabaseClient } from "./index.js";

export type UserRole = "user" | "admin";
export type UserStatus = "active" | "disabled";

export interface UserRecord {
  id: string;
  email: string;
  username: string | null;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticatedSessionRecord {
  sessionId: string;
  expiresAt: Date;
  user: Omit<UserRecord, "passwordHash">;
}

export interface WorkspaceRecord {
  id: string;
  userId: string;
  name: string;
  workerId: string | null;
  state:
    | "CREATED"
    | "SCHEDULING"
    | "STARTING"
    | "RUNNING"
    | "STOPPING"
    | "STOPPED"
    | "DELETING"
    | "ERROR"
    | "WORKER_OFFLINE";
  runtimeImage: string;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  username: string | null;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
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

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
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

export function createPhase1Repository(database: DatabaseClient) {
  return {
    async findUserByLogin(login: string): Promise<UserRecord | null> {
      const normalized = login.trim().toLowerCase();
      const rows = await database<UserRow[]>`
        select
          id, email, username, password_hash, role, status,
          last_login_at, created_at, updated_at
        from users
        where email = ${normalized} or username = ${normalized}
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
    }): Promise<UserRecord> {
      const rows = await database<UserRow[]>`
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
      return mapUser(row);
    },

    async createSession(input: {
      id: string;
      userId: string;
      tokenHash: string;
      expiresAt: Date;
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
          email: string;
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

    async revokeSession(tokenHash: string, now: Date): Promise<void> {
      await database`
        update user_sessions
        set revoked_at = ${now}
        where token_hash = ${tokenHash} and revoked_at is null
      `;
    },

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
  };
}

export type Phase1Repository = ReturnType<typeof createPhase1Repository>;
