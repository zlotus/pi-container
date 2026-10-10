import { describe, expect, it } from "vitest";

import {
  meteredModelGatewayAdmin,
  ModelGatewayError,
  type ModelGatewayAdmin,
} from "./admin-client.js";

describe("metered model gateway admin (Phase 17.4)", () => {
  it("records ok, unreachable and rejected calls per operation and passes results through", async () => {
    const records: Array<[string, string]> = [];
    const inner: ModelGatewayAdmin = {
      ensureUser: async () => undefined,
      generateKey: async () => "sk-generated-0123456789",
      deleteKey: async () => {
        throw new ModelGatewayError("MODEL_GATEWAY_UNAVAILABLE", null);
      },
      listModels: async () => {
        throw new ModelGatewayError("MODEL_GATEWAY_REJECTED", 403);
      },
      userUsage: async () => null,
    };
    const admin = meteredModelGatewayAdmin(inner, (operation, result) => records.push([operation, result]));
    await admin.ensureUser("u", { maxBudgetUsd: null, budgetDuration: "30d" });
    await expect(
      admin.generateKey({ userId: "u", workspaceId: "w", keyAlias: "a", models: [], rpmLimit: 1, tpmLimit: null }),
    ).resolves.toBe("sk-generated-0123456789");
    await expect(admin.deleteKey("a")).rejects.toMatchObject({ code: "MODEL_GATEWAY_UNAVAILABLE" });
    await expect(admin.listModels()).rejects.toMatchObject({ code: "MODEL_GATEWAY_REJECTED" });
    await expect(admin.userUsage("u")).resolves.toBeNull();
    expect(records).toEqual([
      ["ensure_user", "ok"],
      ["generate_key", "ok"],
      ["delete_key", "unreachable"],
      ["list_models", "error"],
      ["user_info", "ok"],
    ]);
    // The secret never reaches the metrics callback.
    expect(JSON.stringify(records)).not.toContain("sk-generated");
  });
});
