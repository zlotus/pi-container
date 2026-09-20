import {
  checkDatabase,
  createDatabaseClient,
  createPhase9Repository,
  migrateDatabase,
} from "@agent-runtime/database";
import { buildControlPlane } from "./app.js";
import { parseServerConfig } from "./config.js";
import { buildWorkspaceGateway } from "./gateway.js";
import { WorkspaceSessionExchange } from "./session-exchange.js";
import { SessionConnectionRegistry } from "./session-connections.js";
import { selectWorker } from "./scheduler.js";

const config = parseServerConfig(process.env);
const database = createDatabaseClient(config.DATABASE_URL);

await migrateDatabase(database);

const repository = createPhase9Repository(database, selectWorker);
await repository.markAllWorkersOfflineForRecovery(new Date());
const sessionExchanges = new WorkspaceSessionExchange(
  config.WORKSPACE_SESSION_EXCHANGE_TTL_MS,
);
const sessionConnections = new SessionConnectionRegistry();
const app = buildControlPlane({
  checkDatabase: async () => checkDatabase(database),
  store: repository,
  workerStore: repository,
  sessionSecret: config.SESSION_SECRET,
  portalOrigin: config.PORTAL_ORIGIN,
  portalAllowedOrigins: config.PORTAL_ALLOWED_ORIGINS,
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
  sessionConnections,
  reportRecoveryIssue: (issue) => {
    console.warn("Worker recovery issue", JSON.stringify(issue));
  },
});
const gateway = buildWorkspaceGateway({
  store: repository,
  exchanges: sessionExchanges,
  portalOrigin: config.PORTAL_ORIGIN,
  portalAllowedOrigins: config.PORTAL_ALLOWED_ORIGINS,
  workspaceBaseUrl: config.WORKSPACE_BASE_URL,
  secureCookies: config.SESSION_COOKIE_SECURE,
  sessionTtlMs: config.SESSION_TTL_HOURS * 60 * 60 * 1_000,
  workerOfflineAfterMs: config.WORKER_OFFLINE_AFTER_MS,
  workerGatewayTokens: config.WORKER_GATEWAY_TOKENS_JSON,
  sessionConnections,
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
