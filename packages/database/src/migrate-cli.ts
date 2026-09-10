import { createDatabaseClient } from "./index.js";
import { migrateDatabase } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required");
}

const database = createDatabaseClient(databaseUrl);

try {
  await migrateDatabase(database);
  console.log("Database migrations are up to date.");
} finally {
  await database.end({ timeout: 5 });
}
