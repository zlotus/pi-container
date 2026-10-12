import { z } from "zod";

/** Observed resource usage reported with every heartbeat (specs.md Phase 17.5, 17.6). */

const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Worker host CPU, memory and load since the previous heartbeat. */
export const WorkerHostUsageSchema = z
  .object({
    /** Busy share of all host CPUs between two heartbeats; null before the second sample. */
    cpuUtilization: z.number().min(0).max(1).nullable(),
    memoryTotalBytes: CountSchema,
    memoryAvailableBytes: CountSchema,
    load1: z.number().nonnegative().max(1_000_000),
  })
  .strict()
  .refine(
    (value) => value.memoryAvailableBytes <= value.memoryTotalBytes,
    "memoryAvailableBytes cannot exceed memoryTotalBytes",
  );

/** One running Workspace container, sampled through the Docker Engine stats API. */
export const WorkspaceUsageSchema = z
  .object({
    workspaceId: z.string().uuid(),
    sampledAt: z.string().datetime({ offset: true }),
    /** Cumulative container CPU time; a counter that resets when the container is recreated. */
    cpuUsageNanos: CountSchema,
    /** CPU cores used between the two most recent samples; null without a usable previous sample. */
    cpuCores: z.number().nonnegative().max(1_024).nullable(),
    cpuLimitCores: z.number().nonnegative().max(1_024),
    /** `usage - inactive_file`, the figure `docker stats` shows. */
    memoryBytes: CountSchema,
    memoryLimitBytes: CountSchema,
    pids: CountSchema,
    pidsLimit: CountSchema,
    networkRxBytes: CountSchema,
    networkTxBytes: CountSchema,
    /** OOM events the Worker observed since it started; a lower bound (Phase 17.5). */
    oomKills: CountSchema,
  })
  .strict();

export const ModelRelayResultSchema = z.enum([
  "2xx",
  "4xx",
  "5xx",
  "no_key",
  "gateway_unavailable",
  "rejected_path",
  "body_too_large",
  "concurrency_limited",
]);

/** Cumulative model relay counters since the Worker started. */
export const ModelRelayStatsSchema = z
  .object({
    requests: z.record(ModelRelayResultSchema, CountSchema),
    rejectedConnections: CountSchema,
    activeRequests: CountSchema,
  })
  .strict();

export type WorkerHostUsage = z.infer<typeof WorkerHostUsageSchema>;
export type WorkspaceUsage = z.infer<typeof WorkspaceUsageSchema>;
export type ModelRelayResult = z.infer<typeof ModelRelayResultSchema>;
export type ModelRelayStats = z.infer<typeof ModelRelayStatsSchema>;
