import { z } from "zod";

export const WORKER_PROTOCOL_VERSION = 1 as const;

export const WorkspaceIdSchema = z.string().uuid();

export const WorkerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);

export const WorkerTokenSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const ArchitectureSchema = z.enum(["amd64", "arm64"]);

export const WorkspaceStateSchema = z.enum([
  "CREATED",
  "SCHEDULING",
  "STARTING",
  "RUNNING",
  "STOPPING",
  "STOPPED",
  "DELETING",
  "ERROR",
  "WORKER_OFFLINE",
]);

export const WorkspaceDesiredStateSchema = z.enum([
  "RUNNING",
  "STOPPED",
  "DELETED",
  "UNKNOWN",
]);

export const WorkerCapabilitiesSchema = z
  .object({
    browser: z.boolean(),
    office: z.boolean(),
    ffmpeg: z.boolean(),
    python: z.boolean(),
    node: z.boolean(),
    rust: z.boolean(),
  })
  .strict();

export const WorkerSystemResourcesSchema = z
  .object({
    logicalCpuCount: z.number().int().positive().max(4_096),
    memoryBytes: z.number().int().positive().safe(),
  })
  .strict();

export const WorkspaceResourcesSchema = z
  .object({
    cpuCount: z.number().positive().max(256),
    memoryBytes: z.number().int().positive(),
    pidsLimit: z.number().int().positive(),
  })
  .strict();

const RequestEnvelopeSchema = z
  .object({
    version: z.literal(WORKER_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
  })
  .strict();

export const WorkerHelloMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("worker.hello"),
  payload: z
    .object({
      workerId: WorkerIdSchema,
      hostname: z.string().min(1).max(255),
      architecture: ArchitectureSchema,
      runtimeImage: z.string().min(1).max(255),
      runtimeVersion: z.string().min(1).max(128),
      capabilities: WorkerCapabilitiesSchema,
      maxWorkspaces: z.number().int().positive().max(10_000),
      allocatedWorkspaces: z.number().int().nonnegative().max(10_000),
      systemResources: WorkerSystemResourcesSchema,
    })
    .strict()
    .refine(
      (value) => value.allocatedWorkspaces <= value.maxWorkspaces,
      "allocatedWorkspaces cannot exceed maxWorkspaces",
    ),
}).strict();

export const WorkerHeartbeatMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("worker.heartbeat"),
  payload: z
    .object({
      workerId: WorkerIdSchema,
      allocatedWorkspaces: z.number().int().nonnegative().max(10_000),
      observedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
}).strict();

const WorkspaceCommandPayloadSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
  })
  .strict();

export const WorkspaceCommandTypeSchema = z.enum([
  "workspace.ensure",
  "workspace.start",
  "workspace.stop",
  "workspace.delete",
  "workspace.inspect",
]);

export const WorkspaceObservationSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    state: WorkspaceStateSchema,
    runtimeImage: z.string().min(1).max(255),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const WorkerReconcileAssignmentSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runtimeImage: z.string().min(1).max(255),
    desiredState: WorkspaceDesiredStateSchema,
  })
  .strict();

const WorkerReconcileObservedWorkspaceSchema = z
  .object({
    status: z.literal("OBSERVED"),
    workspace: WorkspaceObservationSchema,
  })
  .strict();

const WorkerReconcileMissingWorkspaceSchema = z
  .object({
    status: z.literal("MISSING"),
    workspaceId: WorkspaceIdSchema,
  })
  .strict();

const WorkerReconcileInvalidWorkspaceSchema = z
  .object({
    status: z.literal("INVALID"),
    workspaceId: WorkspaceIdSchema,
    code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
    retryable: z.boolean(),
  })
  .strict();

export const WorkerReconcileWorkspaceResultSchema = z.discriminatedUnion(
  "status",
  [
    WorkerReconcileObservedWorkspaceSchema,
    WorkerReconcileMissingWorkspaceSchema,
    WorkerReconcileInvalidWorkspaceSchema,
  ],
);

export const WorkerRecoveryIssueSchema = z
  .object({
    classification: z.enum([
      "MANAGED_ORPHAN",
      "FOREIGN_MANAGED_RESOURCE",
      "UNKNOWN_RESOURCE",
    ]),
    resource: z.enum(["CONTAINER", "DIRECTORY", "NETWORK"]),
    workspaceId: WorkspaceIdSchema.optional(),
    code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
  })
  .strict();

export const WorkerReconciliationReportSchema = z
  .object({
    workspaces: z.array(WorkerReconcileWorkspaceResultSchema).max(10_000),
    issues: z.array(WorkerRecoveryIssueSchema).max(10_000),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    (report) => {
      const ids = report.workspaces.map((entry) =>
        entry.status === "OBSERVED"
          ? entry.workspace.workspaceId
          : entry.workspaceId,
      );
      return new Set(ids).size === ids.length;
    },
    "Reconciliation results must contain unique Workspace IDs",
  );

export const WorkerReconcileMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("worker.reconcile"),
  payload: z
    .object({
      assignments: z.array(WorkerReconcileAssignmentSchema).max(10_000),
    })
    .strict()
    .refine(
      (payload) =>
        new Set(payload.assignments.map((entry) => entry.workspaceId)).size ===
        payload.assignments.length,
      "Authoritative assignments must contain unique Workspace IDs",
    ),
}).strict();

export const ControlCommandTypeSchema = z.union([
  WorkspaceCommandTypeSchema,
  z.literal("worker.reconcile"),
]);

export const WorkspaceEnsureMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("workspace.ensure"),
  payload: z
    .object({
      workspaceId: WorkspaceIdSchema,
      runtimeImage: z.string().min(1).max(255),
      resources: WorkspaceResourcesSchema,
    })
    .strict(),
}).strict();

export const WorkspaceStartMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("workspace.start"),
  payload: WorkspaceCommandPayloadSchema,
}).strict();

export const WorkspaceStopMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("workspace.stop"),
  payload: WorkspaceCommandPayloadSchema,
}).strict();

export const WorkspaceDeleteMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("workspace.delete"),
  payload: WorkspaceCommandPayloadSchema,
}).strict();

export const WorkspaceInspectMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("workspace.inspect"),
  payload: WorkspaceCommandPayloadSchema,
}).strict();

const WorkspaceResponseOkPayloadSchema = z
  .object({
    requestType: WorkspaceCommandTypeSchema,
    workspace: WorkspaceObservationSchema,
  })
  .strict();

const WorkerReconcileResponseOkPayloadSchema = z
  .object({
    requestType: z.literal("worker.reconcile"),
    reconciliation: WorkerReconciliationReportSchema,
  })
  .strict();

export const ResponseOkMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("response.ok"),
  payload: z.union([
    WorkspaceResponseOkPayloadSchema,
    WorkerReconcileResponseOkPayloadSchema,
  ]),
}).strict();

export const ResponseErrorMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("response.error"),
  payload: z
    .object({
      requestType: ControlCommandTypeSchema,
      code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
      message: z.string().min(1).max(1_024),
      retryable: z.boolean(),
    })
    .strict(),
}).strict();

const EventEnvelopeSchema = z
  .object({
    version: z.literal(WORKER_PROTOCOL_VERSION),
    eventId: z.string().uuid(),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const WorkspaceEventMessageSchema = EventEnvelopeSchema.extend({
  type: z.literal("event.workspace"),
  payload: z
    .object({
      workerId: WorkerIdSchema,
      workspace: WorkspaceObservationSchema,
    })
    .strict(),
}).strict();

export const WorkerErrorEventMessageSchema = EventEnvelopeSchema.extend({
  type: z.literal("event.error"),
  payload: z
    .object({
      workerId: WorkerIdSchema,
      workspaceId: WorkspaceIdSchema.optional(),
      code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
      message: z.string().min(1).max(1_024),
    })
    .strict(),
}).strict();

export const WorkerToControlMessageSchema = z.discriminatedUnion("type", [
  WorkerHelloMessageSchema,
  WorkerHeartbeatMessageSchema,
  ResponseOkMessageSchema,
  ResponseErrorMessageSchema,
  WorkspaceEventMessageSchema,
  WorkerErrorEventMessageSchema,
]);

export const ControlToWorkerMessageSchema = z.discriminatedUnion("type", [
  WorkerReconcileMessageSchema,
  WorkspaceEnsureMessageSchema,
  WorkspaceStartMessageSchema,
  WorkspaceStopMessageSchema,
  WorkspaceDeleteMessageSchema,
  WorkspaceInspectMessageSchema,
]);

export type Architecture = z.infer<typeof ArchitectureSchema>;
export type ControlToWorkerMessage = z.infer<
  typeof ControlToWorkerMessageSchema
>;
export type WorkerCapabilities = z.infer<typeof WorkerCapabilitiesSchema>;
export type WorkerSystemResources = z.infer<
  typeof WorkerSystemResourcesSchema
>;
export type WorkerToControlMessage = z.infer<
  typeof WorkerToControlMessageSchema
>;
export type WorkspaceResources = z.infer<typeof WorkspaceResourcesSchema>;
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type WorkspaceObservation = z.infer<typeof WorkspaceObservationSchema>;
export type WorkspaceDesiredState = z.infer<typeof WorkspaceDesiredStateSchema>;
export type WorkerReconcileAssignment = z.infer<
  typeof WorkerReconcileAssignmentSchema
>;
export type WorkerReconciliationReport = z.infer<
  typeof WorkerReconciliationReportSchema
>;
export type WorkerRecoveryIssue = z.infer<typeof WorkerRecoveryIssueSchema>;
