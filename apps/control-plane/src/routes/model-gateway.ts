import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { RouteContext } from "../context.js";
import { errorBody } from "../http.js";
import type { ModelUsage } from "../model-gateway/admin-client.js";

const UserParamsSchema = z.object({ id: z.string().uuid() }).strict();
const WorkspaceParamsSchema = z.object({ id: z.string().uuid() }).strict();
const BudgetBodySchema = z
  .object({ budgetUsd: z.number().min(0).max(1_000_000).multipleOf(0.01).nullable() })
  .strict();

function publicUsage(usage: ModelUsage | null | "unavailable") {
  if (usage === "unavailable") return { available: false, usage: null };
  return {
    available: true,
    usage:
      usage === null
        ? null
        : { spendUsd: usage.spendUsd, maxBudgetUsd: usage.maxBudgetUsd, budgetResetAt: usage.budgetResetAt },
  };
}

/** Platform model access: usage, budgets, rotation and gateway status (specs.md Phase 16.8). */
export function registerModelGatewayRoutes(app: FastifyInstance, context: RouteContext): void {
  const { dependencies, validateOrigin, authenticate, authenticateAdmin, validateCsrf } = context;

  const disabled = (reply: FastifyReply) =>
    reply.code(404).send(errorBody("MODEL_GATEWAY_DISABLED", "Platform model access is not configured"));

  app.get("/api/me/model-usage", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth === null) return reply;
    reply.header("cache-control", "no-store");
    const gateway = dependencies.modelGateway;
    if (gateway === undefined) return { enabled: false };
    return { enabled: true, ...publicUsage(await gateway.usage(auth.session.user.id)) };
  });

  app.get("/api/admin/model-gateway", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    reply.header("cache-control", "no-store");
    const gateway = dependencies.modelGateway;
    if (gateway === undefined) return { enabled: false };
    const status = await gateway.status();
    return { ...status, oldestPendingAt: status.oldestPendingAt?.toISOString() ?? null };
  });

  app.get("/api/admin/users/:id/model-usage", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const params = UserParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send(errorBody("USER_NOT_FOUND", "User was not found"));
    const gateway = dependencies.modelGateway;
    if (gateway === undefined) return disabled(reply);
    const budget = await dependencies.store.findUserModelBudget(params.data.id);
    if (!budget.found) return reply.code(404).send(errorBody("USER_NOT_FOUND", "User was not found"));
    reply.header("cache-control", "no-store");
    return { budgetUsd: budget.budgetUsd, ...publicUsage(await gateway.usage(params.data.id)) };
  });

  app.put("/api/admin/users/:id/model-budget", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (!validateOrigin(request, reply) || !validateCsrf(request, reply, auth.rawToken)) return reply;
    const params = UserParamsSchema.safeParse(request.params);
    const body = BudgetBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid model budget"));
    }
    const gateway = dependencies.modelGateway;
    if (gateway === undefined) return disabled(reply);
    const result = await dependencies.store.setUserModelBudget({
      userId: params.data.id,
      budgetUsd: body.data.budgetUsd,
      actorUserId: auth.session.user.id,
      requestId: String(request.id).slice(0, 128),
    });
    if (!result.found) return reply.code(404).send(errorBody("USER_NOT_FOUND", "User was not found"));
    // The stored value is authoritative; it reaches the gateway now or with the next key.
    const applied = await gateway.applyBudget(params.data.id);
    return { budgetUsd: body.data.budgetUsd, appliedToGateway: applied };
  });

  app.post("/api/admin/users/:id/model-keys/rotate", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (!validateOrigin(request, reply) || !validateCsrf(request, reply, auth.rawToken)) return reply;
    const params = UserParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send(errorBody("USER_NOT_FOUND", "User was not found"));
    const gateway = dependencies.modelGateway;
    if (gateway === undefined) return disabled(reply);
    const revoked = await gateway.rotate({
      userId: params.data.id,
      actorUserId: auth.session.user.id,
      requestId: String(request.id).slice(0, 128),
    });
    return { revoked };
  });

  app.post("/api/admin/workspaces/:id/model-key/rotate", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (!validateOrigin(request, reply) || !validateCsrf(request, reply, auth.rawToken)) return reply;
    const params = WorkspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(404).send(errorBody("WORKSPACE_NOT_FOUND", "Workspace was not found"));
    }
    const gateway = dependencies.modelGateway;
    if (gateway === undefined) return disabled(reply);
    const revoked = await gateway.rotate({
      workspaceId: params.data.id,
      actorUserId: auth.session.user.id,
      requestId: String(request.id).slice(0, 128),
    });
    return { revoked };
  });
}
