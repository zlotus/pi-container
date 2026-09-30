import { createJsonLogger, newRequestId } from "@agent-runtime/logging";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import {
  type ControlPlaneDependencies,
  createRouteContext,
} from "./context.js";
import { registerAdminUserRoutes } from "./routes/admin-users.js";
import { registerAdminWorkerRoutes } from "./routes/admin-workers.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerExternalAuthRoutes } from "./routes/auth-external.js";
import { registerLocalAuthRoutes } from "./routes/auth-local.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { createRuntimeCommands } from "./runtime-commands.js";
import { WorkerChannel } from "./worker-channel.js";
import { registerWorkerControlChannel } from "./worker-control.js";

export type { ControlPlaneDependencies } from "./context.js";

export function buildControlPlane(
  dependencies: ControlPlaneDependencies,
): FastifyInstance {
  const log: FastifyBaseLogger =
    dependencies.log ??
    createJsonLogger("control-plane", { LOG_LEVEL: "silent", LOG_FORMAT: "json" });
  const app = Fastify({
    loggerInstance: log,
    disableRequestLogging: true,
    requestIdLogLabel: "requestId",
    genReqId: () => newRequestId(),
  });
  if (dependencies.log !== undefined) {
    // One whitelisted line per request; serializers keep only the route template.
    app.addHook("onResponse", async (request, reply) => {
      const probe = request.routeOptions.url === "/health" || request.routeOptions.url === "/ready";
      request.log[probe ? "debug" : "info"](
        { req: request, res: reply, durationMs: Math.round(reply.elapsedTime) },
        "request completed",
      );
    });
  }
  const workerChannel = new WorkerChannel(dependencies.workerCommandTimeoutMs);
  void app.register(websocket, {
    options: { maxPayload: 8 * 1024 * 1024, perMessageDeflate: false },
  });
  const context = createRouteContext(dependencies);
  const runtime = createRuntimeCommands(dependencies, workerChannel);

  void app.register(async (workerControlScope) => {
    registerWorkerControlChannel(workerControlScope, {
      store: dependencies.workerStore,
      channel: workerChannel,
      now: context.now,
      onHelloAccepted: (workerId) => {
        void runtime.reconcileWorkerWorkspaces(workerId).catch((error: unknown) => {
          // The Workspace stays WORKER_OFFLINE when reconciliation cannot be
          // completed. A later Worker reconnect can safely try again.
          dependencies.log?.warn({ err: error, workerId }, "worker reconciliation failed");
        });
      },
    });
  });

  registerHealthRoutes(app, context);
  registerExternalAuthRoutes(app, context);
  registerLocalAuthRoutes(app, context);
  registerWorkspaceRoutes(app, context, runtime);
  registerAuditRoutes(app, context);
  registerAdminWorkerRoutes(app, context);
  registerAdminUserRoutes(app, context);

  return app;
}
