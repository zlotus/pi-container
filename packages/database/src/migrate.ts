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
] as const;

export async function migrateDatabase(client: DatabaseClient): Promise<void> {
  await client.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(708_913_421)`;
    await transaction`
      create table if not exists platform_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `;

    for (const migration of MIGRATIONS) {
      const existing = await transaction<{ name: string }[]>`
        select name from platform_migrations where name = ${migration.name}
      `;
      if (existing.length > 0) {
        continue;
      }

      const sql = await readFile(migration.url, "utf8");
      await transaction.unsafe(sql);
      await transaction`
        insert into platform_migrations (name) values (${migration.name})
      `;
    }
  });
}
