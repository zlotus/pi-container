import type {
  Architecture,
  WorkerCapabilities,
} from "@agent-runtime/protocol";

import type { DatabaseClient } from "./index.js";
import { createWorkerRepository } from "./workers.js";
import { mapWorkspace, type WorkspaceRecord, type WorkspaceRow } from "./records.js";
import type { WorkerRecord, WorkerRuntimeImage, WorkerStatus } from "./workers.js";

const SCHEDULER_ADVISORY_LOCK_ID = 708_913_425;

export interface WorkspaceSchedulingRequirements {
  runtimeImage: string;
  requiredArchitecture: Architecture | null;
  requiredCapabilities: Partial<WorkerCapabilities>;
}

export interface WorkerScheduleCandidate {
  id: string;
  architecture: Architecture | null;
  status: WorkerStatus;
  enabled: boolean;
  schedulable: boolean;
  /** The images the Worker offers, each with its own capabilities (Phase 18.4). */
  runtimeImages: WorkerRuntimeImage[];
  maxWorkspaces: number | null;
  assignedWorkspaces: number;
  lastHeartbeatAt: Date | null;
  egressEnforced: boolean;
  egressRevision: number | null;
  /** Whether the Worker last reported enforced disk quotas (specs.md Phase 15.6). */
  storageEnforced: boolean;
}

export interface WorkerPlacementRecord extends WorkerRecord {
  assignedWorkspaces: number;
  /** Assigned Workspaces per Runtime image, to tell when an image can be retired (18.4). */
  workspacesByImage: Record<string, number>;
  /** Sum of the disk limits of every Workspace assigned here (may exceed capacity). */
  allocatedDiskLimitBytes: number;
}

export interface WorkerSelectionInput {
  workspace: WorkspaceSchedulingRequirements;
  candidates: WorkerScheduleCandidate[];
  connectedWorkerIds: readonly string[];
  heartbeatCutoff: Date;
  /** Current egress policy revision; only Workers enforcing it are eligible. */
  egressRevision: number;
}

export type WorkerSelector = (
  input: WorkerSelectionInput,
) => WorkerScheduleCandidate | null;

export type SetWorkerSchedulableResult =
  | { outcome: "UPDATED"; worker: WorkerPlacementRecord }
  | { outcome: "NOT_FOUND" };

export interface WorkerSchedulingAuditMetadata {
  actorUserId: string;
  requestId: string;
  ipAddress: string;
  userAgent: string | null;
}

export type ScheduleWorkspaceStartResult =
  | { outcome: "STARTING"; workspace: WorkspaceRecord; sticky: boolean }
  | { outcome: "NO_ELIGIBLE_WORKER" }
  | { outcome: "WORKSPACE_CHANGED" };

type SchedulingWorkspaceRow = WorkspaceRow & {
  required_architecture: Architecture | null;
  required_capabilities: Partial<WorkerCapabilities>;
};

interface CandidateRow {
  id: string;
  architecture: Architecture | null;
  status: WorkerStatus;
  enabled: boolean;
  schedulable: boolean;
  runtime_images: WorkerRuntimeImage[];
  max_workspaces: number | null;
  assigned_workspaces: number;
  last_heartbeat_at: Date | null;
  egress_enforced: boolean;
  egress_revision: string | null;
  storage_enforced: boolean;
}

function mapCandidate(row: CandidateRow): WorkerScheduleCandidate {
  return {
    id: row.id,
    architecture: row.architecture,
    status: row.status,
    enabled: row.enabled,
    schedulable: row.schedulable,
    runtimeImages: row.runtime_images,
    maxWorkspaces: row.max_workspaces,
    assignedWorkspaces: row.assigned_workspaces,
    lastHeartbeatAt: row.last_heartbeat_at,
    egressEnforced: row.egress_enforced,
    egressRevision: row.egress_revision === null ? null : Number(row.egress_revision),
    storageEnforced: row.storage_enforced,
  };
}

export function createSchedulingRepository(
  database: DatabaseClient,
  selectWorker: WorkerSelector,
) {
  const workerRepository = createWorkerRepository(database);

  async function listWorkersWithAssignments(): Promise<WorkerPlacementRecord[]> {
    const [workers, counts, byImage] = await Promise.all([
      workerRepository.listWorkers(),
      database<
        Array<{ worker_id: string; assigned_workspaces: number; disk_limit_bytes: string }>
      >`
        select
          worker_id, count(*)::integer as assigned_workspaces,
          sum(disk_limit_bytes)::text as disk_limit_bytes
        from workspaces
        where worker_id is not null
        group by worker_id
      `,
      database<Array<{ worker_id: string; runtime_image: string; workspaces: number }>>`
        select worker_id, runtime_image, count(*)::integer as workspaces
        from workspaces
        where worker_id is not null
        group by worker_id, runtime_image
      `,
    ]);
    const assignedByWorker = new Map(counts.map((row) => [row.worker_id, row]));
    const imagesByWorker = new Map<string, Record<string, number>>();
    for (const row of byImage) {
      const images = imagesByWorker.get(row.worker_id) ?? {};
      images[row.runtime_image] = row.workspaces;
      imagesByWorker.set(row.worker_id, images);
    }
    return workers.map((worker) => ({
      ...worker,
      assignedWorkspaces: assignedByWorker.get(worker.id)?.assigned_workspaces ?? 0,
      workspacesByImage: imagesByWorker.get(worker.id) ?? {},
      allocatedDiskLimitBytes: Number(assignedByWorker.get(worker.id)?.disk_limit_bytes ?? 0),
    }));
  }

  return {
    listWorkersWithAssignments,

    async setWorkerSchedulable(input: {
      workerId: string;
      schedulable: boolean;
      audit: WorkerSchedulingAuditMetadata;
    }): Promise<SetWorkerSchedulableResult> {
      const changed = await database.begin(async (transaction) => {
        // Share the placement lock so a pause cannot interleave with an
        // in-flight first placement that already read this Worker as eligible.
        await transaction`select pg_advisory_xact_lock(${SCHEDULER_ADVISORY_LOCK_ID})`;
        const rows = await transaction<Array<{ schedulable: boolean }>>`
          select schedulable from workers where id = ${input.workerId} for update
        `;
        const current = rows[0];
        if (current === undefined) return null;
        if (current.schedulable === input.schedulable) return false;
        await transaction`
          update workers
          set schedulable = ${input.schedulable}, updated_at = now()
          where id = ${input.workerId}
        `;
        const { actorUserId, ...request } = input.audit;
        await transaction`
          insert into platform_audit_events (
            event_type, actor_user_id, worker_id, details
          ) values (
            ${input.schedulable ? "worker.scheduling_resumed" : "worker.scheduling_paused"},
            ${actorUserId},
            ${input.workerId},
            ${transaction.json(request)}
          )
        `;
        return true;
      });
      if (changed === null) return { outcome: "NOT_FOUND" };
      const workers = await listWorkersWithAssignments();
      const worker = workers.find((candidate) => candidate.id === input.workerId);
      return worker === undefined
        ? { outcome: "NOT_FOUND" }
        : { outcome: "UPDATED", worker };
    },

    async scheduleWorkspaceStart(input: {
      workspaceId: string;
      userId: string;
      heartbeatCutoff: Date;
      connectedWorkerIds: readonly string[];
    }): Promise<ScheduleWorkspaceStartResult> {
      return database.begin(async (transaction) => {
        // Control Plane assignments are the capacity authority. Serializing the
        // short placement transaction makes the count plus assignment one
        // atomic reservation, independent of delayed Worker heartbeats.
        await transaction`select pg_advisory_xact_lock(${SCHEDULER_ADVISORY_LOCK_ID})`;

        const workspaces = await transaction<SchedulingWorkspaceRow[]>`
          select
            id, user_id, name, worker_id, state, runtime_image,
            required_architecture, required_capabilities,
            created_at, updated_at, last_activity_at,
            disk_limit_bytes::text as disk_limit_bytes, disk_used_bytes::text as disk_used_bytes,
            disk_used_inodes::text as disk_used_inodes, pi_used_bytes::text as pi_used_bytes,
            pi_limit_bytes::text as pi_limit_bytes, disk_usage_at,
          previous_runtime_image, runtime_changed_at, last_access_at, last_stop_reason
          from workspaces
          where id = ${input.workspaceId} and user_id = ${input.userId}
          for update
        `;
        const workspace = workspaces[0];
        if (
          workspace === undefined ||
          !["CREATED", "STOPPED", "ERROR", "WORKER_OFFLINE"].includes(
            workspace.state,
          )
        ) {
          return { outcome: "WORKSPACE_CHANGED" };
        }

        let workerId = workspace.worker_id;
        const sticky = workerId !== null;
        if (workerId === null) {
          const policy = await transaction<Array<{ revision: string }>>`
            select revision::text from egress_policy_state where id
          `;
          const rows = await transaction<CandidateRow[]>`
            select
              workers.id,
              workers.architecture,
              workers.status,
              workers.enabled,
              workers.schedulable,
              workers.runtime_images,
              workers.max_workspaces,
              count(assigned.id)::integer as assigned_workspaces,
              workers.last_heartbeat_at,
              workers.egress_enforced,
              workers.egress_revision::text as egress_revision,
              workers.storage_enforced
            from workers
            left join workspaces assigned on assigned.worker_id = workers.id
            group by workers.id
            order by workers.id asc
          `;
          const selected = selectWorker({
            workspace: {
              runtimeImage: workspace.runtime_image,
              requiredArchitecture: workspace.required_architecture,
              requiredCapabilities: workspace.required_capabilities,
            },
            candidates: rows.map(mapCandidate),
            connectedWorkerIds: input.connectedWorkerIds,
            heartbeatCutoff: input.heartbeatCutoff,
            egressRevision: Number(policy[0]?.revision ?? 0),
          });
          if (selected === null) return { outcome: "NO_ELIGIBLE_WORKER" };
          workerId = selected.id;
        }

        const updated = await transaction<SchedulingWorkspaceRow[]>`
          update workspaces
          set
            worker_id = ${workerId},
            state = 'STARTING',
            desired_state = 'RUNNING',
            updated_at = now(),
            last_activity_at = now()
          where id = ${workspace.id}
            and user_id = ${workspace.user_id}
            and (worker_id is null or worker_id = ${workerId})
            and state in ('CREATED', 'STOPPED', 'ERROR', 'WORKER_OFFLINE')
          returning
            id, user_id, name, worker_id, state, runtime_image,
            required_architecture, required_capabilities,
            created_at, updated_at, last_activity_at,
            disk_limit_bytes::text as disk_limit_bytes, disk_used_bytes::text as disk_used_bytes,
            disk_used_inodes::text as disk_used_inodes, pi_used_bytes::text as pi_used_bytes,
            pi_limit_bytes::text as pi_limit_bytes, disk_usage_at,
          previous_runtime_image, runtime_changed_at, last_access_at, last_stop_reason
        `;
        const starting = updated[0];
        return starting === undefined
          ? { outcome: "WORKSPACE_CHANGED" }
          : { outcome: "STARTING", workspace: mapWorkspace(starting), sticky };
      });
    },
  };
}
