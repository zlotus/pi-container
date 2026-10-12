import { createJsonLogger, newRequestId } from "@agent-runtime/logging";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import {
  type ControlPlaneDependencies,
  createRouteContext,
} from "./context.js";
import { registerAdminAuthLockRoutes } from "./routes/admin-auth-locks.js";
import { registerAdminEgressRoutes } from "./routes/admin-egress.js";
import { registerAdminUserRoutes } from "./routes/admin-users.js";
import { registerAdminWorkerRoutes } from "./routes/admin-workers.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerExternalAuthRoutes } from "./routes/auth-external.js";
import { registerLocalAuthRoutes } from "./routes/auth-local.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerModelGatewayRoutes } from "./routes/model-gateway.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { createRuntimeCommands } from "./runtime-commands.js";
import { PlatformMetrics } from "./metrics/platform-metrics.js";
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
  const metrics = dependencies.metrics ?? new PlatformMetrics();
  const workerChannel =
    dependencies.workerChannel ?? new WorkerChannel(dependencies.workerCommandTimeoutMs, metrics);
  const context = createRouteContext({ ...dependencies, metrics, workerChannel });
  app.addHook("onResponse", async (request, reply) => {
    // Route templates only: the raw URL can carry user data (specs.md Phase 17.4).
    context.metrics.recordHttp(
      request.routeOptions.url,
      request.method,
      reply.statusCode,
      reply.elapsedTime / 1_000,
    );
    if (dependencies.log === undefined) return;
    // One whitelisted line per request; serializers keep only the route template.
    const probe = request.routeOptions.url === "/health" || request.routeOptions.url === "/ready";
    request.log[probe ? "debug" : "info"](
      { req: request, res: reply, durationMs: Math.round(reply.elapsedTime) },
      "request completed",
    );
  });
  void app.register(websocket, {
    options: { maxPayload: 8 * 1024 * 1024, perMessageDeflate: false },
  });
  const runtime = createRuntimeCommands(dependencies, workerChannel);

  void app.register(async (workerControlScope) => {
    registerWorkerControlChannel(workerControlScope, {
      store: dependencies.workerStore,
      channel: workerChannel,
      now: context.now,
      metrics: context.metrics,
      usage: context.usage,
      ...(dependencies.log === undefined ? {} : { log: dependencies.log }),
      onHelloAccepted: (workerId) => {
        // The policy goes out before reconciliation so restored Workspaces run under it.
        void runtime
          .applyWorkerEgress(workerId)
          .catch((error: unknown) => {
            dependencies.log?.warn({ err: error, workerId }, "worker egress sync failed");
          })
          .then(() => runtime.reconcileWorkerWorkspaces(workerId))
          .catch((error: unknown) => {
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
  registerAdminWorkerRoutes(app, context, runtime);
  registerAdminEgressRoutes(app, context, runtime);
  registerAdminUserRoutes(app, context);
  registerAdminAuthLockRoutes(app, context);
  registerModelGatewayRoutes(app, context);

  return app;
}
