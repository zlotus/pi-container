import { z } from "zod";
import type { FastifyInstance } from "fastify";

import type { RouteContext } from "../context.js";
import { errorBody } from "../http.js";
import { publicWorker, publicWorkspace } from "../presenters.js";

const AdminWorkerParamsSchema = z
  .object({ id: z.string().min(1).max(64).regex(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/) })
  .strict();

const UpdateWorkerSchedulingBodySchema = z
  .object({ schedulable: z.boolean() })
  .strict();

/** Admin Worker inventory, scheduling pause and the read-only Workspace overview. */
export function registerAdminWorkerRoutes(app: FastifyInstance, context: RouteContext): void {
  const {
    dependencies,
    now,
    validateOrigin,
    authenticateAdmin,
    validateCsrf,
  } = context;

  app.get("/api/admin/workers", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const currentTime = now();
    const workers = await dependencies.workerStore.listWorkersWithAssignments();
    reply.header("cache-control", "no-store");
    return {
      workers: workers.map((worker) =>
        publicWorker(
          worker,
          currentTime,
          dependencies.workerOfflineAfterMs,
        ),
      ),
    };
  });

  app.patch("/api/admin/workers/:id", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = AdminWorkerParamsSchema.safeParse(request.params);
    const body = UpdateWorkerSchedulingBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid Worker update"));
    }
    const userAgent = request.headers["user-agent"];
    const result = await dependencies.workerStore.setWorkerSchedulable({
      workerId: params.data.id,
      schedulable: body.data.schedulable,
      audit: {
        actorUserId: auth.session.user.id,
        requestId: String(request.id).slice(0, 128),
        ipAddress: request.ip.slice(0, 128),
        userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
      },
    });
    if (result.outcome === "NOT_FOUND") {
      return reply
        .code(404)
        .send(errorBody("WORKER_NOT_FOUND", "Worker was not found"));
    }
    reply.header("cache-control", "no-store");
    return {
      worker: publicWorker(result.worker, now(), dependencies.workerOfflineAfterMs),
    };
  });

  app.get("/api/admin/workspaces", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const workspaces = await dependencies.store.listAllWorkspaces();
    reply.header("cache-control", "no-store");
    // Metadata only: admin role grants no Workspace content access or open/exchange.
    return {
      workspaces: workspaces.map((workspace) => ({
        ...publicWorkspace(workspace),
        owner: {
          id: workspace.userId,
          username: workspace.ownerUsername,
          email: workspace.ownerEmail,
        },
      })),
    };
  });
}
