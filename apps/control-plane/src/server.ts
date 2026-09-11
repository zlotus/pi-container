import {
  checkDatabase,
  createDatabaseClient,
  createPhase3Repository,
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
      .default("agent-runtime:phase3-minimal"),
    WORKER_OFFLINE_AFTER_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(35_000),
    WORKER_STATUS_SWEEP_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    WORKER_COMMAND_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(300_000)
      .default(15_000),
    WORKSPACE_CPU_COUNT: z.coerce.number().positive().max(256).default(2),
    WORKSPACE_MEMORY_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(4 * 1024 ** 3),
    WORKSPACE_PIDS_LIMIT: z.coerce.number().int().positive().default(512),
  })
  .passthrough();

const config = ServerConfigSchema.parse(process.env);
const database = createDatabaseClient(config.DATABASE_URL);

await migrateDatabase(database);

const repository = createPhase3Repository(database);
const app = buildControlPlane({
  checkDatabase: async () => checkDatabase(database),
  store: repository,
  workerStore: repository,
  sessionSecret: config.SESSION_SECRET,
  portalOrigin: config.PORTAL_ORIGIN,
  secureCookies: config.SESSION_COOKIE_SECURE,
  sessionTtlMs: config.SESSION_TTL_HOURS * 60 * 60 * 1_000,
  defaultRuntimeImage: config.DEFAULT_RUNTIME_IMAGE,
  workerOfflineAfterMs: config.WORKER_OFFLINE_AFTER_MS,
  workerCommandTimeoutMs: config.WORKER_COMMAND_TIMEOUT_MS,
  workspaceResources: {
    cpuCount: config.WORKSPACE_CPU_COUNT,
    memoryBytes: config.WORKSPACE_MEMORY_BYTES,
    pidsLimit: config.WORKSPACE_PIDS_LIMIT,
  },
});

const workerStatusTimer = setInterval(() => {
  const cutoff = new Date(Date.now() - config.WORKER_OFFLINE_AFTER_MS);
  void repository.markWorkersOffline(cutoff).catch(() => {
    // Readiness and the Admin API expose database failure without terminating
    // healthy Worker sockets because of a transient sweep failure.
  });
}, config.WORKER_STATUS_SWEEP_MS);
workerStatusTimer.unref();

const shutdown = async (): Promise<void> => {
  clearInterval(workerStatusTimer);
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
