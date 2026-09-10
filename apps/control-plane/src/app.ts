import Fastify, { type FastifyInstance } from "fastify";

export interface ControlPlaneDependencies {
  checkDatabase: () => Promise<void>;
}

export function buildControlPlane(
  dependencies: ControlPlaneDependencies,
): FastifyInstance {
  const app = Fastify({ logger: false });

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

  return app;
}
