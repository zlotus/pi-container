import type { AuthLockRecord } from "@agent-runtime/database";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { RouteContext } from "../context.js";
import { errorBody } from "../http.js";

const AuthLockParamsSchema = z.object({ id: z.string().uuid() }).strict();

function publicAuthLock(lock: AuthLockRecord) {
  return {
    id: lock.id,
    scope: lock.scope,
    ipAddress: lock.ipAddress,
    user: lock.userId === null ? null : { id: lock.userId, email: lock.userEmail },
    failures: lock.failures,
    lockedUntil: lock.lockedUntil.toISOString(),
  };
}

/** Active login locks and their manual removal (specs.md Phase 15.9). */
export function registerAdminAuthLockRoutes(app: FastifyInstance, context: RouteContext): void {
  const { dependencies, now, validateOrigin, authenticateAdmin, validateCsrf } = context;

  app.get("/api/admin/auth/locks", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const locks = await dependencies.store.listAuthLocks(now());
    reply.header("cache-control", "no-store");
    return { locks: locks.map(publicAuthLock) };
  });

  app.delete("/api/admin/auth/locks/:id", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (!validateOrigin(request, reply) || !validateCsrf(request, reply, auth.rawToken)) {
      return reply;
    }
    const params = AuthLockParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid lock id"));
    }
    const cleared = await dependencies.store.clearAuthLocks({
      target: { kind: "id", id: params.data.id },
      now: now(),
      source: "admin",
      actorUserId: auth.session.user.id,
      requestId: String(request.id).slice(0, 128),
    });
    if (cleared === 0) {
      return reply
        .code(404)
        .send(errorBody("AUTH_LOCK_NOT_FOUND", "Login lock was not found or has expired"));
    }
    return reply.code(204).send();
  });
}
