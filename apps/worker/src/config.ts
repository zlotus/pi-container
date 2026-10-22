import {
  Ipv4CidrListConfigSchema,
  WorkerIdSchema,
  WorkerTokenSchema,
} from "@agent-runtime/protocol";
import { parseWorkspaceBaseUrl } from "@agent-runtime/gateway";
import { z } from "zod";

import { parseRuntimeImages } from "./runtime-images.js";

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
    /** `<reference>@sha256:<digest>`, comma separated (specs.md Phase 18.4); required. */
    RUNTIME_IMAGES: z.string().min(1).max(2_048),
    RUNTIME_CAPABILITY_PROBE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(300_000)
      .default(120_000),
    DOCKER_SOCKET_PATH: AbsolutePathSchema.default("/var/run/docker.sock"),
    /** Plain path characters only: it reaches `xfs_quota -c` (specs.md Phase 15.3). */
    WORKER_MANAGED_ROOT: AbsolutePathSchema.default("/var/lib/agent-runtime").refine(
      (value) => /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.split("/").includes(".."),
      "WORKER_MANAGED_ROOT may only contain letters, digits, '.', '_', '-' and '/'",
    ),
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
    WORKER_EGRESS_PROTECTED: Ipv4CidrListConfigSchema,
    WORKER_EGRESS_NFT_PATH: AbsolutePathSchema.default("/usr/sbin/nft"),
    WORKER_XFS_QUOTA_PATH: AbsolutePathSchema.default("/usr/sbin/xfs_quota"),
    WORKER_LSATTR_PATH: AbsolutePathSchema.default("/usr/bin/lsattr"),
    /** Start of this Worker's project ID range; the first ID is the capability probe's. */
    WORKER_QUOTA_PROJECT_ID_MIN: z.coerce.number().int().min(1).max(2 ** 31).default(1_000_000),
    WORKSPACE_DATA_INODE_LIMIT: z.coerce.number().int().min(1_000).max(2 ** 32).default(2_000_000),
    WORKSPACE_PI_STATE_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(256 * 1024 ** 2)
      .max(2 ** 50)
      .default(2 * 1024 ** 3),
    WORKSPACE_PI_INODE_LIMIT: z.coerce.number().int().min(1_000).max(2 ** 32).default(200_000),
    WORKSPACE_NOFILE_LIMIT: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
    /** The model gateway origin this Worker relays to; unset disables the relay (Phase 16). */
    WORKER_MODEL_GATEWAY_URL: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//.test(value), "WORKER_MODEL_GATEWAY_URL must use http or https")
      .refine((value) => {
        const url = new URL(value);
        return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
      }, "WORKER_MODEL_GATEWAY_URL must not carry credentials, a query or a fragment")
      .optional(),
    WORKER_MODEL_RELAY_PORT: z.coerce.number().int().min(1).max(65_535).default(3_101),
    WORKER_MODEL_RELAY_MAX_BODY_BYTES: z.coerce
      .number()
      .int()
      .min(1024 ** 2)
      .max(256 * 1024 ** 2)
      .default(32 * 1024 ** 2),
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
    (value) =>
      value.WORKER_MODEL_GATEWAY_URL === undefined ||
      value.WORKER_MODEL_RELAY_PORT !== value.WORKER_GATEWAY_PORT,
    "WORKER_MODEL_RELAY_PORT must differ from WORKER_GATEWAY_PORT",
  )
  .refine(
    (value) => {
      try {
        parseRuntimeImages(value.RUNTIME_IMAGES);
        return true;
      } catch {
        return false;
      }
    },
    "RUNTIME_IMAGES must list 1 to 4 unique <reference>@sha256:<digest> entries",
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
  // The unpinned single-image variables of Phase 18's transition were removed in v1.0
  // (specs.md Phase 19.8); refuse them rather than silently ignoring an old configuration.
  for (const removed of ["RUNTIME_IMAGE", "RUNTIME_VERSION"] as const) {
    if (environment[removed] !== undefined) {
      throw new Error(
        `${removed} is no longer supported; list images as RUNTIME_IMAGES=<image>@sha256:<digest> ` +
          "(docs/lifecycle-runbook.md)",
      );
    }
  }
  return WorkerConfigSchema.parse(environment);
}
