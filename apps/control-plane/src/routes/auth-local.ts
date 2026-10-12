import { randomUUID } from "node:crypto";
import { deriveCsrfToken, generateOpaqueToken, hashOpaqueToken, verifyPassword } from "@agent-runtime/auth";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

import type { RouteContext } from "../context.js";
import { errorBody, sessionCookie } from "../http.js";
import { publicUser } from "../presenters.js";

const LoginBodySchema = z
  .object({
    login: z.string().trim().min(3).max(320),
    password: z.string().min(1).max(1_024),
  })
  .strict();

const INVALID_LOGIN_HASH =
  "scrypt$N=16384,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg$91N6IibOCNGoJIaLSVpuW8f6Qg4lxDxxq0yCck7RYgnoDkMSGEYhoP9aqNjR08hwW6OkhlITEQoD_Hoq0k5wxQ";

/** Local password login, logout and the current session. */
export function registerLocalAuthRoutes(app: FastifyInstance, context: RouteContext): void {
  const {
    dependencies,
    now,
    cookieName,
    authenticationAudit,
    recordAuthenticationFailure,
    clientAddress,
    sendRateLimited,
    sendThrottleUnavailable,
    recordThrottleHits,
    validateOrigin,
    authenticate,
    validateCsrf,
  } = context;

  app.post("/api/auth/login", async (request, reply) => {
    if (!validateOrigin(request, reply)) {
      return reply;
    }
    const guard = dependencies.loginGuard;
    const address = clientAddress(request);
    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      try {
        const lockedUntil = await dependencies.store.findAuthLock(
          guard.addressKeys(address),
          now(),
        );
        if (lockedUntil !== null) return sendRateLimited(reply, lockedUntil, "local_login", "LOCAL");
        await recordThrottleHits({
          hits: [guard.addressFailureHit(address)],
          now: now(),
          audit: authenticationAudit(request, "LOCAL", "local"),
        });
      } catch (error) {
        request.log.error({ err: error }, "login throttle unavailable");
        return sendThrottleUnavailable(reply);
      }
      await recordAuthenticationFailure(
        request,
        "LOCAL",
        "local",
        "invalid_request",
      );
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid login request"));
    }

    const user = await dependencies.store.findUserByLogin(parsed.data.login);
    // Unknown logins are counted exactly like existing ones, so a lock reveals nothing.
    const account = guard.accountKey(parsed.data.login, user?.id ?? null);
    try {
      const lockedUntil = await dependencies.store.findAuthLock(
        guard.localLoginKeys(account, address),
        now(),
      );
      // Locked attempts are answered before any password work and are not counted.
      if (lockedUntil !== null) return sendRateLimited(reply, lockedUntil, "local_login", "LOCAL");
    } catch (error) {
      request.log.error({ err: error }, "login throttle unavailable");
      return sendThrottleUnavailable(reply);
    }

    const passwordMatches = await verifyPassword(
      parsed.data.password,
      user?.passwordHash ?? INVALID_LOGIN_HASH,
    );
    if (user === null || !passwordMatches || user.status !== "active") {
      try {
        await recordThrottleHits({
          hits: guard.localLoginFailureHits(account, address, user?.id ?? null),
          now: now(),
          audit: authenticationAudit(request, "LOCAL", "local"),
        });
      } catch (error) {
        request.log.error({ err: error }, "login throttle unavailable");
        return sendThrottleUnavailable(reply);
      }
      await recordAuthenticationFailure(
        request,
        "LOCAL",
        "local",
        "invalid_credentials",
      );
      return reply
        .code(401)
        .send(errorBody("INVALID_CREDENTIALS", "Invalid login or password"));
    }

    const rawToken = generateOpaqueToken();
    const expiresAt = new Date(now().getTime() + dependencies.sessionTtlMs);
    const created = await dependencies.store.createSession({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt,
      audit: authenticationAudit(request, "LOCAL", "local"),
    });
    if (!created) {
      await recordAuthenticationFailure(
        request,
        "LOCAL",
        "local",
        "invalid_credentials",
      );
      return reply
        .code(401)
        .send(errorBody("INVALID_CREDENTIALS", "Invalid login or password"));
    }

    context.metrics.recordLogin("local", "success");
    // Only this account+address counter is forgiven; the address and account counters
    // keep running so one legitimate login cannot reset an ongoing attack.
    await dependencies.store.clearAuthThrottle([
      guard.accountAddressKey(account, address),
    ]);
    reply.header(
      "set-cookie",
      sessionCookie(
        cookieName,
        rawToken,
        Math.floor(dependencies.sessionTtlMs / 1_000),
        dependencies.secureCookies,
      ),
    );
    reply.header("cache-control", "no-store");
    return {
      user: publicUser(user),
      csrfToken: deriveCsrfToken(rawToken, dependencies.sessionSecret),
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }

    await dependencies.store.revokeSession(
      hashOpaqueToken(auth.rawToken),
      now(),
      {
        actorUserId: auth.session.user.id,
        ...authenticationAudit(request, "LOCAL", "local"),
      },
    );
    dependencies.sessionConnections?.closeSession(auth.session.sessionId);
    reply.header(
      "set-cookie",
      sessionCookie(cookieName, "", 0, dependencies.secureCookies),
    );
    return reply.code(204).send();
  });

  app.get("/api/me", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    reply.header("cache-control", "no-store");
    return {
      user: publicUser(auth.session.user),
      csrfToken: deriveCsrfToken(auth.rawToken, dependencies.sessionSecret),
    };
  });
}
