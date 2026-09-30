import { randomUUID } from "node:crypto";
import { generateOpaqueToken, hashOpaqueToken } from "@agent-runtime/auth";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RouteContext } from "../context.js";
import type { ExternalIdentityProfile } from "../external-auth.js";
import { errorBody, parseCookie, sessionCookie } from "../http.js";

function normalizedJitEmail(
  email: string | null,
  allowedDomains: readonly string[],
): string | null | undefined {
  if (email === null) return allowedDomains.length === 0 ? null : undefined;
  const normalized = email.trim().toLowerCase();
  const parsed = z.string().email().max(320).safeParse(normalized);
  if (!parsed.success) return allowedDomains.length === 0 ? null : undefined;
  const separator = normalized.lastIndexOf("@");
  const domain = normalized.slice(separator + 1);
  if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) return undefined;
  return normalized;
}

function normalizedJitUsername(username: string | null): string | null {
  if (username === null) return null;
  const normalized = username.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)
    ? normalized
    : null;
}

/** OIDC and OAuth2 login and callbacks; both end in a Platform server-side session. */
export function registerExternalAuthRoutes(app: FastifyInstance, context: RouteContext): void {
  const {
    dependencies,
    now,
    cookieName,
    oidcTransactionCookieName,
    oauth2TransactionCookieName,
    authenticationAudit,
    recordAuthenticationFailure,
  } = context;

  async function completeExternalAuthentication(input: {
    request: FastifyRequest;
    protocol: "OIDC" | "OAUTH2";
    providerId: string;
    profile: ExternalIdentityProfile;
    autoProvision: boolean;
    allowedDomains: readonly string[];
    clearedTransactionCookie: string;
    reply: FastifyReply;
  }) {
    const normalizedEmail = normalizedJitEmail(
      input.profile.emailSnapshot,
      input.allowedDomains,
    );
    const rawToken = generateOpaqueToken();
    const authenticatedAt = now();
    const result = await dependencies.store.completeExternalLogin({
      providerId: input.providerId,
      providerSubject: input.profile.subject,
      usernameSnapshot: input.profile.usernameSnapshot,
      emailSnapshot: input.profile.emailSnapshot,
      displayNameSnapshot: input.profile.displayNameSnapshot,
      autoProvision: input.autoProvision,
      provisionedUser:
        normalizedEmail === undefined
          ? null
          : {
              id: randomUUID(),
              email: normalizedEmail,
              username: normalizedJitUsername(input.profile.usernameSnapshot),
            },
      identityId: randomUUID(),
      sessionId: randomUUID(),
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt: new Date(authenticatedAt.getTime() + dependencies.sessionTtlMs),
      authenticatedAt,
      audit: authenticationAudit(
        input.request,
        input.protocol,
        input.providerId,
      ),
    });
    if (result.outcome === "UNKNOWN_IDENTITY") {
      return input.reply
        .code(403)
        .send(
          errorBody(
            `${input.protocol}_IDENTITY_NOT_BOUND`,
            `${input.protocol} identity is not authorized for this platform`,
          ),
        );
    }
    if (result.outcome === "PROVISIONING_NOT_ALLOWED") {
      return input.reply
        .code(403)
        .send(
          errorBody(
            `${input.protocol}_PROVISIONING_NOT_ALLOWED`,
            `${input.protocol} identity is not allowed for JIT provisioning`,
          ),
        );
    }
    if (result.outcome === "USER_DISABLED") {
      return input.reply
        .code(403)
        .send(
          errorBody(
            `${input.protocol}_USER_DISABLED`,
            "Platform User is disabled",
          ),
        );
    }
    input.reply.header("set-cookie", [
      input.clearedTransactionCookie,
      sessionCookie(
        cookieName,
        rawToken,
        Math.floor(dependencies.sessionTtlMs / 1_000),
        dependencies.secureCookies,
      ),
    ]);
    return input.reply.redirect(dependencies.portalOrigin);
  }

  app.get("/api/auth/methods", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      oidc: {
        enabled: dependencies.oidc !== undefined,
        providerId: dependencies.oidc?.providerId ?? null,
      },
      oauth2: {
        enabled: dependencies.oauth2 !== undefined,
        providerId: dependencies.oauth2?.providerId ?? null,
      },
    };
  });

  app.get("/auth/oidc/login", async (request, reply) => {
    if (dependencies.oidc === undefined) {
      return reply
        .code(404)
        .send(errorBody("OIDC_DISABLED", "OIDC login is not enabled"));
    }
    try {
      const authorization =
        await dependencies.oidc.client.createAuthorizationRequest(
          dependencies.oidc.redirectUri,
        );
      const handle = dependencies.oidc.transactions.create(
        authorization.transaction,
        now(),
      );
      reply.header(
        "set-cookie",
        sessionCookie(
          oidcTransactionCookieName,
          handle,
          10 * 60,
          dependencies.secureCookies,
        ),
      );
      reply.header("cache-control", "no-store");
      return reply.redirect(authorization.url.href);
    } catch {
      await recordAuthenticationFailure(
        request,
        "OIDC",
        dependencies.oidc.providerId,
        "provider_unavailable",
      );
      return reply
        .code(503)
        .send(errorBody("OIDC_UNAVAILABLE", "OIDC login is unavailable"));
    }
  });

  app.get("/auth/oidc/callback", async (request, reply) => {
    if (dependencies.oidc === undefined) {
      return reply
        .code(404)
        .send(errorBody("OIDC_DISABLED", "OIDC login is not enabled"));
    }
    const clearedTransactionCookie = sessionCookie(
      oidcTransactionCookieName,
      "",
      0,
      dependencies.secureCookies,
    );
    reply.header("set-cookie", clearedTransactionCookie);
    reply.header("cache-control", "no-store");
    const handle = parseCookie(
      request.headers.cookie,
      oidcTransactionCookieName,
    );
    const transaction =
      handle === null
        ? null
        : dependencies.oidc.transactions.consume(handle, now());
    if (transaction === null) {
      await recordAuthenticationFailure(
        request,
        "OIDC",
        dependencies.oidc.providerId,
        "transaction_invalid",
      );
      return reply
        .code(400)
        .send(
          errorBody(
            "OIDC_TRANSACTION_INVALID",
            "OIDC login transaction is missing, expired, or already used",
          ),
        );
    }

    let identity: ExternalIdentityProfile;
    try {
      const requestUrl = new URL(
        request.raw.url ?? "/",
        "http://callback.invalid",
      );
      const callbackUrl = new URL(dependencies.oidc.redirectUri);
      callbackUrl.search = requestUrl.search;
      identity = await dependencies.oidc.client.exchangeAuthorizationCode({
        callbackUrl,
        redirectUri: dependencies.oidc.redirectUri,
        transaction,
      });
    } catch {
      await recordAuthenticationFailure(
        request,
        "OIDC",
        dependencies.oidc.providerId,
        "protocol_validation_failed",
      );
      return reply
        .code(401)
        .send(
          errorBody(
            "OIDC_AUTHENTICATION_FAILED",
            "OIDC authentication failed",
          ),
        );
    }

    return completeExternalAuthentication({
      request,
      protocol: "OIDC",
      providerId: dependencies.oidc.providerId,
      profile: identity,
      autoProvision: dependencies.oidc.autoProvision,
      allowedDomains: dependencies.oidc.allowedDomains,
      clearedTransactionCookie,
      reply,
    });
  });

  app.get("/auth/oauth2/login", async (request, reply) => {
    if (dependencies.oauth2 === undefined) {
      return reply
        .code(404)
        .send(errorBody("OAUTH2_DISABLED", "OAuth2 login is not enabled"));
    }
    try {
      const authorization =
        await dependencies.oauth2.client.createAuthorizationRequest(
          dependencies.oauth2.redirectUri,
        );
      const handle = dependencies.oauth2.transactions.create(
        authorization.transaction,
        now(),
      );
      reply.header(
        "set-cookie",
        sessionCookie(
          oauth2TransactionCookieName,
          handle,
          10 * 60,
          dependencies.secureCookies,
        ),
      );
      reply.header("cache-control", "no-store");
      return reply.redirect(authorization.url.href);
    } catch {
      await recordAuthenticationFailure(
        request,
        "OAUTH2",
        dependencies.oauth2.providerId,
        "provider_unavailable",
      );
      return reply
        .code(503)
        .send(errorBody("OAUTH2_UNAVAILABLE", "OAuth2 login is unavailable"));
    }
  });

  app.get("/auth/oauth2/callback", async (request, reply) => {
    if (dependencies.oauth2 === undefined) {
      return reply
        .code(404)
        .send(errorBody("OAUTH2_DISABLED", "OAuth2 login is not enabled"));
    }
    const clearedTransactionCookie = sessionCookie(
      oauth2TransactionCookieName,
      "",
      0,
      dependencies.secureCookies,
    );
    reply.header("set-cookie", clearedTransactionCookie);
    reply.header("cache-control", "no-store");
    const handle = parseCookie(
      request.headers.cookie,
      oauth2TransactionCookieName,
    );
    const transaction =
      handle === null
        ? null
        : dependencies.oauth2.transactions.consume(handle, now());
    if (transaction === null) {
      await recordAuthenticationFailure(
        request,
        "OAUTH2",
        dependencies.oauth2.providerId,
        "transaction_invalid",
      );
      return reply
        .code(400)
        .send(
          errorBody(
            "OAUTH2_TRANSACTION_INVALID",
            "OAuth2 login transaction is missing, expired, or already used",
          ),
        );
    }

    let identity: ExternalIdentityProfile;
    try {
      const requestUrl = new URL(
        request.raw.url ?? "/",
        "http://callback.invalid",
      );
      const callbackUrl = new URL(dependencies.oauth2.redirectUri);
      callbackUrl.search = requestUrl.search;
      identity = await dependencies.oauth2.client.exchangeAuthorizationCode({
        callbackUrl,
        redirectUri: dependencies.oauth2.redirectUri,
        transaction,
      });
    } catch {
      await recordAuthenticationFailure(
        request,
        "OAUTH2",
        dependencies.oauth2.providerId,
        "protocol_validation_failed",
      );
      return reply
        .code(401)
        .send(
          errorBody(
            "OAUTH2_AUTHENTICATION_FAILED",
            "OAuth2 authentication failed",
          ),
        );
    }
    return completeExternalAuthentication({
      request,
      protocol: "OAUTH2",
      providerId: dependencies.oauth2.providerId,
      profile: identity,
      autoProvision: dependencies.oauth2.autoProvision,
      allowedDomains: dependencies.oauth2.allowedDomains,
      clearedTransactionCookie,
      reply,
    });
  });
}
