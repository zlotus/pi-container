import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "./index.js";
import {
  DatabaseNewerThanBuildError,
  MIGRATION_NAMES,
  migrateDatabase,
  migrationStatus,
  PendingMigrationsError,
  prepareDatabase,
} from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl === undefined ? describe.skip : describe;

/** The last migration of v0.13.0 (`git show v0.13.0:packages/database/src/migrate.ts`). */
const V0_13_LAST_MIGRATION = "0009_worker_scheduling";

describeWithPostgres("database migrations (specs.md Phase 19.8)", () => {
  let admin!: DatabaseClient;
  const created: string[] = [];

  /** A fresh, empty database: these tests need schemas the shared test database cannot have. */
  async function freshDatabase(): Promise<DatabaseClient> {
    const name = `agent_runtime_migrate_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`create database ${name}`);
    created.push(name);
    const url = new URL(databaseUrl ?? "");
    url.pathname = `/${name}`;
    return createDatabaseClient(url.href);
  }

  beforeAll(() => {
    admin = createDatabaseClient(databaseUrl ?? "");
  });

  afterAll(async () => {
    for (const name of created) {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
    }
    await admin.end({ timeout: 5 });
  });

  it("reports pending migrations and refuses to start without permission to apply them", async () => {
    const database = await freshDatabase();
    try {
      expect(await migrationStatus(database)).toEqual({
        applied: [],
        pending: [...MIGRATION_NAMES],
        unknown: [],
      });
      await expect(prepareDatabase(database, { migrate: false })).rejects.toBeInstanceOf(
        PendingMigrationsError,
      );
      await prepareDatabase(database, { migrate: true });
      expect(await migrationStatus(database)).toEqual({
        applied: [...MIGRATION_NAMES],
        pending: [],
        unknown: [],
      });
      await prepareDatabase(database, { migrate: false });
    } finally {
      await database.end({ timeout: 5 });
    }
  });

  it("refuses a database that a newer release has migrated, with or without migrating", async () => {
    const database = await freshDatabase();
    try {
      await migrateDatabase(database);
      await database`insert into platform_migrations (name) values ('9999_from_the_future')`;
      expect((await migrationStatus(database)).unknown).toEqual(["9999_from_the_future"]);
      for (const migrate of [false, true]) {
        await expect(prepareDatabase(database, { migrate })).rejects.toBeInstanceOf(
          DatabaseNewerThanBuildError,
        );
      }
      await expect(migrateDatabase(database)).rejects.toBeInstanceOf(DatabaseNewerThanBuildError);
    } finally {
      await database.end({ timeout: 5 });
    }
  });

  it("upgrades a v0.13 database to the current schema without losing its data", async () => {
    const database = await freshDatabase();
    const adminId = randomUUID();
    const userId = randomUUID();
    const ssoUserId = randomUUID();
    const runningId = randomUUID();
    const stoppedId = randomUUID();
    const unassignedId = randomUUID();
    const sessionId = randomUUID();
    const identityId = randomUUID();
    try {
      await migrateDatabase(database, { through: V0_13_LAST_MIGRATION });
      expect((await migrationStatus(database)).pending).toEqual(
        MIGRATION_NAMES.slice(MIGRATION_NAMES.indexOf(V0_13_LAST_MIGRATION) + 1),
      );

      // Data as a v0.13 deployment holds it (columns of migrations 0001-0009 only).
      await database`
        insert into users (id, email, username, password_hash, role)
        values
          (${adminId}, 'admin@example.internal', 'admin', 'scrypt$hash-admin', 'admin'),
          (${userId}, 'user@example.internal', 'user1', 'scrypt$hash-user', 'user')
      `;
      await database`
        insert into users (id, email, username, password_hash, role)
        values (${ssoUserId}, null, null, null, 'user')
      `;
      await database`
        insert into user_identities (id, user_id, provider_id, provider_subject, email_snapshot)
        values (${identityId}, ${ssoUserId}, 'corp-oidc', 'subject-1', 'sso@example.internal')
      `;
      await database`
        insert into user_sessions (id, user_id, token_hash, expires_at)
        values (${sessionId}, ${userId}, ${"s".repeat(43)}, now() + interval '1 day')
      `;
      await database`
        insert into workers (id, credential_hash, hostname, architecture, status, runtime_image,
          runtime_version, gateway_base_url, capabilities, max_workspaces, schedulable)
        values ('worker-a', ${"w".repeat(43)}, 'worker-a.internal', 'arm64', 'ONLINE',
          'agent-runtime:phase7-toolchain', 'phase-7', 'http://192.168.1.124:3100',
          '{"python": true, "node": true}', 4, true)
      `;
      await database`
        insert into workspaces (id, user_id, name, worker_id, state, desired_state, runtime_image)
        values
          (${runningId}, ${userId}, 'running', 'worker-a', 'RUNNING', 'RUNNING', 'agent-runtime:phase7-toolchain'),
          (${stoppedId}, ${userId}, 'stopped', 'worker-a', 'STOPPED', 'STOPPED', 'agent-runtime:phase7-toolchain'),
          (${unassignedId}, ${adminId}, 'unassigned', null, 'CREATED', 'STOPPED', 'agent-runtime:phase7-toolchain')
      `;
      const auditBefore = await database<{ count: string }[]>`
        select count(*)::text as count from platform_audit_events
      `;

      await migrateDatabase(database);
      expect(await migrationStatus(database)).toMatchObject({ pending: [], unknown: [] });

      const users = await database<{ id: string; role: string; status: string }[]>`
        select id, role, status from users order by email nulls last
      `;
      expect(users).toEqual([
        { id: adminId, role: "admin", status: "active" },
        { id: userId, role: "user", status: "active" },
        { id: ssoUserId, role: "user", status: "active" },
      ]);
      const [identity] = await database<{ user_id: string }[]>`
        select user_id from user_identities where provider_id = 'corp-oidc' and provider_subject = 'subject-1'
      `;
      expect(identity?.user_id).toBe(ssoUserId);
      const [session] = await database<{ revoked_at: Date | null }[]>`
        select revoked_at from user_sessions where id = ${sessionId}
      `;
      expect(session).toEqual({ revoked_at: null });

      const workspaces = await database<
        {
          id: string;
          user_id: string;
          worker_id: string | null;
          state: string;
          desired_state: string;
          runtime_image: string;
          disk_limit_bytes: string;
          previous_runtime_image: string | null;
        }[]
      >`
        select id, user_id, worker_id, state, desired_state, runtime_image,
          disk_limit_bytes::text as disk_limit_bytes, previous_runtime_image
        from workspaces order by name
      `;
      expect(workspaces).toEqual([
        {
          id: runningId,
          user_id: userId,
          worker_id: "worker-a",
          state: "RUNNING",
          desired_state: "RUNNING",
          runtime_image: "agent-runtime:phase7-toolchain",
          disk_limit_bytes: String(20 * 1024 ** 3),
          previous_runtime_image: null,
        },
        {
          id: stoppedId,
          user_id: userId,
          worker_id: "worker-a",
          state: "STOPPED",
          desired_state: "STOPPED",
          runtime_image: "agent-runtime:phase7-toolchain",
          disk_limit_bytes: String(20 * 1024 ** 3),
          previous_runtime_image: null,
        },
        {
          id: unassignedId,
          user_id: adminId,
          worker_id: null,
          state: "CREATED",
          desired_state: "STOPPED",
          runtime_image: "agent-runtime:phase7-toolchain",
          disk_limit_bytes: String(20 * 1024 ** 3),
          previous_runtime_image: null,
        },
      ]);

      const [worker] = await database<
        {
          enabled: boolean;
          schedulable: boolean;
          gateway_base_url: string;
          runtime_images: Array<{ image: string; runtimeVersion: string }>;
          worker_version: string | null;
          egress_enforced: boolean;
          storage_enforced: boolean;
        }[]
      >`
        select enabled, schedulable, gateway_base_url, runtime_images, worker_version,
          egress_enforced, storage_enforced
        from workers where id = 'worker-a'
      `;
      expect(worker).toMatchObject({
        enabled: true,
        schedulable: true,
        gateway_base_url: "http://192.168.1.124:3100",
        worker_version: null,
        // Not enforced until the upgraded Worker reports it: nothing is scheduled or started.
        egress_enforced: false,
        storage_enforced: false,
      });
      expect(worker?.runtime_images).toMatchObject([
        { image: "agent-runtime:phase7-toolchain", runtimeVersion: "phase-7" },
      ]);

      // Audit history is kept; later migrations only add events.
      const [auditAfter] = await database<{ count: string }[]>`
        select count(*)::text as count from platform_audit_events
      `;
      expect(Number(auditAfter?.count)).toBeGreaterThanOrEqual(Number(auditBefore[0]?.count));

      // The upgraded Worker's first v7 hello records its version, with an Audit trace.
      await database`update workers set worker_version = '1.0.0' where id = 'worker-a'`;
      const versionEvents = await database<{ details: { fromVersion: string | null; toVersion: string } }[]>`
        select details from platform_audit_events
        where event_type = 'worker.version_reported' and worker_id = 'worker-a'
      `;
      expect(versionEvents.map((event) => event.details)).toEqual([
        { fromVersion: null, toVersion: "1.0.0" },
      ]);
      await expect(
        database`update workers set worker_version = 'not a version' where id = 'worker-a'`,
      ).rejects.toThrow();
    } finally {
      await database.end({ timeout: 5 });
    }
  });
});
