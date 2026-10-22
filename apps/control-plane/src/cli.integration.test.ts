// The operator CLIs follow the same migration rule as the Control Plane (specs.md Phase
// 19.8): with DATABASE_MIGRATE_ON_START=false they refuse a database with pending
// migrations instead of migrating it behind the operator's back.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabaseClient, migrationStatus, type DatabaseClient } from "@agent-runtime/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl === undefined ? describe.skip : describe;
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(APP, "..", "..", "node_modules", ".bin", "tsx");

describeWithPostgres("operator CLIs and migrations (Phase 19.8)", () => {
  let admin!: DatabaseClient;
  let fresh!: DatabaseClient;
  let freshUrl = "";
  const name = `agent_runtime_cli_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    admin = createDatabaseClient(databaseUrl ?? "");
    await admin.unsafe(`create database ${name}`);
    const url = new URL(databaseUrl ?? "");
    url.pathname = `/${name}`;
    freshUrl = url.href;
    fresh = createDatabaseClient(freshUrl);
  });

  afterAll(async () => {
    await fresh.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end({ timeout: 5 });
  });

  function createUser(extra: Record<string, string>) {
    return spawnSync(TSX, ["src/create-user.ts"], {
      cwd: APP,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: freshUrl,
        LOCAL_USER_EMAIL: "cli-admin@example.internal",
        LOCAL_USER_PASSWORD: "cli-password-for-tests",
        LOCAL_USER_ROLE: "admin",
        ...extra,
      },
    });
  }

  it("refuses pending migrations when the deployment migrates explicitly", async () => {
    const refused = createUser({ DATABASE_MIGRATE_ON_START: "false" });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Database migrations are pending");
    expect((await migrationStatus(fresh)).applied).toEqual([]);
  });

  it("migrates and creates the user in development (default)", async () => {
    const created = createUser({});
    expect(created.status, created.stderr).toBe(0);
    expect(created.stdout).toContain("Created admin user cli-admin@example.internal.");
    expect((await migrationStatus(fresh)).pending).toEqual([]);
  });
});
