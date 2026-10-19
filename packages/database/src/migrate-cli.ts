import { createDatabaseClient } from "./index.js";
import { migrateDatabase, migrationStatus } from "./migrate.js";

// `migrate` applies pending migrations; `status` only reports (specs.md Phase 19.8).
const command = process.argv[2] ?? "migrate";
if (command !== "migrate" && command !== "status") {
  console.error("usage: migrate-cli [migrate|status]");
  process.exit(2);
}
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required");
}

const database = createDatabaseClient(databaseUrl);

try {
  if (command === "status") {
    const status = await migrationStatus(database);
    console.log(`applied: ${status.applied.length}`);
    console.log(`pending: ${status.pending.length === 0 ? "none" : status.pending.join(", ")}`);
    console.log(`unknown: ${status.unknown.length === 0 ? "none" : status.unknown.join(", ")}`);
    if (status.unknown.length > 0) {
      console.log("The database was migrated by a newer release; this release must not run on it.");
      process.exitCode = 3;
    } else if (status.pending.length > 0) {
      process.exitCode = 4;
    }
  } else {
    await migrateDatabase(database);
    console.log("Database migrations are up to date.");
  }
} finally {
  await database.end({ timeout: 5 });
}
