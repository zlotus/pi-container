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
import type { OAuth2Runtime } from "./oauth2.js";
import type { OidcRuntime } from "./oidc.js";
import type { SessionConnectionRegistry } from "./session-connections.js";
import type { WorkspaceSessionExchange } from "./session-exchange.js";
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
>;

type WorkerAdminStore = Pick<
  Repository,
  "listWorkersWithAssignments" | "setWorkerSchedulable"
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
  workspaceBaseUrl: string;
  sessionExchanges: WorkspaceSessionExchange;
  sessionConnections?: SessionConnectionRegistry;
  oidc?: OidcRuntime;
  oauth2?: OAuth2Runtime;
  reportRecoveryIssue?: (
    issue: WorkerRecoveryIssue & { workerId: string },
  ) => void;
  now?: () => Date;
  /** Structured logger; request logging is disabled when omitted (unit tests). */
  log?: Logger;
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
      ipAddress: request.ip.slice(0, 128),
      userAgent:
        typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
    };
  }

  async function recordAuthenticationFailure(
    request: FastifyRequest,
    protocol: AuthenticationAuditMetadata["protocol"],
    providerId: string,
    category: AuthenticationFailureCategory,
  ): Promise<void> {
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
    workspaceBaseUrl,
    cookieName,
    oidcTransactionCookieName,
    oauth2TransactionCookieName,
    externalProviderIds,
    authenticationAudit,
    recordAuthenticationFailure,
    validateOrigin,
    authenticate,
    authenticateAdmin,
    validateCsrf,
  };
}

export type RouteContext = ReturnType<typeof createRouteContext>;
