import { WorkerIdSchema, WorkerTokenSchema } from "@agent-runtime/protocol";
import { z } from "zod";

export const WorkerConfigSchema = z
  .object({
    CONTROL_PLANE_URL: z.string().url().refine(
      (value) => value.startsWith("ws://") || value.startsWith("wss://"),
      "CONTROL_PLANE_URL must use ws or wss",
    ),
    WORKER_ID: WorkerIdSchema,
    WORKER_TOKEN: WorkerTokenSchema,
    WORKER_MAX_WORKSPACES: z.coerce.number().int().positive().max(10_000),
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(10_000),
    WORKER_RECONNECT_INITIAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(1_000),
    WORKER_RECONNECT_MAX_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    RUNTIME_IMAGE: z.string().min(1).max(255).default("unavailable"),
    RUNTIME_VERSION: z.string().min(1).max(128).default("phase-2"),
  })
  .refine(
    (value) =>
      value.WORKER_RECONNECT_MAX_MS >= value.WORKER_RECONNECT_INITIAL_MS,
    "WORKER_RECONNECT_MAX_MS must be at least WORKER_RECONNECT_INITIAL_MS",
  )
  .passthrough();

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv,
): WorkerConfig {
  return WorkerConfigSchema.parse(environment);
}
