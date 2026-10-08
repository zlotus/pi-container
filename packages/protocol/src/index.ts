import { z } from "zod";

import { EgressPolicySchema, WorkerEgressStatusSchema } from "./egress.js";
import {
  ModelConfigResultSchema,
  ModelGatewayConfigSchema,
  ModelKeyAliasSchema,
  ModelKeySecretSchema,
  ModelRelayStatusSchema,
} from "./model-gateway.js";

export * from "./egress.js";
export * from "./model-gateway.js";

export const WORKER_PROTOCOL_VERSION = 4 as const;

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

const GIB = 1024 ** 3;

/** The data-project limit of one Workspace (specs.md Phase 15.3). */
export const DiskLimitBytesSchema = z
  .number()
  .int()
  .min(GIB)
  .max(2 ** 50);

const ByteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Whether the Worker's managed root is a quota-enforcing filesystem (Phase 15.6). */
export const WorkerStorageStatusSchema = z
  .object({
    enforced: z.boolean(),
    fsType: z.string().min(1).max(32).regex(/^[a-z0-9_.-]+$/).nullable(),
    totalBytes: ByteCountSchema.nullable(),
    freeBytes: ByteCountSchema.nullable(),
  })
  .strict();

/** One Workspace's sampled project usage, as `statfs` reports it. */
export const WorkspaceDiskUsageSchema = z
  .object({
    workspaceId: z.string().uuid(),
    dataUsedBytes: ByteCountSchema,
    dataLimitBytes: ByteCountSchema,
    dataUsedInodes: ByteCountSchema,
    piUsedBytes: ByteCountSchema,
    piLimitBytes: ByteCountSchema,
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
      egress: WorkerEgressStatusSchema,
      storage: WorkerStorageStatusSchema,
      modelRelay: ModelRelayStatusSchema,
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
      egress: WorkerEgressStatusSchema,
      storage: WorkerStorageStatusSchema,
      modelRelay: ModelRelayStatusSchema,
      workspaceDisk: z.array(WorkspaceDiskUsageSchema).max(10_000).optional(),
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
    diskLimitBytes: DiskLimitBytesSchema,
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

/** A virtual key alias the Worker holds for one of its Workspaces (Phase 16.6). */
export const WorkerModelKeyHoldingSchema = z
  .object({ workspaceId: WorkspaceIdSchema, keyAlias: ModelKeyAliasSchema })
  .strict();

export const WorkerReconciliationReportSchema = z
  .object({
    workspaces: z.array(WorkerReconcileWorkspaceResultSchema).max(10_000),
    issues: z.array(WorkerRecoveryIssueSchema).max(10_000),
    modelKeys: z.array(WorkerModelKeyHoldingSchema).max(10_000),
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

export const WorkerEgressApplyMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("worker.egress.apply"),
  payload: EgressPolicySchema,
}).strict();

export const ControlCommandTypeSchema = z.union([
  WorkspaceCommandTypeSchema,
  z.literal("worker.reconcile"),
  z.literal("worker.egress.apply"),
  z.literal("workspace.storage.set"),
  z.literal("workspace.model_key.set"),
  z.literal("workspace.model_key.clear"),
]);

export const WorkspaceEnsureMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("workspace.ensure"),
  payload: z
    .object({
      workspaceId: WorkspaceIdSchema,
      runtimeImage: z.string().min(1).max(255),
      resources: WorkspaceResourcesSchema,
      storage: z.object({ diskLimitBytes: DiskLimitBytesSchema }).strict(),
      /** The platform provider to write into models.json; null removes it (Phase 16.5). */
      modelGateway: ModelGatewayConfigSchema.nullable(),
    })
    .strict(),
}).strict();

/** Hands a Workspace's virtual key to the Worker's model relay (Phase 16.6, 16.9). */
export const WorkspaceModelKeySetMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("workspace.model_key.set"),
  payload: z
    .object({
      workspaceId: WorkspaceIdSchema,
      keyAlias: ModelKeyAliasSchema,
      secret: ModelKeySecretSchema,
    })
    .strict()
    .refine(
      (value) => value.keyAlias.slice(4, 40) === value.workspaceId,
      "keyAlias must belong to the Workspace",
    ),
}).strict();

/** Removes a Workspace's virtual key from the Worker; idempotent. */
export const WorkspaceModelKeyClearMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("workspace.model_key.clear"),
  payload: WorkspaceCommandPayloadSchema,
}).strict();

/** Changes a Workspace's data-project limit in place; no restart (Phase 15.7). */
export const WorkspaceStorageSetMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("workspace.storage.set"),
  payload: z
    .object({
      workspaceId: WorkspaceIdSchema,
      diskLimitBytes: DiskLimitBytesSchema,
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
    /** Only on `workspace.ensure`. */
    modelConfig: ModelConfigResultSchema.optional(),
  })
  .strict();

const WorkspaceModelKeyResponseOkPayloadSchema = z
  .object({
    requestType: z.enum(["workspace.model_key.set", "workspace.model_key.clear"]),
    modelKey: z
      .object({ workspaceId: WorkspaceIdSchema, keyAlias: ModelKeyAliasSchema.nullable() })
      .strict(),
  })
  .strict();

const WorkerReconcileResponseOkPayloadSchema = z
  .object({
    requestType: z.literal("worker.reconcile"),
    reconciliation: WorkerReconciliationReportSchema,
  })
  .strict();

const WorkspaceStorageSetResponseOkPayloadSchema = z
  .object({
    requestType: z.literal("workspace.storage.set"),
    storage: z
      .object({
        workspaceId: WorkspaceIdSchema,
        dataLimitBytes: ByteCountSchema,
        dataUsedBytes: ByteCountSchema,
      })
      .strict(),
  })
  .strict();

const WorkerEgressApplyResponseOkPayloadSchema = z
  .object({
    requestType: z.literal("worker.egress.apply"),
    egress: WorkerEgressStatusSchema,
  })
  .strict();

export const ResponseOkMessageSchema = RequestEnvelopeSchema.extend({
  type: z.literal("response.ok"),
  payload: z.union([
    WorkspaceResponseOkPayloadSchema,
    WorkerReconcileResponseOkPayloadSchema,
    WorkerEgressApplyResponseOkPayloadSchema,
    WorkspaceStorageSetResponseOkPayloadSchema,
    WorkspaceModelKeyResponseOkPayloadSchema,
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
  WorkerEgressApplyMessageSchema,
  WorkspaceEnsureMessageSchema,
  WorkspaceStartMessageSchema,
  WorkspaceStopMessageSchema,
  WorkspaceDeleteMessageSchema,
  WorkspaceInspectMessageSchema,
  WorkspaceStorageSetMessageSchema,
  WorkspaceModelKeySetMessageSchema,
  WorkspaceModelKeyClearMessageSchema,
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
export type WorkerStorageStatus = z.infer<typeof WorkerStorageStatusSchema>;
export type WorkspaceDiskUsage = z.infer<typeof WorkspaceDiskUsageSchema>;
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
export type WorkerModelKeyHolding = z.infer<typeof WorkerModelKeyHoldingSchema>;
