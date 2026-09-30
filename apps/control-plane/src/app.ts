import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

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
  const app = Fastify({ logger: false });
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
        void runtime.reconcileWorkerWorkspaces(workerId).catch(() => {
          // The Workspace stays WORKER_OFFLINE when reconciliation cannot be
          // completed. A later Worker reconnect can safely try again.
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
