import { z } from "zod";

import { ModelRelayStatsSchema } from "./usage.js";

/**
 * Platform model catalog and model relay types (specs.md Phase 16.5, 16.9). A catalog model is
 * the subset of a Pi 0.85.1 `models.json` model definition the platform writes for its own
 * provider; `id` is also the LiteLLM `model_name`.
 */

/** Pi 0.85.1 built-in provider IDs; the platform provider must not merge into one of them. */
export const PI_BUILT_IN_PROVIDER_IDS = [
  "amazon-bedrock", "ant-ling", "anthropic", "azure-openai-responses", "baseten", "cerebras",
  "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks", "github-copilot",
  "google-vertex", "google", "groq", "huggingface", "kimi-coding", "minimax-cn", "minimax",
  "mistral", "moonshotai-cn", "moonshotai", "nvidia", "openai-codex", "openai", "opencode-go",
  "opencode", "openrouter", "qwen-token-plan-cn", "qwen-token-plan-individual",
  "qwen-token-plan", "radius", "together", "vercel-ai-gateway", "xai", "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "xiaomi", "zai-coding-cn", "zai",
] as const;

/** The literal written as the platform provider's `apiKey`; the relay discards it. */
export const MODEL_RELAY_PLACEHOLDER_API_KEY = "agent-runtime-relay";

export const MODEL_CATALOG_MAX_MODELS = 100;
const COMPAT_MAX_BYTES = 8 * 1024;

export const ModelApiSchema = z.enum(["openai-completions", "openai-responses", "anthropic-messages"]);

/** Inference routes the relay forwards for each API type (specs.md Phase 16.4). */
export const MODEL_RELAY_ROUTES: Record<z.infer<typeof ModelApiSchema>, readonly string[]> = {
  "openai-completions": ["/v1/chat/completions"],
  "openai-responses": ["/v1/responses"],
  "anthropic-messages": ["/v1/messages", "/v1/messages/count_tokens"],
};

export const ModelProviderIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .refine(
    (value) => !(PI_BUILT_IN_PROVIDER_IDS as readonly string[]).includes(value),
    "providerId must not be a Pi built-in provider",
  );

export const ModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);

const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CostRateSchema = z.number().nonnegative().max(1_000_000);

export const ModelCatalogModelSchema = z
  .object({
    id: ModelIdSchema,
    name: z.string().min(1).max(128).optional(),
    api: ModelApiSchema,
    reasoning: z.boolean().optional(),
    thinkingLevelMap: z
      .partialRecord(ThinkingLevelSchema, z.string().min(1).max(32).nullable())
      .optional(),
    input: z
      .array(z.enum(["text", "image"]))
      .min(1)
      .max(2)
      .refine((value) => new Set(value).size === value.length, "input must not repeat")
      .optional(),
    contextWindow: z.number().int().positive().max(100_000_000).optional(),
    maxTokens: z.number().int().positive().max(100_000_000).optional(),
    cost: z
      .object({
        input: CostRateSchema,
        output: CostRateSchema,
        cacheRead: CostRateSchema,
        cacheWrite: CostRateSchema,
      })
      .partial()
      .strict()
      .optional(),
    compat: z
      .record(z.string().min(1).max(64), z.json())
      .refine(
        (value) => new TextEncoder().encode(JSON.stringify(value)).length <= COMPAT_MAX_BYTES,
        `compat must serialize to at most ${COMPAT_MAX_BYTES} bytes`,
      )
      .optional(),
  })
  .strict();

/** What `workspace.ensure` tells the Worker to write as the platform provider. */
export const ModelGatewayConfigSchema = z
  .object({
    providerId: ModelProviderIdSchema,
    defaultModel: ModelIdSchema,
    models: z.array(ModelCatalogModelSchema).min(1).max(MODEL_CATALOG_MAX_MODELS),
  })
  .strict()
  .refine(
    (value) => new Set(value.models.map((model) => model.id)).size === value.models.length,
    "model IDs must be unique",
  )
  .refine(
    (value) => value.models.some((model) => model.id === value.defaultModel),
    "defaultModel must be one of the models",
  )
  .refine(
    (value) => new Set(value.models.map((model) => modelApiBasePath(model.api))).size === 1,
    "OpenAI and Anthropic APIs cannot share one provider (their SDKs append different paths)",
  );

/**
 * The provider `baseUrl` path for an API type: the OpenAI SDKs append `/chat/completions` or
 * `/responses` to a base ending in `/v1`, the Anthropic SDK appends `/v1/messages` itself.
 */
export function modelApiBasePath(api: z.infer<typeof ModelApiSchema>): "/v1" | "" {
  return api === "anthropic-messages" ? "" : "/v1";
}

/** Result of writing the platform provider into `/agent/pi/models.json` (Phase 16.5). */
export const ModelConfigResultSchema = z.enum([
  "applied",
  "removed",
  "unchanged_running",
  "user_config_invalid",
  "write_failed",
]);

export const ModelRelayStatusSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65_535).nullable(),
    listening: z.boolean(),
    /** Cumulative relay counters (Phase 17.6); omitted while the relay is disabled. */
    stats: ModelRelayStatsSchema.optional(),
  })
  .strict();

/** `arw-<Workspace UUID>-<sequence>`; the gateway-side locator of a virtual key. */
export const ModelKeyAliasSchema = z
  .string()
  .regex(/^arw-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[1-9][0-9]{0,9}$/);

/** A virtual key secret. Never logged (the logging redaction covers the `secret` field). */
export const ModelKeySecretSchema = z.string().regex(/^[\x21-\x7e]{16,512}$/);

export function modelKeyAliasWorkspaceId(alias: string): string {
  return alias.slice(4, 40);
}

export type ModelApi = z.infer<typeof ModelApiSchema>;
export type ModelCatalogModel = z.infer<typeof ModelCatalogModelSchema>;
export type ModelGatewayConfig = z.infer<typeof ModelGatewayConfigSchema>;
export type ModelConfigResult = z.infer<typeof ModelConfigResultSchema>;
export type ModelRelayStatus = z.infer<typeof ModelRelayStatusSchema>;
