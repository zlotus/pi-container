import { randomUUID } from "node:crypto";

import type {
  ControlToWorkerMessage,
  WorkspaceObservation,
} from "@agent-runtime/protocol";
import type { FastifyReply } from "fastify";

import type { ControlPlaneDependencies } from "./context.js";
import { errorBody } from "./http.js";
import { type WorkerChannel, WorkerChannelError } from "./worker-channel.js";

export type WorkspaceRuntimeCommand = Exclude<
  ControlToWorkerMessage,
  { type: "worker.reconcile" }
>;

export type DispatchResult =
  | {
      ok: true;
      workspace: WorkspaceObservation;
    }
  | {
      ok: false;
      workerOffline: boolean;
      statusCode: 409 | 502 | 503;
      code: string;
      message: string;
    };

/** Sends typed business commands to Workers and applies reconciliation results. */
export function createRuntimeCommands(
  dependencies: ControlPlaneDependencies,
  workerChannel: WorkerChannel,
) {
  async function dispatchRuntimeCommand(
    workerId: string,
    message: WorkspaceRuntimeCommand,
  ): Promise<DispatchResult> {
    try {
      const response = await workerChannel.dispatch(workerId, message);
      if (response.type === "response.error") {
        return {
          ok: false,
          workerOffline: false,
          statusCode: response.payload.retryable ? 503 : 409,
          code: response.payload.code,
          message: response.payload.message,
        };
      }
      if (response.payload.requestType === "worker.reconcile") {
        return {
          ok: false,
          workerOffline: false,
          statusCode: 502,
          code: "INVALID_WORKER_RESPONSE",
          message: "Worker returned an invalid Workspace result",
        };
      }
      const workspace = response.payload.workspace;
      if (
        workspace === undefined ||
        workspace.workspaceId !== message.payload.workspaceId
      ) {
        return {
          ok: false,
          workerOffline: false,
          statusCode: 502,
          code: "INVALID_WORKER_RESPONSE",
          message: "Worker returned an invalid Workspace result",
        };
      }
      return { ok: true, workspace };
    } catch (error) {
      const workerOffline =
        error instanceof WorkerChannelError &&
        (error.code === "WORKER_NOT_CONNECTED" ||
          error.code === "WORKER_CONNECTION_CLOSED");
      return {
        ok: false,
        workerOffline,
        statusCode: 503,
        code: workerOffline ? "WORKER_UNAVAILABLE" : "WORKER_COMMAND_FAILED",
        message: workerOffline
          ? "Assigned Worker is unavailable"
          : "Worker command did not complete",
      };
    }
  }

  async function reconcileWorkerWorkspaces(workerId: string): Promise<void> {
    const workspaces =
      await dependencies.store.beginWorkerReconciliation(workerId);
    if (!workerChannel.isConnected(workerId)) return;
    let response;
    try {
      response = await workerChannel.dispatch(workerId, {
        version: 1,
        type: "worker.reconcile",
        requestId: randomUUID(),
        payload: {
          assignments: workspaces.map((workspace) => ({
            workspaceId: workspace.id,
            runtimeImage: workspace.runtimeImage,
            desiredState: workspace.desiredState,
          })),
        },
      });
    } catch {
      return;
    }
    if (
      response.type !== "response.ok" ||
      response.payload.requestType !== "worker.reconcile"
    ) {
      return;
    }

    const report = response.payload.reconciliation;
    const results = new Map(
      report.workspaces.map((result) => [
        result.status === "OBSERVED"
          ? result.workspace.workspaceId
          : result.workspaceId,
        result,
      ]),
    );
    if (
      results.size !== workspaces.length ||
      workspaces.some((workspace) => !results.has(workspace.id))
    ) {
      return;
    }
    for (const issue of report.issues) {
      dependencies.reportRecoveryIssue?.({ workerId, ...issue });
    }

    for (const workspace of workspaces) {
      if (!workerChannel.isConnected(workerId)) return;
      const result = results.get(workspace.id);
      if (result === undefined) return;
      if (
        result.status === "MISSING" &&
        workspace.desiredState === "DELETED"
      ) {
        await dependencies.store.deleteRecoveredWorkspace({
          workspaceId: workspace.id,
          userId: workspace.userId,
          workerId,
          runtimeImage: workspace.runtimeImage,
        });
        continue;
      }
      if (result.status === "INVALID" && result.retryable) continue;

      let state: "RUNNING" | "STOPPED" | "ERROR" = "ERROR";
      if (
        result.status === "OBSERVED" &&
        result.workspace.runtimeImage === workspace.runtimeImage
      ) {
        if (
          workspace.desiredState === "RUNNING" &&
          result.workspace.state === "RUNNING"
        ) {
          state = "RUNNING";
        } else if (
          workspace.desiredState === "STOPPED" &&
          result.workspace.state === "STOPPED"
        ) {
          state = "STOPPED";
        } else if (
          workspace.desiredState === "UNKNOWN" &&
          (result.workspace.state === "RUNNING" ||
            result.workspace.state === "STOPPED")
        ) {
          state = result.workspace.state;
        }
      }
      await dependencies.store.reconcileWorkspaceRecovery({
        workspaceId: workspace.id,
        workerId,
        runtimeImage: workspace.runtimeImage,
        desiredState: workspace.desiredState,
        state,
      });
    }
  }

  async function markRuntimeFailure(
    workspaceId: string,
    workerId: string,
    result: Extract<DispatchResult, { ok: false }>,
  ): Promise<void> {
    await dependencies.store.markWorkspaceRuntimeFailure({
      workspaceId,
      workerId,
      workerOffline: result.workerOffline,
    });
  }

  function sendDispatchFailure(
    reply: FastifyReply,
    result: Extract<DispatchResult, { ok: false }>,
  ) {
    return reply
      .code(result.statusCode)
      .send(errorBody(result.code, result.message));
  }

  function validateRuntimeResult(
    result: Extract<DispatchResult, { ok: true }>,
    expectedRuntimeImage: string,
    expectedStates: readonly string[],
  ): Extract<DispatchResult, { ok: false }> | null {
    if (
      result.workspace.runtimeImage === expectedRuntimeImage &&
      expectedStates.includes(result.workspace.state)
    ) {
      return null;
    }
    return {
      ok: false,
      workerOffline: false,
      statusCode: 502,
      code: "INVALID_WORKER_RESPONSE",
      message: "Worker returned an unexpected Runtime result",
    };
  }

  return {
    workerChannel,
    dispatchRuntimeCommand,
    reconcileWorkerWorkspaces,
    markRuntimeFailure,
    sendDispatchFailure,
    validateRuntimeResult,
  };
}

export type RuntimeCommands = ReturnType<typeof createRuntimeCommands>;
