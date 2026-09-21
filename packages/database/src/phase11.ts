import type { DatabaseClient } from "./index.js";
import {
  createPhase10Repository,
  type UserIdentityRecord,
} from "./phase10.js";
import type { UserRole, UserStatus } from "./phase1.js";
import type { WorkerSelector } from "./phase5.js";

export type BindExternalIdentityResult =
  | { outcome: "BOUND"; identity: UserIdentityRecord }
  | { outcome: "USER_NOT_FOUND" }
  | { outcome: "IDENTITY_ALREADY_BOUND" };

export type UnbindExternalIdentityResult =
  | { outcome: "UNBOUND" }
  | { outcome: "USER_NOT_FOUND" }
  | { outcome: "IDENTITY_NOT_FOUND" }
  | { outcome: "LAST_LOGIN_METHOD" };

export type CompleteExternalLoginResult =
  | {
      outcome: "AUTHENTICATED";
      provisioned: boolean;
      user: {
        id: string;
        email: string | null;
        username: string | null;
        role: UserRole;
        status: UserStatus;
        lastLoginAt: Date;
        createdAt: Date;
        updatedAt: Date;
      };
    }
  | { outcome: "UNKNOWN_IDENTITY" }
  | { outcome: "PROVISIONING_NOT_ALLOWED" }
  | { outcome: "USER_DISABLED" };

interface UserIdentityRow {
  id: string;
  user_id: string;
  provider_id: string;
  provider_subject: string;
  username_snapshot: string | null;
  email_snapshot: string | null;
  display_name_snapshot: string | null;
  created_at: Date;
  last_login_at: Date | null;
}

interface ExternalUserRow {
  id: string;
  email: string | null;
  username: string | null;
  password_hash: string | null;
  role: UserRole;
  status: UserStatus;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapIdentity(row: UserIdentityRow): UserIdentityRecord {
  return {
    id: row.id,
    userId: row.user_id,
    providerId: row.provider_id,
    providerSubject: row.provider_subject,
    usernameSnapshot: row.username_snapshot,
    emailSnapshot: row.email_snapshot,
    displayNameSnapshot: row.display_name_snapshot,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

const IDENTITY_COLUMNS = `
  id,
  user_id,
  provider_id,
  provider_subject,
  username_snapshot,
  email_snapshot,
  display_name_snapshot,
  created_at,
  last_login_at
`;

export function createPhase11Repository(
  database: DatabaseClient,
  selectWorker: WorkerSelector,
) {
  const phase10 = createPhase10Repository(database, selectWorker);

  return {
    ...phase10,

    async listUserIdentities(userId: string): Promise<UserIdentityRecord[] | null> {
      return database.begin(async (transaction) => {
        const users = await transaction<{ id: string }[]>`
          select id from users where id = ${userId}
        `;
        if (users.length === 0) return null;
        const rows = await transaction.unsafe<UserIdentityRow[]>(`
          select ${IDENTITY_COLUMNS}
          from user_identities
          where user_id = $1
          order by created_at asc, id asc
        `, [userId]);
        return rows.map(mapIdentity);
      });
    },

    async bindExternalIdentity(input: {
      id: string;
      userId: string;
      providerId: string;
      providerSubject: string;
      actorUserId: string;
    }): Promise<BindExternalIdentityResult> {
      return database.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(708_913_431)`;
        const rows = await transaction<UserIdentityRow[]>`
          insert into user_identities (
            id, user_id, provider_id, provider_subject
          )
          select
            ${input.id}, users.id, ${input.providerId}, ${input.providerSubject}
          from users
          where users.id = ${input.userId}
          on conflict (provider_id, provider_subject) do nothing
          returning
            id, user_id, provider_id, provider_subject, username_snapshot,
            email_snapshot, display_name_snapshot, created_at, last_login_at
        `;
        const identity = rows[0];
        if (identity === undefined) {
          const users = await transaction<{ id: string }[]>`
            select id from users where id = ${input.userId}
          `;
          return users.length === 0
            ? { outcome: "USER_NOT_FOUND" }
            : { outcome: "IDENTITY_ALREADY_BOUND" };
        }
        await transaction`
          insert into platform_audit_events (
            event_type, actor_user_id, owner_user_id, details
          ) values (
            'identity.bound',
            ${input.actorUserId},
            ${input.userId},
            ${transaction.json({
              identityId: identity.id,
              providerId: identity.provider_id,
            })}
          )
        `;
        return { outcome: "BOUND", identity: mapIdentity(identity) };
      });
    },

    async unbindExternalIdentity(input: {
      identityId: string;
      userId: string;
      actorUserId: string;
    }): Promise<UnbindExternalIdentityResult> {
      return database.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(708_913_431)`;
        const users = await transaction<ExternalUserRow[]>`
          select
            id, email, username, password_hash, role, status,
            last_login_at, created_at, updated_at
          from users
          where id = ${input.userId}
          for update
        `;
        const user = users[0];
        if (user === undefined) return { outcome: "USER_NOT_FOUND" };

        const identities = await transaction<UserIdentityRow[]>`
          select
            id, user_id, provider_id, provider_subject, username_snapshot,
            email_snapshot, display_name_snapshot, created_at, last_login_at
          from user_identities
          where user_id = ${input.userId}
          order by created_at asc, id asc
          for update
        `;
        const identity = identities.find((candidate) => candidate.id === input.identityId);
        if (identity === undefined) return { outcome: "IDENTITY_NOT_FOUND" };

        const hasLocalLogin =
          user.password_hash !== null &&
          (user.email !== null || user.username !== null);
        if (!hasLocalLogin && identities.length === 1) {
          return { outcome: "LAST_LOGIN_METHOD" };
        }

        await transaction`
          delete from user_identities
          where id = ${identity.id} and user_id = ${input.userId}
        `;
        await transaction`
          insert into platform_audit_events (
            event_type, actor_user_id, owner_user_id, details
          ) values (
            'identity.unbound',
            ${input.actorUserId},
            ${input.userId},
            ${transaction.json({
              identityId: identity.id,
              providerId: identity.provider_id,
            })}
          )
        `;
        return { outcome: "UNBOUND" };
      });
    },

    async completeExternalLogin(input: {
      providerId: string;
      providerSubject: string;
      usernameSnapshot: string | null;
      emailSnapshot: string | null;
      displayNameSnapshot: string | null;
      autoProvision: boolean;
      provisionedUser:
        | { id: string; email: string | null; username: string | null }
        | null;
      identityId: string;
      sessionId: string;
      tokenHash: string;
      expiresAt: Date;
      authenticatedAt: Date;
    }): Promise<CompleteExternalLoginResult> {
      return database.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(708_913_431)`;
        let provisioned = false;
        let rows = await transaction<ExternalUserRow[]>`
          select
            users.id, users.email, users.username, users.password_hash,
            users.role, users.status, users.last_login_at,
            users.created_at, users.updated_at
          from user_identities identities
          join users on users.id = identities.user_id
          where identities.provider_id = ${input.providerId}
            and identities.provider_subject = ${input.providerSubject}
          for update of identities, users
        `;

        if (rows[0] === undefined) {
          if (!input.autoProvision) return { outcome: "UNKNOWN_IDENTITY" };
          if (input.provisionedUser === null) {
            return { outcome: "PROVISIONING_NOT_ALLOWED" };
          }
          const username =
            input.provisionedUser.username === null
              ? null
              : (await transaction<{ id: string }[]>`
                    select id from users
                    where username = ${input.provisionedUser.username}
                    limit 1
                  `).length === 0
                ? input.provisionedUser.username
                : null;
          rows = await transaction<ExternalUserRow[]>`
            insert into users (
              id, email, username, password_hash, role, status,
              last_login_at, created_at, updated_at
            ) values (
              ${input.provisionedUser.id},
              ${input.provisionedUser.email},
              ${username},
              null,
              'user',
              'active',
              null,
              ${input.authenticatedAt},
              ${input.authenticatedAt}
            )
            returning
              id, email, username, password_hash, role, status,
              last_login_at, created_at, updated_at
          `;
          const createdUser = rows[0];
          if (createdUser === undefined) {
            throw new Error("JIT user insert did not return a row");
          }
          await transaction`
            insert into user_identities (
              id, user_id, provider_id, provider_subject,
              username_snapshot, email_snapshot, display_name_snapshot
            ) values (
              ${input.identityId},
              ${createdUser.id},
              ${input.providerId},
              ${input.providerSubject},
              ${input.usernameSnapshot},
              ${input.emailSnapshot},
              ${input.displayNameSnapshot}
            )
          `;
          provisioned = true;
        }

        const user = rows[0];
        if (user === undefined) throw new Error("external identity has no user");
        if (user.status !== "active") return { outcome: "USER_DISABLED" };

        await transaction`
          insert into user_sessions (id, user_id, token_hash, expires_at)
          values (${input.sessionId}, ${user.id}, ${input.tokenHash}, ${input.expiresAt})
        `;
        await transaction`
          update users
          set last_login_at = ${input.authenticatedAt}, updated_at = ${input.authenticatedAt}
          where id = ${user.id} and status = 'active'
        `;
        await transaction`
          update user_identities
          set
            username_snapshot = ${input.usernameSnapshot},
            email_snapshot = ${input.emailSnapshot},
            display_name_snapshot = ${input.displayNameSnapshot},
            last_login_at = ${input.authenticatedAt}
          where provider_id = ${input.providerId}
            and provider_subject = ${input.providerSubject}
        `;

        return {
          outcome: "AUTHENTICATED",
          provisioned,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
            status: user.status,
            lastLoginAt: input.authenticatedAt,
            createdAt: user.created_at,
            updatedAt: input.authenticatedAt,
          },
        };
      });
    },
  };
}

export type Phase11Repository = ReturnType<typeof createPhase11Repository>;
