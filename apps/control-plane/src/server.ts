import {
  checkDatabase,
  createDatabaseClient,
  createPhase5Repository,
  migrateDatabase,
} from "@agent-runtime/database";
import { parseWorkspaceBaseUrl } from "@agent-runtime/gateway";
import { WorkerIdSchema, WorkerTokenSchema } from "@agent-runtime/protocol";
import { z } from "zod";

import { buildControlPlane } from "./app.js";
import { buildWorkspaceGateway } from "./gateway.js";
import { WorkspaceSessionExchange } from "./session-exchange.js";
import { selectWorker } from "./scheduler.js";

const WorkerGatewayTokensSchema = z
  .string()
  .default("{}")
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: "custom", message: "Invalid Worker Gateway token JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.record(WorkerIdSchema, WorkerTokenSchema))
  .refine(
    (tokens) => new Set(Object.values(tokens)).size === Object.keys(tokens).length,
    "Each Worker Gateway must use a distinct token",
  );

const ServerConfigSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
    GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
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
    WORKSPACE_SESSION_EXCHANGE_TTL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(60_000),
    WORKSPACE_BASE_URL: z.string().transform((value, context) => {
      try {
        parseWorkspaceBaseUrl(value);
        return value;
      } catch {
        context.addIssue({
          code: "custom",
          message: "WORKSPACE_BASE_URL must be an HTTP(S) origin",
        });
        return z.NEVER;
      }
    }),
    WORKER_GATEWAY_TOKENS_JSON: WorkerGatewayTokensSchema,
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

const repository = createPhase5Repository(database, selectWorker);
const sessionExchanges = new WorkspaceSessionExchange(
  config.WORKSPACE_SESSION_EXCHANGE_TTL_MS,
);
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
  workspaceBaseUrl: config.WORKSPACE_BASE_URL,
  sessionExchanges,
});
const gateway = buildWorkspaceGateway({
  store: repository,
  exchanges: sessionExchanges,
  portalOrigin: config.PORTAL_ORIGIN,
  workspaceBaseUrl: config.WORKSPACE_BASE_URL,
  secureCookies: config.SESSION_COOKIE_SECURE,
  sessionTtlMs: config.SESSION_TTL_HOURS * 60 * 60 * 1_000,
  workerOfflineAfterMs: config.WORKER_OFFLINE_AFTER_MS,
  workerGatewayTokens: config.WORKER_GATEWAY_TOKENS_JSON,
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
  await new Promise<void>((resolve, reject) => {
    gateway.close((error) => (error === undefined ? resolve() : reject(error)));
  });
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
await new Promise<void>((resolve, reject) => {
  const onError = (error: Error): void => reject(error);
  gateway.once("error", onError);
  gateway.listen(config.GATEWAY_PORT, config.GATEWAY_HOST, () => {
    gateway.off("error", onError);
    resolve();
  });
});
