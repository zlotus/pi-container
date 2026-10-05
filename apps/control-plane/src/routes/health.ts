import type { FastifyInstance } from "fastify";

import type { RouteContext } from "../context.js";

/** Liveness and readiness probes. */
export function registerHealthRoutes(app: FastifyInstance, context: RouteContext): void {
  const {
    dependencies,
  } = context;

  app.get("/health", async () => ({
    service: "control-plane",
    status: "ok",
  }));

  app.get("/ready", async (_request, reply) => {
    try {
      await dependencies.checkDatabase();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
}
