import postgres from "postgres";
import { z } from "zod";

const DatabaseUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "DATABASE_URL must use the postgres or postgresql scheme",
  );

export type DatabaseClient = ReturnType<typeof postgres>;

export function createDatabaseClient(databaseUrl: string): DatabaseClient {
  const parsedUrl = DatabaseUrlSchema.parse(databaseUrl);

  return postgres(parsedUrl, {
    max: 10,
    onnotice: () => undefined,
  });
}

export async function checkDatabase(client: DatabaseClient): Promise<void> {
  await client`select 1`;
}

export { migrateDatabase } from "./migrate.js";
export {
  createPhase1Repository,
  type AuthenticatedSessionRecord,
  type Phase1Repository,
  type UserRecord,
  type UserRole,
  type WorkspaceRecord,
} from "./phase1.js";
