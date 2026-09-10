import { WorkerIdSchema } from "@agent-runtime/protocol";
import { z } from "zod";

export const WorkerConfigSchema = z
  .object({
    CONTROL_PLANE_URL: z.string().url().refine(
      (value) => value.startsWith("ws://") || value.startsWith("wss://"),
      "CONTROL_PLANE_URL must use ws or wss",
    ),
    WORKER_ID: WorkerIdSchema,
    WORKER_TOKEN: z.string().min(32),
  })
  .passthrough();

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv,
): WorkerConfig {
  return WorkerConfigSchema.parse(environment);
}
