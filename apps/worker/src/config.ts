import { WorkerIdSchema, WorkerTokenSchema } from "@agent-runtime/protocol";
import { parseWorkspaceBaseUrl } from "@agent-runtime/gateway";
import { z } from "zod";

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), "path must be absolute");

export const WorkerConfigSchema = z
  .object({
    CONTROL_PLANE_URL: z.string().url().refine(
      (value) => value.startsWith("ws://") || value.startsWith("wss://"),
      "CONTROL_PLANE_URL must use ws or wss",
    ),
    WORKER_ID: WorkerIdSchema,
    WORKER_TOKEN: WorkerTokenSchema,
    WORKER_GATEWAY_TOKEN: WorkerTokenSchema,
    WORKER_GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
    WORKER_GATEWAY_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .default(3_100),
    WORKER_GATEWAY_TLS_CERT_PATH: AbsolutePathSchema.optional(),
    WORKER_GATEWAY_TLS_KEY_PATH: AbsolutePathSchema.optional(),
    WORKSPACE_BASE_URL: z
      .string()
      .transform((value, context) => {
        try {
          parseWorkspaceBaseUrl(value);
          return value;
        } catch {
          context.addIssue({
            code: "custom",
            message: "WORKSPACE_BASE_URL must be an HTTP(S) origin",
          });
          return z.NEVER;
        }
      }),
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
    RUNTIME_IMAGE: z
      .string()
      .min(1)
      .max(255)
      .default("agent-runtime:phase7-toolchain"),
    RUNTIME_VERSION: z.string().min(1).max(128).default("phase-7"),
    RUNTIME_CAPABILITY_PROBE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(300_000)
      .default(120_000),
    DOCKER_SOCKET_PATH: AbsolutePathSchema.default("/var/run/docker.sock"),
    WORKER_MANAGED_ROOT: AbsolutePathSchema.default("/var/lib/agent-runtime"),
    WORKSPACE_CPU_COUNT: z.coerce.number().positive().max(256).default(2),
    WORKSPACE_MEMORY_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(4 * 1024 ** 3),
    WORKSPACE_PIDS_LIMIT: z.coerce.number().int().positive().default(512),
    WORKSPACE_UID: z.coerce.number().int().positive().default(1_000),
    WORKSPACE_GID: z.coerce.number().int().positive().default(1_000),
    WORKSPACE_START_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(60_000),
  })
  .refine(
    (value) =>
      value.WORKER_RECONNECT_MAX_MS >= value.WORKER_RECONNECT_INITIAL_MS,
    "WORKER_RECONNECT_MAX_MS must be at least WORKER_RECONNECT_INITIAL_MS",
  )
  .refine(
    (value) =>
      (value.WORKER_GATEWAY_TLS_CERT_PATH === undefined) ===
      (value.WORKER_GATEWAY_TLS_KEY_PATH === undefined),
    "Worker Gateway TLS certificate and key must be configured together",
  )
  .refine(
    (value) => value.WORKER_GATEWAY_TOKEN !== value.WORKER_TOKEN,
    "Worker control and Gateway credentials must be different",
  )
  .passthrough();

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv,
): WorkerConfig {
  return WorkerConfigSchema.parse(environment);
}
