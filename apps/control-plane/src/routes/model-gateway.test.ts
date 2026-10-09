import type { ModelGatewayConfig } from "@agent-runtime/protocol";
import { describe, expect, it, vi } from "vitest";

import { buildControlPlane } from "../app.js";
import type { ModelAccessService } from "../model-gateway/key-manager.js";
import {
  ADMIN_ID,
  answerEgressApply,
  createTestDependencies,
  emptyReconciliation,
  login,
  NOW,
  ORIGIN,
  USER_A_ID,
  WORKER_1_TOKEN,
  workerHello,
} from "./test-fixtures.js";

const CATALOG: ModelGatewayConfig = {
  providerId: "platform",
  defaultModel: "deepseek-v4-flash",
  models: [{ id: "deepseek-v4-flash", api: "openai-completions" }],
};

function fakeService(events: string[] = []): ModelAccessService & { [key: string]: unknown } {
  return {
    catalog: CATALOG,
    ensureWorkspaceKey: vi.fn(async () => {
      events.push("ensureWorkspaceKey");
      return "available" as const;
    }),
    recordModelConfig: vi.fn(),
    workspaceAccess: vi.fn(async (workspaces: ReadonlyArray<{ id: string }>) =>
      new Map(workspaces.map((workspace) => [workspace.id, { status: "available" as const, reason: null }])),
    ),
    rotate: vi.fn(async () => 2),
    reconcileWorker: vi.fn(async () => undefined),
    kick: vi.fn(),
    status: vi.fn(async () => ({
      enabled: true as const,
      reachable: true,
      providerId: "platform",
      catalog: [{ id: "deepseek-v4-flash", name: null, presentInGateway: true }],
      pendingRevocations: 1,
      oldestPendingAt: NOW,
      lastErrorCode: "MODEL_GATEWAY_UNAVAILABLE",
      activeKeys: 3,
    })),
    usage: vi.fn(async () => ({ spendUsd: 0.42, maxBudgetUsd: 10, budgetResetAt: "2026-11-01T00:00:00Z" })),
    applyBudget: vi.fn(async () => true),
  };
}

async function setup(service: ModelAccessService | undefined) {
  const dependencies = await createTestDependencies();
  const app = buildControlPlane({ ...dependencies, ...(service === undefined ? {} : { modelGateway: service }) });
  const admin = await login(app, "admin", "password-for-admin");
  const user = await login(app, "user-a", "password-for-user-a");
  const send = (
    method: "GET" | "PUT" | "POST",
    url: string,
    session: { cookie: string; csrfToken: string } | null,
    payload?: unknown,
    csrf = true,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        origin: ORIGIN,
        ...(session === null ? {} : { cookie: session.cookie }),
        ...(session !== null && csrf ? { "x-csrf-token": session.csrfToken } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  return { dependencies, app, admin, user, send };
}

describe("model gateway routes (Phase 16.8)", () => {
  it("reports platform model access as disabled without a gateway", async () => {
    const { app, admin, user, send } = await setup(undefined);
    expect((await send("GET", "/api/me/model-usage", user)).json()).toEqual({ enabled: false });
    expect((await send("GET", "/api/admin/model-gateway", admin)).json()).toEqual({ enabled: false });
    const budget = await send("PUT", `/api/admin/users/${USER_A_ID}/model-budget`, admin, { budgetUsd: 5 });
    expect(budget.statusCode).toBe(404);
    expect(budget.json()).toMatchObject({ error: { code: "MODEL_GATEWAY_DISABLED" } });
    await app.close();
  });

  it("requires authentication, the admin role and CSRF", async () => {
    const service = fakeService();
    const { app, user, admin, send } = await setup(service);
    expect((await send("GET", "/api/me/model-usage", null)).statusCode).toBe(401);
    for (const [method, url, payload] of [
      ["GET", "/api/admin/model-gateway", undefined],
      ["GET", `/api/admin/users/${USER_A_ID}/model-usage`, undefined],
      ["PUT", `/api/admin/users/${USER_A_ID}/model-budget`, { budgetUsd: 1 }],
      ["POST", `/api/admin/users/${USER_A_ID}/model-keys/rotate`, {}],
      ["POST", "/api/admin/workspaces/6a8c2f9e-3a8f-4c7e-9a64-0f5d2b1c4e01/model-key/rotate", {}],
    ] as const) {
      expect((await send(method, url, null, payload)).statusCode, url).toBe(401);
      expect((await send(method, url, user, payload)).statusCode, url).toBe(403);
      if (method !== "GET") {
        expect((await send(method, url, admin, payload, false)).statusCode, url).toBe(403);
      }
    }
    expect(service.rotate).not.toHaveBeenCalled();
    expect(service.applyBudget).not.toHaveBeenCalled();
    await app.close();
  });

  it("shows a user only their own usage", async () => {
    const service = fakeService();
    const { app, user, send } = await setup(service);
    const response = await send("GET", "/api/me/model-usage", user);
    expect(response.json()).toEqual({
      enabled: true,
      available: true,
      usage: { spendUsd: 0.42, maxBudgetUsd: 10, budgetResetAt: "2026-11-01T00:00:00Z" },
    });
    expect(service.usage).toHaveBeenCalledWith(USER_A_ID);
    vi.mocked(service.usage).mockResolvedValueOnce("unavailable");
    expect((await send("GET", "/api/me/model-usage", user)).json()).toEqual({
      enabled: true,
      available: false,
      usage: null,
    });
    await app.close();
  });

  it("validates, stores and audits budgets, then applies them to the gateway", async () => {
    const service = fakeService();
    const { dependencies, app, admin, send } = await setup(service);
    for (const invalid of [-1, 1_000_001, 0.001, "5", {}]) {
      expect((await send("PUT", `/api/admin/users/${USER_A_ID}/model-budget`, admin, { budgetUsd: invalid })).statusCode).toBe(400);
    }
    expect(
      (await send("PUT", `/api/admin/users/${USER_A_ID}/model-budget`, admin, { budgetUsd: 1, extra: true })).statusCode,
    ).toBe(400);
    const missing = await send("PUT", "/api/admin/users/6a8c2f9e-3a8f-4c7e-9a64-0f5d2b1c4eff/model-budget", admin, {
      budgetUsd: 1,
    });
    expect(missing.statusCode).toBe(404);

    const response = await send("PUT", `/api/admin/users/${USER_A_ID}/model-budget`, admin, { budgetUsd: 12.5 });
    expect(response.json()).toEqual({ budgetUsd: 12.5, appliedToGateway: true });
    expect(service.applyBudget).toHaveBeenCalledWith(USER_A_ID);
    const events = await dependencies.store.listAuditEvents({ userId: ADMIN_ID, includeAllUsers: true, limit: 5, beforeId: null });
    expect(events[0]).toMatchObject({
      eventType: "model.budget_changed",
      actorUserId: ADMIN_ID,
      ownerUserId: USER_A_ID,
      details: { fromUsd: null, toUsd: 12.5 },
    });
    expect((await send("GET", `/api/admin/users/${USER_A_ID}/model-usage`, admin)).json()).toMatchObject({
      budgetUsd: 12.5,
      available: true,
    });
    expect((await send("PUT", `/api/admin/users/${USER_A_ID}/model-budget`, admin, { budgetUsd: null })).statusCode).toBe(200);
    await app.close();
  });

  it("rotates keys on behalf of the acting admin and reports gateway status", async () => {
    const service = fakeService();
    const { app, admin, send } = await setup(service);
    expect((await send("POST", `/api/admin/users/${USER_A_ID}/model-keys/rotate`, admin, {})).json()).toEqual({ revoked: 2 });
    expect(service.rotate).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_A_ID, actorUserId: ADMIN_ID }));
    const status = await send("GET", "/api/admin/model-gateway", admin);
    expect(status.json()).toMatchObject({
      enabled: true,
      reachable: true,
      pendingRevocations: 1,
      oldestPendingAt: NOW.toISOString(),
    });
    expect(status.body).not.toMatch(/sk-/);
    await app.close();
  });

  it("starts the revocation right after a user is disabled", async () => {
    const service = fakeService();
    const { app, admin } = await setup(service);
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${USER_A_ID}`,
      headers: { cookie: admin.cookie, origin: ORIGIN, "x-csrf-token": admin.csrfToken },
      payload: { status: "disabled" },
    });
    expect(response.statusCode).toBe(200);
    expect(service.kick).toHaveBeenCalled();
    await app.close();
  });

  it("writes the catalog with ensure, issues the key before start, and shows model access", async () => {
    const events: string[] = [];
    const service = fakeService(events);
    const { app, user } = await setup(service);
    await app.ready();
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    let ensurePayload: Record<string, unknown> | null = null;
    worker.on("message", (data) => {
      if (answerEgressApply(worker, data)) return;
      const command = JSON.parse(data.toString()) as {
        requestId: string;
        type: string;
        payload: { workspaceId: string } & Record<string, unknown>;
      };
      if (command.type === "worker.reconcile") {
        worker.send(JSON.stringify(emptyReconciliation(command.requestId)));
        return;
      }
      events.push(command.type);
      if (command.type === "workspace.ensure") ensurePayload = command.payload;
      worker.send(
        JSON.stringify({
          version: 4,
          type: "response.ok",
          requestId: command.requestId,
          payload: {
            requestType: command.type,
            workspace: {
              workspaceId: command.payload.workspaceId,
              state: command.type === "workspace.start" ? "RUNNING" : command.type === "workspace.delete" ? "CREATED" : "STOPPED",
              runtimeImage: "agent-runtime:test-unassigned",
              observedAt: NOW.toISOString(),
            },
            ...(command.type === "workspace.ensure" ? { modelConfig: "applied" } : {}),
          },
        }),
      );
    });
    worker.send(JSON.stringify(workerHello("worker-01")));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const headers = { cookie: user.cookie, origin: ORIGIN, "x-csrf-token": user.csrfToken };
    const created = await app.inject({ method: "POST", url: "/api/workspaces", headers, payload: { name: "models" } });
    const workspaceId = created.json<{ workspace: { id: string } }>().workspace.id;
    const started = await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/start`, headers, payload: {} });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ workspace: { modelAccess: { status: "available", reason: null } } });
    expect(ensurePayload).toMatchObject({ modelGateway: CATALOG });
    expect(service.recordModelConfig).toHaveBeenCalledWith(workspaceId, "applied");
    expect(events).toEqual(["workspace.ensure", "ensureWorkspaceKey", "workspace.start"]);

    const listed = await app.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: user.cookie } });
    expect(listed.json()).toMatchObject({ workspaces: [{ id: workspaceId, modelAccess: { status: "available" } }] });

    vi.mocked(service.kick).mockClear();
    const deleted = await app.inject({ method: "DELETE", url: `/api/workspaces/${workspaceId}`, headers });
    expect(deleted.statusCode).toBe(204);
    expect(service.kick).toHaveBeenCalled();
    worker.terminate();
    await app.close();
  });

  it("passes the Worker's held keys to the service on reconciliation", async () => {
    const service = fakeService();
    const { app } = await setup(service);
    await app.ready();
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    const holding = { workspaceId: "6a8c2f9e-3a8f-4c7e-9a64-0f5d2b1c4e01", keyAlias: "arw-6a8c2f9e-3a8f-4c7e-9a64-0f5d2b1c4e01-1" };
    worker.on("message", (data) => {
      if (answerEgressApply(worker, data)) return;
      const command = JSON.parse(data.toString()) as { requestId: string; type: string };
      if (command.type !== "worker.reconcile") return;
      const response = emptyReconciliation(command.requestId);
      response.payload.reconciliation.modelKeys = [holding];
      worker.send(JSON.stringify(response));
    });
    worker.send(JSON.stringify(workerHello("worker-01")));
    await vi.waitFor(() => expect(service.reconcileWorker).toHaveBeenCalledWith("worker-01", [holding]));
    worker.terminate();
    await app.close();
  });
});
