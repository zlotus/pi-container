import {
  checkDatabase,
  createDatabaseClient,
  createPhase1Repository,
  migrateDatabase,
} from "@agent-runtime/database";
import { z } from "zod";

import { buildControlPlane } from "./app.js";

const ServerConfigSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    PORTAL_ORIGIN: z
      .string()
      .url()
      .default("http://127.0.0.1:5173")
      .transform((value) => new URL(value).origin),
    SESSION_SECRET: z.string().min(32),
    SESSION_COOKIE_SECURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    SESSION_TTL_HOURS: z.coerce.number().positive().max(720).default(12),
    DEFAULT_RUNTIME_IMAGE: z
      .string()
      .min(1)
      .default("agent-runtime:phase1-unassigned"),
  })
  .passthrough();

const config = ServerConfigSchema.parse(process.env);
const database = createDatabaseClient(config.DATABASE_URL);

await migrateDatabase(database);

const repository = createPhase1Repository(database);
const app = buildControlPlane({
  checkDatabase: async () => checkDatabase(database),
  store: repository,
  sessionSecret: config.SESSION_SECRET,
  portalOrigin: config.PORTAL_ORIGIN,
  secureCookies: config.SESSION_COOKIE_SECURE,
  sessionTtlMs: config.SESSION_TTL_HOURS * 60 * 60 * 1_000,
  defaultRuntimeImage: config.DEFAULT_RUNTIME_IMAGE,
});

const shutdown = async (): Promise<void> => {
  await app.close();
  await database.end({ timeout: 5 });
};

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

await app.listen({ host: config.HOST, port: config.PORT });
