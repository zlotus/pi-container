import { randomUUID } from "node:crypto";
import { workspaceOrigin } from "@agent-runtime/gateway";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

import type { RouteContext } from "../context.js";
import type { DispatchResult, RuntimeCommands } from "../runtime-commands.js";
import { errorBody, isUniqueViolation } from "../http.js";
import { publicWorkspace } from "../presenters.js";

const CreateWorkspaceBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict();

const WorkspaceParamsSchema = z
  .object({ id: z.string().uuid() })
  .strict();

/** Workspace lifecycle and open for the owning user. */
export function registerWorkspaceRoutes(app: FastifyInstance, context: RouteContext, runtime: RuntimeCommands): void {
  const {
    dependencies,
    now,
    workspaceBaseUrl,
    validateOrigin,
    authenticate,
    validateCsrf,
  } = context;
  const {
    workerChannel,
    dispatchRuntimeCommand,
    markRuntimeFailure,
    sendDispatchFailure,
    validateRuntimeResult,
  } = runtime;

  app.get("/api/workspaces", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    const workspaces = await dependencies.store.listWorkspaces(
      auth.session.user.id,
    );
    return { workspaces: workspaces.map(publicWorkspace) };
  });

  app.post("/api/workspaces", async (request, reply) => {
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
    const parsed = CreateWorkspaceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Workspace name is required"));
    }

    try {
      const workspace = await dependencies.store.createWorkspace({
        id: randomUUID(),
        userId: auth.session.user.id,
        name: parsed.data.name,
        runtimeImage: dependencies.defaultRuntimeImage,
      });
      return reply.code(201).send({ workspace: publicWorkspace(workspace) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply
          .code(409)
          .send(errorBody("WORKSPACE_NAME_EXISTS", "Workspace name already exists"));
      }
      throw error;
    }
  });

  app.get("/api/workspaces/:id", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    const params = WorkspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    const workspace = await dependencies.store.findOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (workspace === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    return { workspace: publicWorkspace(workspace) };
  });

  app.post("/api/workspaces/:id/start", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = WorkspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    const workspace = await dependencies.store.findOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (workspace === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    if (workspace.state === "RUNNING") {
      return { workspace: publicWorkspace(workspace) };
    }

    if (
      workspace.workerId !== null &&
      !workerChannel.isConnected(workspace.workerId)
    ) {
      return reply
        .code(503)
        .send(errorBody("WORKER_UNAVAILABLE", "Assigned Worker is unavailable"));
    }

    const scheduling = await dependencies.store.scheduleWorkspaceStart({
      workspaceId: workspace.id,
      userId: auth.session.user.id,
      heartbeatCutoff: new Date(
        now().getTime() - dependencies.workerOfflineAfterMs,
      ),
      connectedWorkerIds: workerChannel.connectedWorkerIds(),
    });
    if (scheduling.outcome === "NO_ELIGIBLE_WORKER") {
      return reply
        .code(503)
        .send(
          errorBody(
            "NO_ELIGIBLE_WORKER",
            "No eligible Worker is online for this Runtime",
          ),
        );
    }
    if (scheduling.outcome === "WORKSPACE_CHANGED") {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
    }
    const starting = scheduling.workspace;
    const workerId = starting.workerId;
    if (workerId === null) {
      throw new Error("Scheduler returned a Workspace without a Worker");
    }
    if (!workerChannel.isConnected(workerId)) {
      const unavailable: Extract<DispatchResult, { ok: false }> = {
        ok: false,
        workerOffline: true,
        statusCode: 503,
        code: "WORKER_UNAVAILABLE",
        message: "Assigned Worker is unavailable",
      };
      await markRuntimeFailure(workspace.id, workerId, unavailable);
      return sendDispatchFailure(reply, unavailable);
    }

    const ensured = await dispatchRuntimeCommand(workerId, {
      version: 1,
      type: "workspace.ensure",
      requestId: randomUUID(),
      payload: {
        workspaceId: workspace.id,
        runtimeImage: workspace.runtimeImage,
        resources: dependencies.workspaceResources,
      },
    });
    if (!ensured.ok) {
      await markRuntimeFailure(workspace.id, workerId, ensured);
      return sendDispatchFailure(reply, ensured);
    }
    const invalidEnsure = validateRuntimeResult(
      ensured,
      workspace.runtimeImage,
      ["RUNNING", "STOPPED"],
    );
    if (invalidEnsure !== null) {
      await markRuntimeFailure(workspace.id, workerId, invalidEnsure);
      return sendDispatchFailure(reply, invalidEnsure);
    }
    const started = await dispatchRuntimeCommand(workerId, {
      version: 1,
      type: "workspace.start",
      requestId: randomUUID(),
      payload: { workspaceId: workspace.id },
    });
    if (!started.ok) {
      await markRuntimeFailure(workspace.id, workerId, started);
      return sendDispatchFailure(reply, started);
    }
    const invalidStart = validateRuntimeResult(started, workspace.runtimeImage, [
      "RUNNING",
    ]);
    if (invalidStart !== null) {
      await markRuntimeFailure(workspace.id, workerId, invalidStart);
      return sendDispatchFailure(reply, invalidStart);
    }
    if (
      !(await dependencies.store.finishWorkspaceStart({
        workspaceId: workspace.id,
        workerId,
      }))
    ) {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
    }
    const running = await dependencies.store.findOwnedWorkspace(
      workspace.id,
      auth.session.user.id,
    );
    if (running === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    return { workspace: publicWorkspace(running) };
  });

  app.post("/api/workspaces/:id/stop", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = WorkspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    const workspace = await dependencies.store.findOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (workspace === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    if (workspace.state === "STOPPED") {
      return { workspace: publicWorkspace(workspace) };
    }
    const workerId = workspace.workerId;
    if (workerId === null || !workerChannel.isConnected(workerId)) {
      return reply
        .code(503)
        .send(errorBody("WORKER_UNAVAILABLE", "Assigned Worker is unavailable"));
    }
    if (
      !(await dependencies.store.beginWorkspaceStop({
        workspaceId: workspace.id,
        userId: auth.session.user.id,
        workerId,
      }))
    ) {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_CHANGED", "Workspace is not running"));
    }
    const stopped = await dispatchRuntimeCommand(workerId, {
      version: 1,
      type: "workspace.stop",
      requestId: randomUUID(),
      payload: { workspaceId: workspace.id },
    });
    if (!stopped.ok) {
      await markRuntimeFailure(workspace.id, workerId, stopped);
      return sendDispatchFailure(reply, stopped);
    }
    const invalidStop = validateRuntimeResult(stopped, workspace.runtimeImage, [
      "STOPPED",
    ]);
    if (invalidStop !== null) {
      await markRuntimeFailure(workspace.id, workerId, invalidStop);
      return sendDispatchFailure(reply, invalidStop);
    }
    if (
      !(await dependencies.store.finishWorkspaceStop({
        workspaceId: workspace.id,
        workerId,
      }))
    ) {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
    }
    const current = await dependencies.store.findOwnedWorkspace(
      workspace.id,
      auth.session.user.id,
    );
    if (current === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    return { workspace: publicWorkspace(current) };
  });

  app.post("/api/workspaces/:id/open", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = WorkspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    const workspace = await dependencies.store.findOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (workspace === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    if (workspace.state !== "RUNNING" || workspace.workerId === null) {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_NOT_RUNNING", "Workspace is not running"));
    }
    await dependencies.store.recordWorkspaceOpened({
      actorUserId: auth.session.user.id,
      ownerUserId: workspace.userId,
      workspaceId: workspace.id,
      workerId: workspace.workerId,
    });
    const code = dependencies.sessionExchanges.issue({
      rawSessionToken: auth.rawToken,
      userId: auth.session.user.id,
      workspaceId: workspace.id,
      now: now(),
    });
    reply.header("cache-control", "no-store");
    return {
      exchangeUrl: `${workspaceOrigin(workspace.id, workspaceBaseUrl)}/_platform/session`,
      code,
    };
  });

  app.delete("/api/workspaces/:id", async (request, reply) => {
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
    const params = WorkspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }

    const workspace = await dependencies.store.findOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (workspace === null) {
      return reply
        .code(404)
        .send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    if (workspace.workerId !== null) {
      if (!workerChannel.isConnected(workspace.workerId)) {
        return reply
          .code(503)
          .send(
            errorBody("WORKER_UNAVAILABLE", "Assigned Worker is unavailable"),
          );
      }
      const deleting = await dependencies.store.beginWorkspaceDelete({
        workspaceId: workspace.id,
        userId: auth.session.user.id,
        workerId: workspace.workerId,
      });
      if (!deleting) {
        return reply
          .code(409)
          .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
      }
      const deleted = await dispatchRuntimeCommand(workspace.workerId, {
        version: 1,
        type: "workspace.delete",
        requestId: randomUUID(),
        payload: { workspaceId: workspace.id },
      });
      if (!deleted.ok) {
        await markRuntimeFailure(workspace.id, workspace.workerId, deleted);
        return sendDispatchFailure(reply, deleted);
      }
      const invalidDelete = validateRuntimeResult(
        deleted,
        workspace.runtimeImage,
        ["CREATED"],
      );
      if (invalidDelete !== null) {
        await markRuntimeFailure(workspace.id, workspace.workerId, invalidDelete);
        return sendDispatchFailure(reply, invalidDelete);
      }
      const confirmed = await dependencies.store.deleteConfirmedWorkspace({
        workspaceId: workspace.id,
        userId: auth.session.user.id,
        workerId: workspace.workerId,
      });
      if (!confirmed) {
        return reply
          .code(409)
          .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
      }
      return reply.code(204).send();
    }
    if (workspace.state !== "CREATED") {
      return reply
        .code(409)
        .send(
          errorBody(
            "WORKSPACE_DELETE_REQUIRES_WORKER",
            "Assigned workspace deletion must be confirmed by its worker",
          ),
        );
    }

    const deleted = await dependencies.store.deleteOwnedWorkspace(
      params.data.id,
      auth.session.user.id,
    );
    if (!deleted) {
      return reply
        .code(409)
        .send(errorBody("WORKSPACE_CHANGED", "Workspace state changed; retry"));
    }
    return reply.code(204).send();
  });
}
