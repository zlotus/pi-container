import { AUDIT_EVENT_CATEGORIES } from "@agent-runtime/database";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

import type { RouteContext } from "../context.js";
import { errorBody } from "../http.js";
import { publicAuditEvent } from "../presenters.js";

const AuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.string().regex(/^[1-9][0-9]*$/).optional(),
    category: z.enum(AUDIT_EVENT_CATEGORIES).optional(),
    userId: z.string().uuid().optional(),
    workspaceId: z.string().uuid().optional(),
    workerId: z.string().min(1).max(128).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/** Platform audit event queries within the caller visibility scope. */
export function registerAuditRoutes(app: FastifyInstance, context: RouteContext): void {
  const {
    dependencies,
    authenticate,
  } = context;

  app.get("/api/audit-events", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) return reply;
    const query = AuditQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid audit event query"));
    }
    const events = await dependencies.store.listAuditEvents({
      userId: auth.session.user.id,
      includeAllUsers: auth.session.user.role === "admin",
      limit: query.data.limit,
      beforeId: query.data.before ?? null,
      filter: {
        category: query.data.category ?? null,
        userId: query.data.userId ?? null,
        workspaceId: query.data.workspaceId ?? null,
        workerId: query.data.workerId ?? null,
        from: query.data.from === undefined ? null : new Date(query.data.from),
        to: query.data.to === undefined ? null : new Date(query.data.to),
      },
    });
    reply.header("cache-control", "no-store");
    return { events: events.map(publicAuditEvent) };
  });
}
