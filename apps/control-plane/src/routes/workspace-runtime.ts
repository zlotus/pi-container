import { randomUUID } from "node:crypto";

import type { RuntimeChangeDirection, WorkspaceRecord } from "@agent-runtime/database";
import { RuntimeImageRefSchema, WORKER_PROTOCOL_VERSION } from "@agent-runtime/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { RouteContext } from "../context.js";
import { errorBody } from "../http.js";
import { publicWorkspace, runtimeChangeIncomplete, workspaceRuntime } from "../presenters.js";
import type { RuntimeCommands } from "../runtime-commands.js";

const WorkspaceParamsSchema = z.object({ id: z.string().uuid() }).strict();
const AdminRuntimeBodySchema = z.object({ image: RuntimeImageRefSchema }).strict();

/**
 * Worker refusals that guarantee nothing was changed (specs.md Phase 18.4): the Workspace
 * goes back to exactly what it was. Every other failure leaves the outcome unknown.
 */
const UNCHANGED_REFUSALS = new Set([
  "RUNTIME_IMAGE_UNAVAILABLE",
  "WORKSPACE_RUNNING",
  "STORAGE_MIGRATION_REQUIRED",
  "WORKSPACE_METADATA_MISMATCH",
  "WORKSPACE_NOT_MANAGED",
  "UNMANAGED_CONTAINER_CONFLICT",
]);

type ChangeOutcome =
  | { ok: true }
  | { ok: false; statusCode: 404 | 409 | 502 | 503; code: string; message: string };

/** Runtime upgrade, rollback and admin Runtime change of a stopped Workspace (18.4). */
export function registerWorkspaceRuntimeRoutes(
  app: FastifyInstance,
  context: RouteContext,
  runtime: RuntimeCommands,
): void {
  const { dependencies, validateOrigin, authenticate, authenticateAdmin, validateCsrf, metrics } = context;

  async function offeredImages(workerId: string | null) {
    if (workerId === null) return [];
    return (await dependencies.workerStore.listWorkerRuntimeImages()).get(workerId) ?? [];
  }

  async function present(workspace: WorkspaceRecord) {
    return publicWorkspace(
      workspace,
      undefined,
      null,
      workspaceRuntime(workspace, await offeredImages(workspace.workerId), dependencies.defaultRuntimeImage),
    );
  }

  async function change(
    workspace: WorkspaceRecord,
    target: string,
    direction: Exclude<RuntimeChangeDirection, "retry">,
    actorUserId: string,
  ): Promise<ChangeOutcome> {
    const incomplete = runtimeChangeIncomplete(workspace);
    if (!(workspace.state === "STOPPED" || incomplete) || workspace.workerId === null) {
      return { ok: false, statusCode: 409, code: "WORKSPACE_NOT_STOPPED", message: "Stop the Workspace first" };
    }
    if (target === workspace.runtimeImage && !incomplete) {
      return { ok: false, statusCode: 409, code: "RUNTIME_ALREADY_CURRENT", message: "Workspace already uses this Runtime" };
    }
    const workerId = workspace.workerId;
    const offered = await offeredImages(workerId);
    if (!offered.some((image) => image.image === target)) {
      return {
        ok: false,
        statusCode: 409,
        code: "RUNTIME_IMAGE_UNAVAILABLE",
        message: "The Workspace's Worker does not offer this Runtime",
      };
    }
    if (!runtime.workerChannel.isConnected(workerId)) {
      return { ok: false, statusCode: 503, code: "WORKER_UNAVAILABLE", message: "Assigned Worker is unavailable" };
    }
    // A retry continues an interrupted change; a rollback reverses it.
    const fromImage =
      target === workspace.runtimeImage ? workspace.previousRuntimeImage : workspace.runtimeImage;
    if (fromImage === null || fromImage === target) {
      return { ok: false, statusCode: 409, code: "RUNTIME_ALREADY_CURRENT", message: "Workspace already uses this Runtime" };
    }
    const recorded: RuntimeChangeDirection = incomplete && target === workspace.runtimeImage ? "retry" : direction;
    // What a clean refusal restores, taken before anything is written.
    const restore = {
      runtimeImage: workspace.runtimeImage,
      previousRuntimeImage: workspace.previousRuntimeImage,
      runtimeChangedAt: workspace.runtimeChangedAt,
      state: workspace.state === "ERROR" ? ("ERROR" as const) : ("STOPPED" as const),
    };
    // Intent first (Phase 6): a disconnect during the command is resolved by reconciliation.
    const begun = await dependencies.store.beginWorkspaceRuntimeChange({
      workspaceId: workspace.id,
      workerId,
      fromImage,
      toImage: target,
      direction: recorded,
      actorUserId,
    });
    if (!begun) {
      return { ok: false, statusCode: 409, code: "WORKSPACE_CHANGED", message: "Workspace state changed; retry" };
    }
    const result = await runtime.dispatchRuntimeCommand(workerId, {
      version: WORKER_PROTOCOL_VERSION,
      type: "workspace.runtime.set",
      requestId: randomUUID(),
      payload: { workspaceId: workspace.id, fromImage, toImage: target },
    });
    const failure = result.ok ? runtime.validateRuntimeResult(result, target, ["STOPPED"]) : result;
    if (failure === null) {
      await dependencies.store.finishWorkspaceRuntimeChange({
        workspaceId: workspace.id,
        workerId,
        toImage: target,
        actorUserId,
      });
      metrics.recordRuntimeChange(recorded, "ok");
      return { ok: true };
    }
    if (!failure.workerOffline && UNCHANGED_REFUSALS.has(failure.code)) {
      await dependencies.store.revertWorkspaceRuntimeChange({
        workspaceId: workspace.id,
        workerId,
        restore,
        code: failure.code,
        actorUserId,
      });
      metrics.recordRuntimeChange(recorded, "reverted");
    } else {
      // Unknown outcome: ERROR (or WORKER_OFFLINE) until a retry, rollback or reconciliation.
      await runtime.markRuntimeFailure(workspace.id, workerId, failure);
      metrics.recordRuntimeChange(recorded, "incomplete");
    }
    return {
      ok: false,
      statusCode: failure.statusCode,
      code: failure.code,
      message: failure.message,
    };
  }

  async function respond(
    reply: FastifyReply,
    outcome: ChangeOutcome,
    reload: () => Promise<WorkspaceRecord | null>,
  ) {
    reply.header("cache-control", "no-store");
    if (!outcome.ok) {
      return reply.code(outcome.statusCode).send(errorBody(outcome.code, outcome.message));
    }
    const current = await reload();
    if (current === null) {
      return reply.code(404).send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    return { workspace: await present(current) };
  }

  for (const direction of ["upgrade", "rollback", "retry"] as const) {
    app.post(`/api/workspaces/:id/runtime/${direction}`, async (request, reply) => {
      const auth = await authenticate(request, reply);
      if (auth === null) return reply;
      if (!validateOrigin(request, reply) || !validateCsrf(request, reply, auth.rawToken)) {
        return reply;
      }
      const params = WorkspaceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
      }
      const userId = auth.session.user.id;
      const workspace = await dependencies.store.findOwnedWorkspace(params.data.id, userId);
      if (workspace === null) {
        return reply.code(404).send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
      }
      // The platform picks the target; a user never names an image. A retry repeats the
      // recorded intent of an interrupted change.
      if (direction === "retry" && !runtimeChangeIncomplete(workspace)) {
        return reply.code(409).send(errorBody("RUNTIME_NO_INCOMPLETE_CHANGE", "No Runtime change to retry"));
      }
      const target =
        direction === "upgrade"
          ? dependencies.defaultRuntimeImage
          : direction === "retry"
            ? workspace.runtimeImage
            : workspace.previousRuntimeImage;
      if (target === null) {
        return reply.code(409).send(errorBody("RUNTIME_NO_PREVIOUS", "There is no previous Runtime to roll back to"));
      }
      const outcome = await change(workspace, target, direction === "retry" ? "upgrade" : direction, userId);
      return respond(reply, outcome, () => dependencies.store.findOwnedWorkspace(workspace.id, userId));
    });
  }

  app.post("/api/admin/workspaces/:id/runtime", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (!validateOrigin(request, reply) || !validateCsrf(request, reply, auth.rawToken)) {
      return reply;
    }
    const params = WorkspaceParamsSchema.safeParse(request.params);
    const body = AdminRuntimeBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid Runtime change"));
    }
    const workspace = await dependencies.store.findWorkspaceById(params.data.id);
    if (workspace === null) {
      return reply.code(404).send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    const outcome = await change(workspace, body.data.image, "admin", auth.session.user.id);
    return respond(reply, outcome, () => dependencies.store.findWorkspaceById(workspace.id));
  });
}
