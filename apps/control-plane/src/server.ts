import {
  checkDatabase,
  createDatabaseClient,
  createPhase11Repository,
  migrateDatabase,
} from "@agent-runtime/database";
import { buildControlPlane } from "./app.js";
import { parseServerConfig } from "./config.js";
import { buildWorkspaceGateway } from "./gateway.js";
import { WorkspaceSessionExchange } from "./session-exchange.js";
import { SessionConnectionRegistry } from "./session-connections.js";
import { selectWorker } from "./scheduler.js";
import { GenericOidcClient, OidcTransactionStore } from "./oidc.js";
import {
  GenericOAuth2UserInfoClient,
  OAuth2TransactionStore,
} from "./oauth2.js";

const config = parseServerConfig(process.env);
const database = createDatabaseClient(config.DATABASE_URL);

await migrateDatabase(database);

const repository = createPhase11Repository(database, selectWorker);
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
  ...(oidc === undefined ? {} : { oidc }),
  ...(oauth2 === undefined ? {} : { oauth2 }),
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
