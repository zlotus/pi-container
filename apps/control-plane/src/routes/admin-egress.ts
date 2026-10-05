import type { EgressRuleRecord } from "@agent-runtime/database";
import { canonicalIpv4Cidr, EGRESS_DEFAULT_DENY_V4 } from "@agent-runtime/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { RouteContext } from "../context.js";
import { validateEgressRules } from "../egress.js";
import { errorBody } from "../http.js";
import type { RuntimeCommands } from "../runtime-commands.js";

const PortSchema = z.number().int().min(1).max(65_535);

/** Accepts a bare address (as /32) or a CIDR whose host bits are zero. */
const NetworkSchema = z
  .string()
  .trim()
  .max(18)
  .transform((value, context) => {
    const cidr = canonicalIpv4Cidr(value);
    if (cidr === null) {
      context.addIssue({ code: "custom", message: "invalid IPv4 network" });
      return z.NEVER;
    }
    return cidr;
  })
  .refine((cidr) => Number(cidr.split("/")[1]) >= 8, "prefix must be /8 or longer");

const CreateEgressRuleBodySchema = z
  .object({
    action: z.enum(["allow", "deny"]),
    network: NetworkSchema,
    protocol: z.enum(["tcp", "udp"]).optional(),
    portMin: PortSchema.optional(),
    portMax: PortSchema.optional(),
    description: z.string().trim().max(200).default(""),
  })
  .strict()
  .refine(
    (body) =>
      body.action === "allow" ||
      (body.protocol === undefined && body.portMin === undefined && body.portMax === undefined),
    "deny rules apply to whole networks",
  )
  .refine(
    (body) => body.portMax === undefined || body.portMin !== undefined,
    "portMax requires portMin",
  )
  .refine(
    (body) => body.portMin === undefined || body.protocol !== undefined,
    "ports require a protocol",
  )
  .refine(
    (body) => body.portMin === undefined || (body.portMax ?? body.portMin) >= body.portMin,
    "portMin must not exceed portMax",
  );

const EgressRuleParamsSchema = z.object({ id: z.string().uuid() }).strict();

const REJECTION_MESSAGES: Record<string, string> = {
  EGRESS_ALLOW_OUTSIDE_DENY:
    "An allow rule must lie inside RFC1918 or an existing deny range",
  EGRESS_ALLOW_OVERLAPS_PROTECTED:
    "An allow rule must not include a protected platform address",
  EGRESS_RULE_LIMIT: "Too many egress rules",
};

function publicEgressRule(rule: EgressRuleRecord) {
  return {
    id: rule.id,
    action: rule.action,
    network: rule.network,
    protocol: rule.protocol,
    portMin: rule.portMin,
    portMax: rule.portMax,
    description: rule.description,
    createdBy: rule.createdBy,
    createdAt: rule.createdAt.toISOString(),
  };
}

/** Admin egress policy: whitelist, extra deny ranges and per-Worker enforcement state. */
export function registerAdminEgressRoutes(
  app: FastifyInstance,
  context: RouteContext,
  runtime: RuntimeCommands,
): void {
  const { dependencies, validateOrigin, authenticateAdmin, validateCsrf } = context;
  const protectedAddresses = dependencies.egressProtected ?? (async () => []);

  function auditMetadata(request: FastifyRequest, actorUserId: string) {
    const userAgent = request.headers["user-agent"];
    return {
      actorUserId,
      requestId: String(request.id).slice(0, 128),
      ipAddress: request.ip.slice(0, 128),
      userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
    };
  }

  function distribute(): void {
    // The change is committed; Workers that miss it get it on their next hello.
    void runtime.broadcastEgressPolicy().catch((error: unknown) => {
      dependencies.log?.warn({ err: error }, "egress policy broadcast failed");
    });
  }

  app.get("/api/admin/egress", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const [policy, protectedCidrs, workers] = await Promise.all([
      dependencies.workerStore.getEgressPolicy(),
      protectedAddresses(),
      dependencies.workerStore.listWorkersWithAssignments(),
    ]);
    reply.header("cache-control", "no-store");
    return {
      revision: policy.revision,
      defaultDeny: [...EGRESS_DEFAULT_DENY_V4],
      protected: protectedCidrs,
      rules: policy.rules.map(publicEgressRule),
      workers: workers.map((worker) => ({
        id: worker.id,
        enabled: worker.enabled,
        enforced: worker.egress.enforced,
        revision: worker.egress.revision,
        checkedAt: worker.egress.checkedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post("/api/admin/egress/rules", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (!validateOrigin(request, reply) || !validateCsrf(request, reply, auth.rawToken)) {
      return reply;
    }
    const body = CreateEgressRuleBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid egress rule"));
    }
    const protectedCidrs = await protectedAddresses();
    const result = await dependencies.workerStore.createEgressRule({
      action: body.data.action,
      network: body.data.network,
      protocol: body.data.protocol ?? null,
      portMin: body.data.portMin ?? null,
      portMax: body.data.portMin === undefined ? null : (body.data.portMax ?? body.data.portMin),
      description: body.data.description,
      validate: (rules) => validateEgressRules(rules, protectedCidrs),
      audit: auditMetadata(request, auth.session.user.id),
    });
    if (result.outcome === "DUPLICATE") {
      return reply
        .code(409)
        .send(errorBody("EGRESS_RULE_EXISTS", "The egress rule already exists"));
    }
    if (result.outcome === "REJECTED") {
      return reply
        .code(409)
        .send(errorBody(result.code, REJECTION_MESSAGES[result.code] ?? "Egress rule rejected"));
    }
    distribute();
    reply.code(201).header("cache-control", "no-store");
    return { rule: publicEgressRule(result.rule), revision: result.revision };
  });

  app.delete("/api/admin/egress/rules/:id", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (!validateOrigin(request, reply) || !validateCsrf(request, reply, auth.rawToken)) {
      return reply;
    }
    const params = EgressRuleParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("EGRESS_RULE_NOT_FOUND", "Egress rule was not found"));
    }
    const result = await dependencies.workerStore.deleteEgressRule({
      ruleId: params.data.id,
      // Only dependency checks: removing a rule never widens what protected addresses allow.
      validate: (rules) => validateEgressRules(rules, []),
      audit: auditMetadata(request, auth.session.user.id),
    });
    if (result.outcome === "NOT_FOUND") {
      return reply
        .code(404)
        .send(errorBody("EGRESS_RULE_NOT_FOUND", "Egress rule was not found"));
    }
    if (result.outcome === "REJECTED") {
      // Deleting a deny range that an allow rule depends on.
      return reply
        .code(409)
        .send(
          errorBody(
            "EGRESS_RULE_IN_USE",
            "Remove the allow rules inside this deny range first",
          ),
        );
    }
    distribute();
    reply.header("cache-control", "no-store");
    return { revision: result.revision };
  });
}
