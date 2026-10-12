import {
  constantTimeTextEqual,
  deriveCsrfToken,
  hashOpaqueToken,
} from "@agent-runtime/auth";
import type {
  AuthenticatedSessionRecord,
  AuthenticationAuditMetadata,
  AuthenticationFailureCategory,
  Repository,
} from "@agent-runtime/database";
import { parseWorkspaceBaseUrl } from "@agent-runtime/gateway";
import type { Logger } from "@agent-runtime/logging";
import type {
  WorkerRecoveryIssue,
  WorkspaceResources,
} from "@agent-runtime/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";

import { errorBody, parseCookie } from "./http.js";
import {
  type AddressSet,
  type LoginGuard,
  resolveClientAddress,
  retryAfterSeconds,
} from "./login-guard.js";
import type { ModelAccessService } from "./model-gateway/key-manager.js";
import {
  PlatformMetrics,
  type LoginProtocol,
  type RateLimitedEndpoint,
} from "./metrics/platform-metrics.js";
import { UsageRegistry } from "./metrics/usage-registry.js";
import type { OAuth2Runtime } from "./oauth2.js";
import type { OidcRuntime } from "./oidc.js";
import type { SessionConnectionRegistry } from "./session-connections.js";
import type { WorkspaceSessionExchange } from "./session-exchange.js";
import type { WorkerChannel } from "./worker-channel.js";
import type { WorkerControlStore } from "./worker-control.js";

type Phase1Store = Pick<
  Repository,
  | "findUserByLogin"
  | "createSession"
  | "findActiveSession"
  | "revokeSession"
  | "listWorkspaces"
  | "createWorkspace"
  | "findOwnedWorkspace"
  | "findWorkspaceById"
  | "beginWorkspaceRuntimeChange"
  | "finishWorkspaceRuntimeChange"
  | "revertWorkspaceRuntimeChange"
  | "deleteOwnedWorkspace"
  | "scheduleWorkspaceStart"
  | "finishWorkspaceStart"
  | "beginWorkspaceStop"
  | "finishWorkspaceStop"
  | "beginWorkspaceDelete"
  | "deleteConfirmedWorkspace"
  | "markWorkspaceRuntimeFailure"
  | "beginWorkerReconciliation"
  | "reconcileWorkspaceRecovery"
  | "deleteRecoveredWorkspace"
  | "recordWorkspaceOpened"
  | "listAuditEvents"
  | "listUsers"
  | "createUser"
  | "updateManagedUser"
  | "resetLocalPassword"
  | "revokeUserSessions"
  | "listManagedUserWorkspaces"
  | "listAllWorkspaces"
  | "listUserIdentities"
  | "bindExternalIdentity"
  | "unbindExternalIdentity"
  | "completeExternalLogin"
  | "recordAuthenticationFailure"
  | "findAuthLock"
  | "recordAuthThrottleHits"
  | "clearAuthThrottle"
  | "listAuthLocks"
  | "clearAuthLocks"
  | "updateWorkspaceDiskLimit"
  | "findUserModelBudget"
  | "setUserModelBudget"
>;

type WorkerAdminStore = Pick<
  Repository,
  | "listWorkersWithAssignments"
  | "listWorkerRuntimeImages"
  | "setWorkerSchedulable"
  | "getEgressPolicy"
  | "recordWorkerEgress"
  | "createEgressRule"
  | "deleteEgressRule"
>;

export interface ControlPlaneDependencies {
  checkDatabase: () => Promise<void>;
  store: Phase1Store;
  workerStore: WorkerControlStore & WorkerAdminStore;
  sessionSecret: string;
  portalOrigin: string;
  portalAllowedOrigins?: readonly string[];
  secureCookies: boolean;
  sessionTtlMs: number;
  defaultRuntimeImage: string;
  workerOfflineAfterMs: number;
  workerCommandTimeoutMs: number;
  workspaceResources: WorkspaceResources;
  /** Data-project limit for new Workspaces, and the most an administrator may set. */
  workspaceDiskLimitBytes: number;
  workspaceDiskLimitMaxBytes: number;
  workspaceBaseUrl: string;
  sessionExchanges: WorkspaceSessionExchange;
  sessionConnections?: SessionConnectionRegistry;
  oidc?: OidcRuntime;
  oauth2?: OAuth2Runtime;
  /** Login throttling counters and policies (specs.md Phase 15.9). */
  loginGuard: LoginGuard;
  /** Peers whose `X-Forwarded-For` is believed; empty means the TCP peer is the client. */
  trustedProxies: AddressSet;
  /** Shared with services that command Workers themselves (the model key manager). */
  workerChannel?: WorkerChannel;
  /** Platform model access (specs.md Phase 16); absent when no model gateway is configured. */
  modelGateway?: ModelAccessService;
  /** Platform addresses no egress whitelist may open; defaults to none. */
  egressProtected?: () => Promise<string[]>;
  reportRecoveryIssue?: (
    issue: WorkerRecoveryIssue & { workerId: string },
  ) => void;
  now?: () => Date;
  /** Structured logger; request logging is disabled when omitted (unit tests). */
  log?: Logger;
  /** Prometheus instruments (specs.md Phase 17.4); a private registry when omitted. */
  metrics?: PlatformMetrics;
  /** Latest Worker-reported usage (Phase 17.7); an empty registry when omitted. */
  usage?: UsageRegistry;
}

type AuditProtocol = AuthenticationAuditMetadata["protocol"];

export function loginProtocol(protocol: AuditProtocol): LoginProtocol {
  if (protocol === "OIDC") return "oidc";
  if (protocol === "OAUTH2") return "oauth2";
  return "local";
}

export interface AuthContext {
  rawToken: string;
  session: AuthenticatedSessionRecord;
}

/**
 * Shared state and guards for every Control Plane route module: session cookie names,
 * authentication, admin authorization, Origin and CSRF checks, and audit metadata.
 */
export function createRouteContext(dependencies: ControlPlaneDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const metrics = dependencies.metrics ?? new PlatformMetrics();
  const usage =
    dependencies.usage ??
    new UsageRegistry(
      dependencies.workerOfflineAfterMs,
      (workerId) => dependencies.workerChannel?.isConnected(workerId) ?? false,
      now,
    );
  const workspaceBaseUrl = parseWorkspaceBaseUrl(dependencies.workspaceBaseUrl);
  const cookieName = dependencies.secureCookies
    ? "__Host-platform-session"
    : "platform-session";
  const oidcTransactionCookieName = dependencies.secureCookies
    ? "__Host-oidc-transaction"
    : "oidc-transaction";
  const oauth2TransactionCookieName = dependencies.secureCookies
    ? "__Host-oauth2-transaction"
    : "oauth2-transaction";
  const externalProviderIds = new Set(
    [dependencies.oidc?.providerId, dependencies.oauth2?.providerId].filter(
      (providerId): providerId is string => providerId !== undefined,
    ),
  );

  /** The client address used for throttling and Audit; see `resolveClientAddress`. */
  function clientAddress(request: FastifyRequest): string {
    return resolveClientAddress(
      request.socket.remoteAddress ?? request.ip,
      request.headers["x-forwarded-for"],
      dependencies.trustedProxies,
    ).slice(0, 128);
  }

  /** One response for every kind of lock, so it does not tell which counter tripped. */
  function sendRateLimited(
    reply: FastifyReply,
    lockedUntil: Date,
    endpoint: RateLimitedEndpoint,
    protocol: AuditProtocol,
  ): FastifyReply {
    metrics.recordRateLimited(endpoint, loginProtocol(protocol));
    return reply
      .code(429)
      .header("retry-after", String(retryAfterSeconds(lockedUntil, now())))
      .header("cache-control", "no-store")
      .send(
        errorBody("AUTH_RATE_LIMITED", "Too many login attempts; try again later"),
      );
  }

  function sendThrottleUnavailable(reply: FastifyReply): FastifyReply {
    return reply
      .code(503)
      .send(errorBody("AUTH_UNAVAILABLE", "Login is temporarily unavailable"));
  }

  function authenticationAudit(
    request: FastifyRequest,
    protocol: AuthenticationAuditMetadata["protocol"],
    providerId: string,
  ): AuthenticationAuditMetadata {
    const userAgent = request.headers["user-agent"];
    return {
      protocol,
      providerId,
      requestId: String(request.id).slice(0, 128),
      ipAddress: clientAddress(request),
      userAgent:
        typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
    };
  }

  /** Counts throttle hits; every newly locked counter is one lockout (Phase 17.4). */
  async function recordThrottleHits(
    input: Parameters<Phase1Store["recordAuthThrottleHits"]>[0],
  ): Promise<void> {
    const locked = await dependencies.store.recordAuthThrottleHits(input);
    for (const scope of locked) metrics.recordLockout(scope);
  }

  async function recordAuthenticationFailure(
    request: FastifyRequest,
    protocol: AuthenticationAuditMetadata["protocol"],
    providerId: string,
    category: AuthenticationFailureCategory,
  ): Promise<void> {
    metrics.recordLoginFailure(loginProtocol(protocol), category);
    await dependencies.store.recordAuthenticationFailure({
      category,
      audit: authenticationAudit(request, protocol, providerId),
    });
  }

  function validateOrigin(request: FastifyRequest, reply: FastifyReply): boolean {
    const origin = request.headers.origin;
    if (
      origin === undefined ||
      (origin !== dependencies.portalOrigin &&
        !dependencies.portalAllowedOrigins?.includes(origin))
    ) {
      void reply
        .code(403)
        .send(errorBody("INVALID_ORIGIN", "Request origin is not allowed"));
      return false;
    }
    return true;
  }

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthContext | null> {
    const rawToken = parseCookie(request.headers.cookie, cookieName);
    if (rawToken === null) {
      await reply
        .code(401)
        .send(errorBody("UNAUTHENTICATED", "Authentication is required"));
      return null;
    }

    const session = await dependencies.store.findActiveSession(
      hashOpaqueToken(rawToken),
      now(),
    );
    if (session === null) {
      await reply
        .code(401)
        .send(errorBody("UNAUTHENTICATED", "Authentication is required"));
      return null;
    }
    request.log = request.log.child({ userId: session.user.id });
    return { rawToken, session };
  }

  async function authenticateAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthContext | null> {
    const auth = await authenticate(request, reply);
    if (auth === null) return null;
    if (auth.session.user.role !== "admin") {
      await reply
        .code(403)
        .send(errorBody("FORBIDDEN", "Administrator access is required"));
      return null;
    }
    return auth;
  }

  function validateCsrf(
    request: FastifyRequest,
    reply: FastifyReply,
    rawToken: string,
  ): boolean {
    const supplied = request.headers["x-csrf-token"];
    const expected = deriveCsrfToken(rawToken, dependencies.sessionSecret);
    if (
      typeof supplied !== "string" ||
      !constantTimeTextEqual(supplied, expected)
    ) {
      void reply
        .code(403)
        .send(errorBody("INVALID_CSRF", "CSRF validation failed"));
      return false;
    }
    return true;
  }

  return {
    dependencies,
    now,
    metrics,
    usage,
    recordThrottleHits,
    workspaceBaseUrl,
    cookieName,
    oidcTransactionCookieName,
    oauth2TransactionCookieName,
    externalProviderIds,
    authenticationAudit,
    recordAuthenticationFailure,
    clientAddress,
    sendRateLimited,
    sendThrottleUnavailable,
    validateOrigin,
    authenticate,
    authenticateAdmin,
    validateCsrf,
  };
}

export type RouteContext = ReturnType<typeof createRouteContext>;
