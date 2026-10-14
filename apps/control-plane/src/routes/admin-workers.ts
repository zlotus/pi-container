import { z } from "zod";
import type { FastifyInstance } from "fastify";

import type { RouteContext } from "../context.js";
import { errorBody } from "../http.js";
import { publicWorker, publicWorkspace, workspaceRuntime } from "../presenters.js";
import type { RuntimeCommands } from "../runtime-commands.js";

const AdminWorkerParamsSchema = z
  .object({ id: z.string().min(1).max(64).regex(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/) })
  .strict();

const AdminWorkspaceParamsSchema = z.object({ id: z.string().uuid() }).strict();

const UpdateWorkspaceBodySchema = z
  .object({ diskLimitBytes: z.number().int().positive() })
  .strict();

const GIB = 1024 ** 3;

const UpdateWorkerSchedulingBodySchema = z
  .object({ schedulable: z.boolean() })
  .strict();

/** Admin Worker inventory, scheduling pause, the Workspace overview and disk limits. */
export function registerAdminWorkerRoutes(
  app: FastifyInstance,
  context: RouteContext,
  runtime: RuntimeCommands,
): void {
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
      defaultRuntimeImage: dependencies.defaultRuntimeImage,
      workers: workers.map((worker) =>
        publicWorker(
          worker,
          currentTime,
          dependencies.workerOfflineAfterMs,
          context.usage.worker(worker.id),
          dependencies.defaultRuntimeImage,
        ),
      ),
    };
  });

  /** The lifecycle policies an operator configured (specs.md Phase 18.8); read-only. */
  app.get("/api/admin/lifecycle", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    reply.header("cache-control", "no-store");
    const idle = dependencies.idle?.policy;
    return {
      idle:
        idle === undefined
          ? { enabled: false, stopAfterHours: null, cpuThresholdCores: null }
          : { enabled: true, stopAfterHours: idle.stopAfterHours, cpuThresholdCores: idle.cpuThresholdCores },
      defaultRuntimeImage: dependencies.defaultRuntimeImage,
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
        ipAddress: context.clientAddress(request),
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
      worker: publicWorker(
        result.worker,
        now(),
        dependencies.workerOfflineAfterMs,
        context.usage.worker(result.worker.id),
      ),
    };
  });

  app.get("/api/admin/workspaces", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const [workspaces, images] = await Promise.all([
      dependencies.store.listAllWorkspaces(),
      dependencies.workerStore.listWorkerRuntimeImages(),
    ]);
    reply.header("cache-control", "no-store");
    // Metadata only: admin role grants no Workspace content access or open/exchange.
    return {
      workspaces: workspaces.map((workspace) => ({
        ...publicWorkspace(
          workspace,
          undefined,
          context.usage.workspace(workspace.id, workspace.workerId),
          workspaceRuntime(
            workspace,
            workspace.workerId === null ? [] : (images.get(workspace.workerId) ?? []),
            dependencies.defaultRuntimeImage,
          ),
        ),
        /** Every image the Workspace's Worker offers, for the admin Runtime change. */
        offeredImages: (workspace.workerId === null ? [] : (images.get(workspace.workerId) ?? [])).map(
          (image) => ({ image: image.image, runtimeVersion: image.runtimeVersion }),
        ),
        owner: {
          id: workspace.userId,
          username: workspace.ownerUsername,
          email: workspace.ownerEmail,
        },
      })),
    };
  });

  app.patch("/api/admin/workspaces/:id", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = AdminWorkspaceParamsSchema.safeParse(request.params);
    const body = UpdateWorkspaceBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid Workspace update"));
    }
    if (
      body.data.diskLimitBytes < GIB ||
      body.data.diskLimitBytes > dependencies.workspaceDiskLimitMaxBytes
    ) {
      return reply
        .code(400)
        .send(
          errorBody(
            "DISK_LIMIT_OUT_OF_RANGE",
            "Disk limit is outside the allowed range",
          ),
        );
    }
    const userAgent = request.headers["user-agent"];
    const result = await dependencies.store.updateWorkspaceDiskLimit({
      workspaceId: params.data.id,
      diskLimitBytes: body.data.diskLimitBytes,
      audit: {
        actorUserId: auth.session.user.id,
        requestId: String(request.id).slice(0, 128),
        ipAddress: context.clientAddress(request),
        userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
      },
    });
    if (result.outcome === "NOT_FOUND") {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    // The stored limit is authoritative; an offline Worker gets it on the next start.
    const applied =
      result.workspace.workerId === null
        ? false
        : await runtime.setWorkspaceDiskLimit(
            result.workspace.workerId,
            result.workspace.id,
            body.data.diskLimitBytes,
          );
    reply.header("cache-control", "no-store");
    return { workspace: publicWorkspace(result.workspace), applied };
  });
}
