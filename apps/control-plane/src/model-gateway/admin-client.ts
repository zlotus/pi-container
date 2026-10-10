import { z } from "zod";

import type { ModelGatewayOperation, ModelGatewayResult } from "../metrics/platform-metrics.js";

/**
 * The model gateway's management API as the Control Plane uses it (specs.md Phase 16.3,
 * verified against LiteLLM 1.104.1 in Phase 16.15). Only the Control Plane holds the master
 * key; nothing here is reachable from Workspaces. Responses are validated, and neither the
 * master key nor a returned secret is ever part of an error message.
 */
export class ModelGatewayError extends Error {
  constructor(
    readonly code: "MODEL_GATEWAY_UNAVAILABLE" | "MODEL_GATEWAY_REJECTED" | "MODEL_GATEWAY_INVALID_RESPONSE",
    readonly status: number | null,
  ) {
    super(`model gateway request failed: ${code}${status === null ? "" : ` (${status})`}`);
  }
}

export interface ModelUserBudget {
  maxBudgetUsd: number | null;
  budgetDuration: string;
}

export interface ModelUsage {
  spendUsd: number;
  maxBudgetUsd: number | null;
  budgetResetAt: string | null;
}

export interface ModelGatewayAdmin {
  /** Creates the gateway user for a platform user (LiteLLM `internal_user_viewer`), or updates its budget. */
  ensureUser(userId: string, budget: ModelUserBudget): Promise<void>;
  generateKey(input: {
    userId: string;
    workspaceId: string;
    keyAlias: string;
    models: readonly string[];
    rpmLimit: number;
    tpmLimit: number | null;
  }): Promise<string>;
  /** Idempotent: an alias the gateway does not know counts as deleted. */
  deleteKey(keyAlias: string): Promise<void>;
  listModels(): Promise<string[]>;
  userUsage(userId: string): Promise<ModelUsage | null>;
}

const GenerateResponseSchema = z.object({ key: z.string().regex(/^[\x21-\x7e]{16,512}$/) }).passthrough();
const ModelInfoResponseSchema = z
  .object({ data: z.array(z.object({ model_name: z.string() }).passthrough()) })
  .passthrough();
const UserInfoResponseSchema = z
  .object({
    user_info: z
      .object({
        spend: z.number().nonnegative().nullable().optional(),
        max_budget: z.number().nonnegative().nullable().optional(),
        budget_reset_at: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export class LiteLlmAdminClient implements ModelGatewayAdmin {
  readonly #origin: string;
  readonly #masterKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: { adminUrl: string; masterKey: string; timeoutMs?: number; fetch?: typeof fetch }) {
    this.#origin = options.adminUrl.replace(/\/+$/, "");
    this.#masterKey = options.masterKey;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#masterKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new ModelGatewayError("MODEL_GATEWAY_UNAVAILABLE", null);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (response.status >= 500) throw new ModelGatewayError("MODEL_GATEWAY_UNAVAILABLE", response.status);
    return { status: response.status, json };
  }

  async ensureUser(userId: string, budget: ModelUserBudget): Promise<void> {
    const fields = { max_budget: budget.maxBudgetUsd, budget_duration: budget.budgetDuration };
    // `/user/update` would silently create a user without a role; create explicitly first.
    const created = await this.#call("POST", "/user/new", {
      user_id: userId,
      user_role: "internal_user_viewer",
      ...fields,
    });
    if (created.status === 200) return;
    if (created.status !== 409) throw new ModelGatewayError("MODEL_GATEWAY_REJECTED", created.status);
    const updated = await this.#call("POST", "/user/update", { user_id: userId, ...fields });
    if (updated.status !== 200) throw new ModelGatewayError("MODEL_GATEWAY_REJECTED", updated.status);
  }

  async generateKey(input: {
    userId: string;
    workspaceId: string;
    keyAlias: string;
    models: readonly string[];
    rpmLimit: number;
    tpmLimit: number | null;
  }): Promise<string> {
    const result = await this.#call("POST", "/key/generate", {
      user_id: input.userId,
      key_alias: input.keyAlias,
      key_type: "llm_api",
      models: [...input.models],
      rpm_limit: input.rpmLimit,
      ...(input.tpmLimit === null ? {} : { tpm_limit: input.tpmLimit }),
      // `workspace_id` is rejected as a client-side provider parameter (Phase 16.15).
      metadata: { platform_workspace_id: input.workspaceId },
    });
    if (result.status !== 200) throw new ModelGatewayError("MODEL_GATEWAY_REJECTED", result.status);
    const parsed = GenerateResponseSchema.safeParse(result.json);
    if (!parsed.success) throw new ModelGatewayError("MODEL_GATEWAY_INVALID_RESPONSE", result.status);
    return parsed.data.key;
  }

  async deleteKey(keyAlias: string): Promise<void> {
    const result = await this.#call("POST", "/key/delete", { key_aliases: [keyAlias] });
    // 404 "No keys found": already gone, which is what revocation needs.
    if (result.status === 200 || result.status === 404) return;
    throw new ModelGatewayError("MODEL_GATEWAY_REJECTED", result.status);
  }

  async listModels(): Promise<string[]> {
    const result = await this.#call("GET", "/model/info");
    if (result.status !== 200) throw new ModelGatewayError("MODEL_GATEWAY_REJECTED", result.status);
    const parsed = ModelInfoResponseSchema.safeParse(result.json);
    if (!parsed.success) throw new ModelGatewayError("MODEL_GATEWAY_INVALID_RESPONSE", result.status);
    return [...new Set(parsed.data.data.map((model) => model.model_name))].sort();
  }

  async userUsage(userId: string): Promise<ModelUsage | null> {
    const result = await this.#call("GET", `/user/info?user_id=${encodeURIComponent(userId)}`);
    if (result.status === 404) return null;
    if (result.status !== 200) throw new ModelGatewayError("MODEL_GATEWAY_REJECTED", result.status);
    const parsed = UserInfoResponseSchema.safeParse(result.json);
    if (!parsed.success) throw new ModelGatewayError("MODEL_GATEWAY_INVALID_RESPONSE", result.status);
    const info = parsed.data.user_info;
    return {
      spendUsd: info.spend ?? 0,
      maxBudgetUsd: info.max_budget ?? null,
      budgetResetAt: info.budget_reset_at ?? null,
    };
  }
}

/** Counts every management call by operation and result (specs.md Phase 17.4). */
export function meteredModelGatewayAdmin(
  admin: ModelGatewayAdmin,
  record: (operation: ModelGatewayOperation, result: ModelGatewayResult) => void,
): ModelGatewayAdmin {
  async function metered<T>(operation: ModelGatewayOperation, call: () => Promise<T>): Promise<T> {
    try {
      const value = await call();
      record(operation, "ok");
      return value;
    } catch (error) {
      record(
        operation,
        error instanceof ModelGatewayError && error.code === "MODEL_GATEWAY_UNAVAILABLE" ? "unreachable" : "error",
      );
      throw error;
    }
  }
  return {
    ensureUser: (userId, budget) => metered("ensure_user", () => admin.ensureUser(userId, budget)),
    generateKey: (input) => metered("generate_key", () => admin.generateKey(input)),
    deleteKey: (keyAlias) => metered("delete_key", () => admin.deleteKey(keyAlias)),
    listModels: () => metered("list_models", () => admin.listModels()),
    userUsage: (userId) => metered("user_info", () => admin.userUsage(userId)),
  };
}
