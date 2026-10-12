import {
  checkDatabase,
  createDatabaseClient,
  createRepository,
  migrateDatabase,
} from "@agent-runtime/database";
import { createLogger, LoggingConfigSchema } from "@agent-runtime/logging";
import { buildControlPlane } from "./app.js";
import { parseServerConfig } from "./config.js";
import { protectedAddressResolver } from "./egress.js";
import {
  AddressSet,
  DEFAULT_LOGIN_GUARD_POLICIES,
  LoginGuard,
} from "./login-guard.js";
import { buildWorkspaceGateway } from "./gateway.js";
import { WorkspaceSessionExchange } from "./session-exchange.js";
import { SessionConnectionRegistry } from "./session-connections.js";
import { selectWorker } from "./scheduler.js";
import { enforceWorkerRevocations } from "./worker-revocation.js";
import { GenericOidcClient, OidcTransactionStore } from "./oidc.js";
import { LiteLlmAdminClient, meteredModelGatewayAdmin } from "./model-gateway/admin-client.js";
import { loadModelCatalog, ModelKeyManager } from "./model-gateway/key-manager.js";
import { WorkerChannel } from "./worker-channel.js";
import { MetricsCollector } from "./metrics/collector.js";
import {
  createMetricsServer,
  readMetricsToken,
  validateMetricsListen,
} from "./metrics/listener.js";
import { PlatformMetrics } from "./metrics/platform-metrics.js";
import { UsageRegistry } from "./metrics/usage-registry.js";
import { WORKER_PROTOCOL_VERSION } from "@agent-runtime/protocol";
import {
  GenericOAuth2UserInfoClient,
  OAuth2TransactionStore,
} from "./oauth2.js";

const config = parseServerConfig(process.env);
const log = await createLogger("control-plane", LoggingConfigSchema.parse(process.env));
// Metrics are never unauthenticated: an incomplete configuration stops the start (Phase 17.8).
const metricsToken =
  config.METRICS_PORT === null ? null : await readMetricsToken(config.METRICS_TOKEN_FILE);
if (config.METRICS_PORT !== null) {
  validateMetricsListen({
    metricsHost: config.METRICS_HOST,
    metricsPort: config.METRICS_PORT,
    listeners: [
      { host: config.HOST, port: config.PORT },
      { host: config.GATEWAY_HOST, port: config.GATEWAY_PORT },
    ],
  });
}
const metrics = new PlatformMetrics({
  defaultMetrics: true,
  version: process.env.npm_package_version ?? "dev",
  protocolVersion: WORKER_PROTOCOL_VERSION,
});
const database = createDatabaseClient(config.DATABASE_URL);

await migrateDatabase(database);

const repository = createRepository(database, selectWorker);
await repository.markAllWorkersOfflineForRecovery(new Date());
const sessionExchanges = new WorkspaceSessionExchange(
  config.WORKSPACE_SESSION_EXCHANGE_TTL_MS,
);
const sessionConnections = new SessionConnectionRegistry();
const oidcIssuer =
  config.AUTH_OIDC_ISSUER === "" ? null : new URL(config.AUTH_OIDC_ISSUER);
const oidc = config.AUTH_OIDC_ENABLED
  ? {
      providerId: config.AUTH_OIDC_PROVIDER_ID,
      redirectUri: new URL(
        "/auth/oidc/callback",
        config.PORTAL_ORIGIN,
      ).href,
      client: new GenericOidcClient({
        issuer: config.AUTH_OIDC_ISSUER,
        clientId: config.AUTH_OIDC_CLIENT_ID,
        clientSecret: config.AUTH_OIDC_CLIENT_SECRET,
        allowInsecureIssuer: oidcIssuer?.protocol === "http:",
      }),
      transactions: new OidcTransactionStore(),
      autoProvision: config.AUTH_OIDC_AUTO_PROVISION,
      allowedDomains: config.AUTH_OIDC_ALLOWED_DOMAINS,
    }
  : undefined;
const oauth2 = config.AUTH_OAUTH2_ENABLED
  ? {
      providerId: config.AUTH_OAUTH2_PROVIDER_ID,
      redirectUri: new URL(
        "/auth/oauth2/callback",
        config.PORTAL_ORIGIN,
      ).href,
      client: new GenericOAuth2UserInfoClient({
        authorizationUrl: config.AUTH_OAUTH2_AUTHORIZATION_URL,
        tokenUrl: config.AUTH_OAUTH2_TOKEN_URL,
        userinfoUrl: config.AUTH_OAUTH2_USERINFO_URL,
        userinfoTokenMethod: config.AUTH_OAUTH2_USERINFO_TOKEN_METHOD,
        clientId: config.AUTH_OAUTH2_CLIENT_ID,
        clientSecret: config.AUTH_OAUTH2_CLIENT_SECRET,
        scope: config.AUTH_OAUTH2_SCOPE,
        subjectField: config.AUTH_OAUTH2_SUBJECT_FIELD,
        usernameField: config.AUTH_OAUTH2_USERNAME_FIELD || null,
        emailField: config.AUTH_OAUTH2_EMAIL_FIELD || null,
        displayNameField: config.AUTH_OAUTH2_DISPLAY_NAME_FIELD || null,
      }),
      transactions: new OAuth2TransactionStore(),
      autoProvision: config.AUTH_OAUTH2_AUTO_PROVISION,
      allowedDomains: config.AUTH_OAUTH2_ALLOWED_DOMAINS,
    }
  : undefined;
const loginGuard = new LoginGuard(
  config.SESSION_SECRET,
  {
    loginIp: {
      ...DEFAULT_LOGIN_GUARD_POLICIES.loginIp,
      threshold: config.AUTH_LOCKOUT_ACCOUNT_IP_THRESHOLD,
    },
    ip: { ...DEFAULT_LOGIN_GUARD_POLICIES.ip, threshold: config.AUTH_LOCKOUT_IP_THRESHOLD },
    login: {
      ...DEFAULT_LOGIN_GUARD_POLICIES.login,
      threshold: config.AUTH_LOCKOUT_ACCOUNT_THRESHOLD,
    },
    ssoStart: {
      ...DEFAULT_LOGIN_GUARD_POLICIES.ssoStart,
      threshold: config.AUTH_SSO_START_LIMIT,
    },
  },
  new AddressSet(config.AUTH_TRUSTED_NETWORKS),
);
const workerChannel = new WorkerChannel(config.WORKER_COMMAND_TIMEOUT_MS, metrics);
const usage = new UsageRegistry(config.WORKER_OFFLINE_AFTER_MS, (workerId) =>
  workerChannel.isConnected(workerId),
);
const modelGateway =
  config.MODEL_GATEWAY_ADMIN_URL === ""
    ? undefined
    : new ModelKeyManager({
        store: repository,
        admin: meteredModelGatewayAdmin(
          new LiteLlmAdminClient({
            adminUrl: config.MODEL_GATEWAY_ADMIN_URL,
            masterKey: config.MODEL_GATEWAY_MASTER_KEY,
          }),
          (operation, result) => metrics.recordModelGatewayRequest(operation, result),
        ),
        channel: workerChannel,
        catalog: await loadModelCatalog(config.MODEL_GATEWAY_CATALOG_FILE),
        policy: {
          defaultBudgetUsd: config.MODEL_GATEWAY_USER_BUDGET_USD,
          budgetDuration: config.MODEL_GATEWAY_BUDGET_DURATION,
          rpmLimit: config.MODEL_GATEWAY_KEY_RPM,
          tpmLimit: config.MODEL_GATEWAY_KEY_TPM,
        },
        log: log.child({ component: "model-gateway" }),
        onMaintenanceFailure: () => metrics.recordBackgroundFailure("model_key_loop"),
      });
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
  workspaceDiskLimitBytes: config.WORKSPACE_DISK_LIMIT_BYTES,
  workspaceDiskLimitMaxBytes: config.WORKSPACE_DISK_LIMIT_MAX_BYTES,
  workspaceBaseUrl: config.WORKSPACE_BASE_URL,
  sessionExchanges,
  sessionConnections,
  loginGuard,
  trustedProxies: new AddressSet(config.AUTH_TRUSTED_PROXIES),
  ...(oidc === undefined ? {} : { oidc }),
  ...(oauth2 === undefined ? {} : { oauth2 }),
  egressProtected: protectedAddressResolver(
    config.PLATFORM_EGRESS_PROTECTED,
    config.DATABASE_URL,
    undefined,
    [
      ...(config.MODEL_GATEWAY_ADMIN_URL === "" ? [] : [config.MODEL_GATEWAY_ADMIN_URL]),
      // A non-loopback metrics address is a platform address no whitelist may open.
      ...(config.METRICS_PORT === null
        ? []
        : [`http://${config.METRICS_HOST.includes(":") ? `[${config.METRICS_HOST}]` : config.METRICS_HOST}:${config.METRICS_PORT}`]),
    ],
  ),
  workerChannel,
  ...(modelGateway === undefined ? {} : { modelGateway }),
  metrics,
  usage,
  reportRecoveryIssue: (issue) => {
    log.warn({ issue }, "worker recovery issue");
  },
  log,
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
  log: log.child({ component: "workspace-gateway" }),
  metrics,
});
const metricsCollector = new MetricsCollector({
  metrics,
  store: repository,
  usage,
  connectedWorkerIds: () => workerChannel.connectedWorkerIds(),
  modelGatewayEnabled: modelGateway !== undefined,
  defaultRuntimeImage: config.DEFAULT_RUNTIME_IMAGE,
});
const metricsServer =
  metricsToken === null
    ? null
    : createMetricsServer({
        token: metricsToken,
        contentType: metrics.registry.contentType,
        collect: () => metricsCollector.collect(),
        log: log.child({ component: "metrics" }),
      });

const workerStatusTimer = setInterval(() => {
  const cutoff = new Date(Date.now() - config.WORKER_OFFLINE_AFTER_MS);
  void repository
    .markWorkersOffline(cutoff)
    .then(() =>
      enforceWorkerRevocations({
        store: repository,
        channel: workerChannel,
        sessionConnections,
        log,
      }),
    )
    .catch((error: unknown) => {
      // Readiness and the Admin API expose database failure without terminating
      // healthy Worker sockets because of a transient sweep failure.
      metrics.recordBackgroundFailure("worker_offline_sweep");
      log.error({ err: error }, "worker offline sweep failed");
    });
}, config.WORKER_STATUS_SWEEP_MS);
workerStatusTimer.unref();

const authThrottleCleanupTimer = setInterval(() => {
  void repository
    .deleteExpiredAuthThrottle(new Date(), loginGuard.maxWindowMs)
    .catch((error: unknown) => {
      metrics.recordBackgroundFailure("auth_throttle_cleanup");
      log.error({ err: error }, "login throttle cleanup failed");
    });
}, 60_000);
authThrottleCleanupTimer.unref();

modelGateway?.start();
if (modelGateway !== undefined) {
  log.info(
    { providerId: modelGateway.catalog.providerId, models: modelGateway.catalog.models.length },
    "platform model access enabled",
  );
}

const shutdown = async (): Promise<void> => {
  modelGateway?.stop();
  clearInterval(workerStatusTimer);
  clearInterval(authThrottleCleanupTimer);
  await new Promise<void>((resolve, reject) => {
    gateway.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  metricsServer?.close();
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
    log.info(
      { host: config.GATEWAY_HOST, port: config.GATEWAY_PORT },
      "workspace gateway listening",
    );
    resolve();
  });
});
if (metricsServer !== null && config.METRICS_PORT !== null) {
  const port = config.METRICS_PORT;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    metricsServer.once("error", onError);
    metricsServer.listen(port, config.METRICS_HOST, () => {
      metricsServer.off("error", onError);
      log.info({ host: config.METRICS_HOST, port }, "metrics listening");
      resolve();
    });
  });
}
