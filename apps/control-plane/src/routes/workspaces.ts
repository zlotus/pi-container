import { randomUUID } from "node:crypto";
import { workspaceOrigin } from "@agent-runtime/gateway";
import { WORKER_PROTOCOL_VERSION } from "@agent-runtime/protocol";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

import type { RouteContext } from "../context.js";
import type { DispatchResult, RuntimeCommands } from "../runtime-commands.js";
import { errorBody, isUniqueViolation } from "../http.js";
import type { WorkspaceRecord } from "@agent-runtime/database";

import {
  type PublicModelAccess,
  publicWorkspace,
  runtimeChangeIncomplete,
  workspaceRuntime,
} from "../presenters.js";

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
    applyWorkerEgress,
    dispatchRuntimeCommand,
    markRuntimeFailure,
    sendDispatchFailure,
    validateRuntimeResult,
  } = runtime;

  /** Platform model access per Workspace; "disabled" without a model gateway (Phase 16.8). */
  async function modelAccessOf(
    workspaces: ReadonlyArray<{ id: string; state: string }>,
  ): Promise<Map<string, PublicModelAccess>> {
    if (dependencies.modelGateway === undefined || workspaces.length === 0) return new Map();
    try {
      return await dependencies.modelGateway.workspaceAccess(workspaces);
    } catch (error) {
      dependencies.log?.warn({ err: error }, "could not read model access state");
      return new Map();
    }
  }

  /** Each Workspace's Runtime version and allowed changes (specs.md Phase 18.8). */
  async function runtimeOf(workspaces: readonly WorkspaceRecord[]) {
    const images = await dependencies.workerStore.listWorkerRuntimeImages();
    return new Map(
      workspaces.map((workspace) => [
        workspace.id,
        workspaceRuntime(
          workspace,
          workspace.workerId === null ? [] : (images.get(workspace.workerId) ?? []),
          dependencies.defaultRuntimeImage,
        ),
      ]),
    );
  }

  async function present<T extends Parameters<typeof publicWorkspace>[0]>(workspace: T) {
    return publicWorkspace(
      workspace,
      (await modelAccessOf([workspace])).get(workspace.id),
      context.usage.workspace(workspace.id, workspace.workerId),
      (await runtimeOf([workspace])).get(workspace.id) ?? null,
    );
  }

  app.get("/api/workspaces", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) {
      return reply;
    }
    const workspaces = await dependencies.store.listWorkspaces(
      auth.session.user.id,
    );
    const [access, runtimes] = await Promise.all([modelAccessOf(workspaces), runtimeOf(workspaces)]);
    return {
      workspaces: workspaces.map((workspace) =>
        publicWorkspace(
          workspace,
          access.get(workspace.id),
          context.usage.workspace(workspace.id, workspace.workerId),
          runtimes.get(workspace.id) ?? null,
        ),
      ),
    };
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
        diskLimitBytes: dependencies.workspaceDiskLimitBytes,
      });
      return reply.code(201).send({ workspace: await present(workspace) });
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
    return { workspace: await present(workspace) };
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
    if (runtimeChangeIncomplete(workspace)) {
      // An interrupted Runtime change is retried or rolled back first (Phase 18.4).
      return reply
        .code(409)
        .send(errorBody("RUNTIME_CHANGE_INCOMPLETE", "Retry or roll back the Runtime change first"));
    }
    if (workspace.state === "RUNNING") {
      return { workspace: await present(workspace) };
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
    if (workerChannel.isConnected(workerId) && !(await applyWorkerEgress(workerId))) {
      // Fail closed: never start a Workspace on a Worker that cannot prove it enforces
      // the current egress policy (specs.md Phase 14.6).
      const unenforced: Extract<DispatchResult, { ok: false }> = {
        ok: false,
        workerOffline: false,
        statusCode: 503,
        code: "EGRESS_UNENFORCED",
        message: "Worker egress rules are not enforced",
      };
      await markRuntimeFailure(workspace.id, workerId, unenforced);
      return sendDispatchFailure(reply, unenforced);
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
      version: WORKER_PROTOCOL_VERSION,
      type: "workspace.ensure",
      requestId: randomUUID(),
      payload: {
        workspaceId: workspace.id,
        runtimeImage: workspace.runtimeImage,
        resources: dependencies.workspaceResources,
        storage: { diskLimitBytes: starting.disk.limitBytes },
        modelGateway: dependencies.modelGateway?.catalog ?? null,
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
    if (dependencies.modelGateway !== undefined) {
      dependencies.modelGateway.recordModelConfig(workspace.id, ensured.modelConfig);
      // Best effort: the Workspace starts without platform models when this fails (Q3).
      await dependencies.modelGateway.ensureWorkspaceKey(workspace.id);
    }
    const started = await dispatchRuntimeCommand(workerId, {
      version: WORKER_PROTOCOL_VERSION,
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
    return { workspace: await present(running) };
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
      return { workspace: await present(workspace) };
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
      version: WORKER_PROTOCOL_VERSION,
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
    return { workspace: await present(current) };
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
      // The key is now revoking; delete it at the gateway without waiting for the Worker.
      dependencies.modelGateway?.kick();
      const deleted = await dispatchRuntimeCommand(workspace.workerId, {
        version: WORKER_PROTOCOL_VERSION,
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
