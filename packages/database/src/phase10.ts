import type { DatabaseClient } from "./index.js";
import {
  createPhase9Repository,
  type Phase9Repository,
} from "./phase9.js";
import type { UserRole, UserStatus } from "./phase1.js";
import type { WorkerSelector } from "./phase5.js";

export interface UserIdentityRecord {
  id: string;
  userId: string;
  providerId: string;
  providerSubject: string;
  usernameSnapshot: string | null;
  emailSnapshot: string | null;
  displayNameSnapshot: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export type BindUserIdentityResult =
  | { outcome: "BOUND"; identity: UserIdentityRecord }
  | { outcome: "USER_NOT_FOUND" }
  | { outcome: "IDENTITY_ALREADY_BOUND" };

export type CompleteOidcLoginResult =
  | {
      outcome: "AUTHENTICATED";
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

interface OidcUserRow {
  id: string;
  email: string | null;
  username: string | null;
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

export function createPhase10Repository(
  database: DatabaseClient,
  selectWorker: WorkerSelector,
) {
  const phase9: Phase9Repository = createPhase9Repository(database, selectWorker);

  return {
    ...phase9,

    async bindUserIdentity(input: {
      id: string;
      userId: string;
      providerId: string;
      providerSubject: string;
    }): Promise<BindUserIdentityResult> {
      return database.begin(async (transaction) => {
        const rows = await transaction<UserIdentityRow[]>`
          insert into user_identities (
            id,
            user_id,
            provider_id,
            provider_subject
          )
          select
            ${input.id},
            users.id,
            ${input.providerId},
            ${input.providerSubject}
          from users
          where users.id = ${input.userId}
          on conflict (provider_id, provider_subject) do nothing
          returning
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
        const identity = rows[0];
        if (identity !== undefined) {
          return { outcome: "BOUND", identity: mapIdentity(identity) };
        }

        const users = await transaction<{ id: string }[]>`
          select id from users where id = ${input.userId}
        `;
        return users.length === 0
          ? { outcome: "USER_NOT_FOUND" }
          : { outcome: "IDENTITY_ALREADY_BOUND" };
      });
    },

    async completeOidcLogin(input: {
      providerId: string;
      providerSubject: string;
      usernameSnapshot?: string | null;
      emailSnapshot: string | null;
      displayNameSnapshot: string | null;
      sessionId: string;
      tokenHash: string;
      expiresAt: Date;
      authenticatedAt: Date;
    }): Promise<CompleteOidcLoginResult> {
      return database.begin(async (transaction) => {
        const rows = await transaction<OidcUserRow[]>`
          select
            users.id,
            users.email,
            users.username,
            users.role,
            users.status,
            users.last_login_at,
            users.created_at,
            users.updated_at
          from user_identities identities
          join users on users.id = identities.user_id
          where identities.provider_id = ${input.providerId}
            and identities.provider_subject = ${input.providerSubject}
          for update of identities, users
        `;
        const user = rows[0];
        if (user === undefined) return { outcome: "UNKNOWN_IDENTITY" };
        if (user.status !== "active") return { outcome: "USER_DISABLED" };

        await transaction`
          insert into user_sessions (id, user_id, token_hash, expires_at)
          values (
            ${input.sessionId},
            ${user.id},
            ${input.tokenHash},
            ${input.expiresAt}
          )
        `;
        await transaction`
          update users
          set last_login_at = ${input.authenticatedAt}, updated_at = ${input.authenticatedAt}
          where id = ${user.id} and status = 'active'
        `;
        await transaction`
          update user_identities
          set
            username_snapshot = ${input.usernameSnapshot ?? null},
            email_snapshot = ${input.emailSnapshot},
            display_name_snapshot = ${input.displayNameSnapshot},
            last_login_at = ${input.authenticatedAt}
          where provider_id = ${input.providerId}
            and provider_subject = ${input.providerSubject}
        `;

        return {
          outcome: "AUTHENTICATED",
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

export type Phase10Repository = ReturnType<typeof createPhase10Repository>;
