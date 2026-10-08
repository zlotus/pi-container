import { describe, expect, it } from "vitest";

import { LiteLlmAdminClient, ModelGatewayError } from "./admin-client.js";

const MASTER = "sk-master-key-for-tests-only";

function client(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: Array<{ url: string; method: string; body: unknown; authorization: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      authorization: headers.get("authorization"),
    });
    const result = handler(url, init ?? {});
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status });
  }) as typeof fetch;
  return { calls, admin: new LiteLlmAdminClient({ adminUrl: "http://127.0.0.1:4400/", masterKey: MASTER, fetch: fetchImpl }) };
}

describe("LiteLLM admin client (Phase 16.3, 16.15)", () => {
  it("creates the gateway user with a viewer role first and updates it when it exists", async () => {
    const { calls, admin } = client((url) => ({ status: url.endsWith("/user/new") ? 409 : 200, body: {} }));
    await admin.ensureUser("user-1", { maxBudgetUsd: 10, budgetDuration: "30d" });
    expect(calls.map((call) => call.url)).toEqual(["http://127.0.0.1:4400/user/new", "http://127.0.0.1:4400/user/update"]);
    expect(calls[0]?.body).toEqual({ user_id: "user-1", user_role: "internal_user_viewer", max_budget: 10, budget_duration: "30d" });
    expect(calls[1]?.body).toEqual({ user_id: "user-1", max_budget: 10, budget_duration: "30d" });
    expect(calls.every((call) => call.authorization === `Bearer ${MASTER}`)).toBe(true);
  });

  it("generates inference-only keys with the platform metadata field and validates the response", async () => {
    const { calls, admin } = client(() => ({ status: 200, body: { key: "sk-generated-0123456789", token: "hash" } }));
    await expect(
      admin.generateKey({
        userId: "user-1",
        workspaceId: "ws-1",
        keyAlias: "arw-x-1",
        models: ["deepseek-v4-flash"],
        rpmLimit: 60,
        tpmLimit: null,
      }),
    ).resolves.toBe("sk-generated-0123456789");
    expect(calls[0]?.body).toEqual({
      user_id: "user-1",
      key_alias: "arw-x-1",
      key_type: "llm_api",
      models: ["deepseek-v4-flash"],
      rpm_limit: 60,
      metadata: { platform_workspace_id: "ws-1" },
    });
    const bad = client(() => ({ status: 200, body: { key: "short" } }));
    await expect(
      bad.admin.generateKey({ userId: "u", workspaceId: "w", keyAlias: "a", models: [], rpmLimit: 1, tpmLimit: 5 }),
    ).rejects.toMatchObject({ code: "MODEL_GATEWAY_INVALID_RESPONSE" });
  });

  it("treats an unknown alias as deleted and other failures as errors without secrets", async () => {
    await expect(client(() => ({ status: 404, body: { error: "No keys found" } })).admin.deleteKey("arw-x-1")).resolves.toBeUndefined();
    const failed = client(() => ({ status: 500, body: { error: MASTER } }));
    const error = await failed.admin.deleteKey("arw-x-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelGatewayError);
    expect(error).toMatchObject({ code: "MODEL_GATEWAY_UNAVAILABLE", status: 500 });
    expect(String((error as Error).message)).not.toContain(MASTER);
    const refused = client(() => ({ status: 401 }));
    await expect(refused.admin.deleteKey("arw-x-1")).rejects.toMatchObject({ code: "MODEL_GATEWAY_REJECTED" });
  });

  it("reports an unreachable gateway as unavailable", async () => {
    const admin = new LiteLlmAdminClient({
      adminUrl: "http://127.0.0.1:1",
      masterKey: MASTER,
      timeoutMs: 1_000,
    });
    await expect(admin.listModels()).rejects.toMatchObject({ code: "MODEL_GATEWAY_UNAVAILABLE" });
  });

  it("reads usage and returns null for an unknown user", async () => {
    const { admin } = client((url) =>
      url.includes("user_id=known")
        ? { status: 200, body: { user_info: { spend: 1.5, max_budget: null, budget_reset_at: "2026-11-01T00:00:00Z" } } }
        : { status: 404, body: {} },
    );
    await expect(admin.userUsage("known")).resolves.toEqual({ spendUsd: 1.5, maxBudgetUsd: null, budgetResetAt: "2026-11-01T00:00:00Z" });
    await expect(admin.userUsage("unknown")).resolves.toBeNull();
  });
});
