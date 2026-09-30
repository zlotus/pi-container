import { randomUUID } from "node:crypto";
import { hashPassword } from "@agent-runtime/auth";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RouteContext } from "../context.js";
import { errorBody, isUniqueViolation } from "../http.js";
import { publicAdminUser, publicUser, publicUserIdentity, publicWorkspace } from "../presenters.js";

const AdminUserParamsSchema = z.object({ id: z.string().uuid() }).strict();

const AdminIdentityParamsSchema = z
  .object({ id: z.string().uuid(), identityId: z.string().uuid() })
  .strict();

const CreateLocalUserBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/)
      .optional(),
    password: z.string().min(12).max(1_024),
  })
  .strict();

const UpdateManagedUserBodySchema = z
  .object({
    role: z.enum(["user", "admin"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict()
  .refine((value) => value.role !== undefined || value.status !== undefined);

const ResetLocalPasswordBodySchema = z
  .object({ password: z.string().min(12).max(1_024) })
  .strict();

const BindExternalIdentityBodySchema = z
  .object({
    providerId: z.string().min(1).max(128),
    providerSubject: z.string().min(1).max(1_024),
  })
  .strict();

/** Admin user lifecycle, sessions and external identity binding. */
export function registerAdminUserRoutes(app: FastifyInstance, context: RouteContext): void {
  const {
    dependencies,
    now,
    externalProviderIds,
    authenticationAudit,
    validateOrigin,
    authenticateAdmin,
    validateCsrf,
  } = context;

  app.get("/api/admin/users", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const users = await dependencies.store.listUsers();
    reply.header("cache-control", "no-store");
    return { users: users.map(publicAdminUser) };
  });

  app.post("/api/admin/users", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const parsed = CreateLocalUserBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid Local User details"));
    }
    try {
      const user = await dependencies.store.createUser({
        id: randomUUID(),
        email: parsed.data.email,
        username: parsed.data.username ?? null,
        passwordHash: await hashPassword(parsed.data.password),
        role: "user",
        actorUserId: auth.session.user.id,
      });
      return reply.code(201).send({ user: publicUser(user) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply
          .code(409)
          .send(errorBody("USER_ALREADY_EXISTS", "Email or username already exists"));
      }
      throw error;
    }
  });

  app.get("/api/admin/users/:id/identities", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const params = AdminUserParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid User identity lookup"));
    }
    const identities = await dependencies.store.listUserIdentities(params.data.id);
    if (identities === null) {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    reply.header("cache-control", "no-store");
    return { identities: identities.map(publicUserIdentity) };
  });

  const bindIdentityHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const legacyOidcRoute = request.url.includes("/oidc-identities");
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    if (
      (legacyOidcRoute && dependencies.oidc === undefined) ||
      (!legacyOidcRoute && externalProviderIds.size === 0)
    ) {
      return reply
        .code(409)
        .send(
          legacyOidcRoute
            ? errorBody("OIDC_DISABLED", "OIDC login is not enabled")
            : errorBody("EXTERNAL_AUTH_DISABLED", "External login is not enabled"),
        );
    }
    const params = AdminUserParamsSchema.safeParse(request.params);
    const body = BindExternalIdentityBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid external identity binding"));
    }
    if (
      (legacyOidcRoute && body.data.providerId !== dependencies.oidc?.providerId) ||
      (!legacyOidcRoute && !externalProviderIds.has(body.data.providerId))
    ) {
      return reply
        .code(400)
        .send(
          errorBody(
            legacyOidcRoute
              ? "OIDC_PROVIDER_MISMATCH"
              : "EXTERNAL_PROVIDER_MISMATCH",
            "Identity provider does not match the configured provider",
          ),
        );
    }
    const result = await dependencies.store.bindExternalIdentity({
      id: randomUUID(),
      userId: params.data.id,
      providerId: body.data.providerId,
      providerSubject: body.data.providerSubject,
      actorUserId: auth.session.user.id,
    });
    if (result.outcome === "USER_NOT_FOUND") {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    if (result.outcome === "IDENTITY_ALREADY_BOUND") {
      return reply
        .code(409)
        .send(
          errorBody(
            legacyOidcRoute
              ? "OIDC_IDENTITY_ALREADY_BOUND"
              : "EXTERNAL_IDENTITY_ALREADY_BOUND",
            `${legacyOidcRoute ? "OIDC" : "External"} identity is already bound`,
          ),
        );
    }
    reply.header("cache-control", "no-store");
    return reply
      .code(201)
      .send({ identity: publicUserIdentity(result.identity) });
  };

  app.post("/api/admin/users/:id/identities", bindIdentityHandler);

  app.post("/api/admin/users/:id/oidc-identities", bindIdentityHandler);

  app.delete(
    "/api/admin/users/:id/identities/:identityId",
    async (request, reply) => {
      const auth = await authenticateAdmin(request, reply);
      if (auth === null) return reply;
      if (
        !validateOrigin(request, reply) ||
        !validateCsrf(request, reply, auth.rawToken)
      ) {
        return reply;
      }
      const params = AdminIdentityParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .code(400)
          .send(errorBody("INVALID_REQUEST", "Invalid external identity"));
      }
      const result = await dependencies.store.unbindExternalIdentity({
        userId: params.data.id,
        identityId: params.data.identityId,
        actorUserId: auth.session.user.id,
      });
      if (result.outcome === "USER_NOT_FOUND") {
        return reply
          .code(404)
          .send(errorBody("USER_NOT_FOUND", "User was not found"));
      }
      if (result.outcome === "IDENTITY_NOT_FOUND") {
        return reply
          .code(404)
          .send(errorBody("IDENTITY_NOT_FOUND", "Identity was not found"));
      }
      if (result.outcome === "LAST_LOGIN_METHOD") {
        return reply
          .code(409)
          .send(
            errorBody(
              "LAST_LOGIN_METHOD",
              "At least one usable login method must remain",
            ),
          );
      }
      return reply.code(204).send();
    },
  );

  app.patch("/api/admin/users/:id", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = AdminUserParamsSchema.safeParse(request.params);
    const body = UpdateManagedUserBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid User update"));
    }
    const result = await dependencies.store.updateManagedUser({
      userId: params.data.id,
      ...(body.data.role === undefined ? {} : { role: body.data.role }),
      ...(body.data.status === undefined ? {} : { status: body.data.status }),
      audit: {
        actorUserId: auth.session.user.id,
        ...authenticationAudit(request, "LOCAL", "local"),
      },
    });
    if (result.outcome === "NOT_FOUND") {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    if (result.outcome === "LAST_ACTIVE_LOCAL_ADMIN") {
      return reply
        .code(409)
        .send(
          errorBody(
            "LAST_ACTIVE_LOCAL_ADMIN",
            "At least one active Local Admin must remain",
          ),
        );
    }
    if (result.user.status === "disabled") {
      dependencies.sessionConnections?.closeUser(result.user.id);
    }
    reply.header("cache-control", "no-store");
    return { user: publicAdminUser(result.user) };
  });

  app.post("/api/admin/users/:id/reset-password", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = AdminUserParamsSchema.safeParse(request.params);
    const body = ResetLocalPasswordBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid password reset"));
    }
    const updated = await dependencies.store.resetLocalPassword({
      userId: params.data.id,
      passwordHash: await hashPassword(body.data.password),
      audit: {
        actorUserId: auth.session.user.id,
        ...authenticationAudit(request, "LOCAL", "local"),
      },
    });
    if (!updated) {
      return reply
        .code(404)
        .send(errorBody("LOCAL_USER_NOT_FOUND", "Local User was not found"));
    }
    return reply.code(204).send();
  });

  app.post("/api/admin/users/:id/revoke-sessions", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    if (
      !validateOrigin(request, reply) ||
      !validateCsrf(request, reply, auth.rawToken)
    ) {
      return reply;
    }
    const params = AdminUserParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(errorBody("INVALID_REQUEST", "Invalid User identifier"));
    }
    const revoked = await dependencies.store.revokeUserSessions(
      params.data.id,
      now(),
      {
        actorUserId: auth.session.user.id,
        ...authenticationAudit(request, "LOCAL", "local"),
      },
    );
    if (!revoked) {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    dependencies.sessionConnections?.closeUser(params.data.id);
    return reply.code(204).send();
  });

  app.get("/api/admin/users/:id/workspaces", async (request, reply) => {
    const auth = await authenticateAdmin(request, reply);
    if (auth === null) return reply;
    const params = AdminUserParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    const workspaces = await dependencies.store.listManagedUserWorkspaces(
      params.data.id,
    );
    if (workspaces === null) {
      return reply
        .code(404)
        .send(errorBody("USER_NOT_FOUND", "User was not found"));
    }
    reply.header("cache-control", "no-store");
    return { workspaces: workspaces.map(publicWorkspace) };
  });
}
