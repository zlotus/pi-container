import { readFile } from "node:fs/promises";

import type { DatabaseClient } from "./index.js";

const MIGRATIONS = [
  {
    name: "0001_phase1",
    url: new URL("../migrations/0001_phase1.sql", import.meta.url),
  },
  {
    name: "0002_phase2_workers",
    url: new URL("../migrations/0002_phase2_workers.sql", import.meta.url),
  },
  {
    name: "0003_phase6_recovery",
    url: new URL("../migrations/0003_phase6_recovery.sql", import.meta.url),
  },
  {
    name: "0004_phase6_legacy_desired_state",
    url: new URL(
      "../migrations/0004_phase6_legacy_desired_state.sql",
      import.meta.url,
    ),
  },
  {
    name: "0005_phase8_audit",
    url: new URL("../migrations/0005_phase8_audit.sql", import.meta.url),
  },
  {
    name: "0006_phase9_users",
    url: new URL("../migrations/0006_phase9_users.sql", import.meta.url),
  },
  {
    name: "0007_phase10_oidc",
    url: new URL("../migrations/0007_phase10_oidc.sql", import.meta.url),
  },
  {
    name: "0008_phase11_identity",
    url: new URL("../migrations/0008_phase11_identity.sql", import.meta.url),
  },
  {
    name: "0009_worker_scheduling",
    url: new URL("../migrations/0009_worker_scheduling.sql", import.meta.url),
  },
  {
    name: "0010_egress_policy",
    url: new URL("../migrations/0010_egress_policy.sql", import.meta.url),
  },
  {
    name: "0011_storage_and_login_guard",
    url: new URL("../migrations/0011_storage_and_login_guard.sql", import.meta.url),
  },
  {
    name: "0012_model_gateway",
    url: new URL("../migrations/0012_model_gateway.sql", import.meta.url),
  },
  {
    name: "0013_lifecycle",
    url: new URL("../migrations/0013_lifecycle.sql", import.meta.url),
  },
  {
    name: "0014_release",
    url: new URL("../migrations/0014_release.sql", import.meta.url),
  },
] as const;

/** The migrations this build knows, in order. */
export const MIGRATION_NAMES: readonly string[] = MIGRATIONS.map((migration) => migration.name);

export interface MigrationStatus {
  applied: string[];
  /** Known to this build but not applied yet. */
  pending: string[];
  /** Applied by a newer build; this build must not run on such a database. */
  unknown: string[];
}

/** The database holds migrations this build does not know (specs.md Phase 19.8). */
export class DatabaseNewerThanBuildError extends Error {
  constructor(readonly unknown: readonly string[]) {
    super(
      `The database was migrated by a newer release (${unknown.join(", ")}); ` +
        "run that release, or restore the backup taken before the upgrade",
    );
    this.name = "DatabaseNewerThanBuildError";
  }
}

/** Migrations are pending and this process may not apply them. */
export class PendingMigrationsError extends Error {
  constructor(readonly pending: readonly string[]) {
    super(
      `Database migrations are pending (${pending.join(", ")}); ` +
        "back up the database and run the migrate command first",
    );
    this.name = "PendingMigrationsError";
  }
}

function classify(applied: readonly string[]): MigrationStatus {
  const appliedSet = new Set(applied);
  return {
    applied: MIGRATION_NAMES.filter((name) => appliedSet.has(name)),
    pending: MIGRATION_NAMES.filter((name) => !appliedSet.has(name)),
    unknown: applied.filter((name) => !MIGRATION_NAMES.includes(name)).sort(),
  };
}

export async function migrationStatus(client: DatabaseClient): Promise<MigrationStatus> {
  const [table] = await client<{ exists: boolean }[]>`
    select to_regclass('platform_migrations') is not null as exists
  `;
  if (table?.exists !== true) return classify([]);
  const rows = await client<{ name: string }[]>`select name from platform_migrations`;
  return classify(rows.map((row) => row.name));
}

/**
 * Applies the pending migrations in one transaction. Refuses a database that a newer
 * release has migrated: this build's code would run on a schema it does not know.
 */
export async function migrateDatabase(
  client: DatabaseClient,
  options: {
    /** Stop after this migration; tests use it to build an older schema (e.g. v0.13). */
    through?: string;
  } = {},
): Promise<void> {
  const last = options.through === undefined ? MIGRATION_NAMES.length - 1 : MIGRATION_NAMES.indexOf(options.through);
  if (last < 0) throw new Error(`Unknown migration ${options.through ?? ""}`);
  await client.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(708_913_421)`;
    await transaction`
      create table if not exists platform_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `;
    const applied = await transaction<{ name: string }[]>`select name from platform_migrations`;
    const status = classify(applied.map((row) => row.name));
    if (status.unknown.length > 0) throw new DatabaseNewerThanBuildError(status.unknown);

    for (const migration of MIGRATIONS.slice(0, last + 1)) {
      if (!status.pending.includes(migration.name)) continue;
      const sql = await readFile(migration.url, "utf8");
      await transaction.unsafe(sql);
      await transaction`
        insert into platform_migrations (name) values (${migration.name})
      `;
    }
  });
}

/**
 * Startup check of the Control Plane: migrates when allowed (development), otherwise
 * requires an up-to-date schema (production runs the migrate command after a backup).
 */
export async function prepareDatabase(
  client: DatabaseClient,
  options: { migrate: boolean },
): Promise<void> {
  if (options.migrate) {
    await migrateDatabase(client);
    return;
  }
  const status = await migrationStatus(client);
  if (status.unknown.length > 0) throw new DatabaseNewerThanBuildError(status.unknown);
  if (status.pending.length > 0) throw new PendingMigrationsError(status.pending);
}
