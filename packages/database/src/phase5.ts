import type {
  Architecture,
  WorkerCapabilities,
  WorkspaceState,
} from "@agent-runtime/protocol";

import type { DatabaseClient } from "./index.js";
import { createPhase4Repository } from "./phase4.js";
import type { WorkspaceRecord } from "./phase1.js";
import type { WorkerRecord, WorkerStatus } from "./phase2.js";

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
  runtimeImage: string | null;
  runtimeVersion: string | null;
  capabilities: Partial<WorkerCapabilities>;
  maxWorkspaces: number | null;
  assignedWorkspaces: number;
  lastHeartbeatAt: Date | null;
}

export interface WorkerPlacementRecord extends WorkerRecord {
  assignedWorkspaces: number;
}

export interface WorkerSelectionInput {
  workspace: WorkspaceSchedulingRequirements;
  candidates: WorkerScheduleCandidate[];
  connectedWorkerIds: readonly string[];
  heartbeatCutoff: Date;
}

export type WorkerSelector = (
  input: WorkerSelectionInput,
) => WorkerScheduleCandidate | null;

export type ScheduleWorkspaceStartResult =
  | { outcome: "STARTING"; workspace: WorkspaceRecord; sticky: boolean }
  | { outcome: "NO_ELIGIBLE_WORKER" }
  | { outcome: "WORKSPACE_CHANGED" };

interface SchedulingWorkspaceRow {
  id: string;
  user_id: string;
  name: string;
  worker_id: string | null;
  state: WorkspaceState;
  runtime_image: string;
  required_architecture: Architecture | null;
  required_capabilities: Partial<WorkerCapabilities>;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
}

interface CandidateRow {
  id: string;
  architecture: Architecture | null;
  status: WorkerStatus;
  enabled: boolean;
  runtime_image: string | null;
  runtime_version: string | null;
  capabilities: Partial<WorkerCapabilities>;
  max_workspaces: number | null;
  assigned_workspaces: number;
  last_heartbeat_at: Date | null;
}

function mapWorkspace(row: SchedulingWorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    workerId: row.worker_id,
    state: row.state,
    runtimeImage: row.runtime_image,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  };
}

function mapCandidate(row: CandidateRow): WorkerScheduleCandidate {
  return {
    id: row.id,
    architecture: row.architecture,
    status: row.status,
    enabled: row.enabled,
    runtimeImage: row.runtime_image,
    runtimeVersion: row.runtime_version,
    capabilities: row.capabilities,
    maxWorkspaces: row.max_workspaces,
    assignedWorkspaces: row.assigned_workspaces,
    lastHeartbeatAt: row.last_heartbeat_at,
  };
}

export function createPhase5Repository(
  database: DatabaseClient,
  selectWorker: WorkerSelector,
) {
  const phase4 = createPhase4Repository(database);
  return {
    ...phase4,

    async listWorkersWithAssignments(): Promise<WorkerPlacementRecord[]> {
      const [workers, counts] = await Promise.all([
        phase4.listWorkers(),
        database<Array<{ worker_id: string; assigned_workspaces: number }>>`
          select worker_id, count(*)::integer as assigned_workspaces
          from workspaces
          where worker_id is not null
          group by worker_id
        `,
      ]);
      const assignedByWorker = new Map(
        counts.map((row) => [row.worker_id, row.assigned_workspaces]),
      );
      return workers.map((worker) => ({
        ...worker,
        assignedWorkspaces: assignedByWorker.get(worker.id) ?? 0,
      }));
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
            created_at, updated_at, last_activity_at
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
          const rows = await transaction<CandidateRow[]>`
            select
              workers.id,
              workers.architecture,
              workers.status,
              workers.enabled,
              workers.runtime_image,
              workers.runtime_version,
              workers.capabilities,
              workers.max_workspaces,
              count(assigned.id)::integer as assigned_workspaces,
              workers.last_heartbeat_at
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
            created_at, updated_at, last_activity_at
        `;
        const starting = updated[0];
        return starting === undefined
          ? { outcome: "WORKSPACE_CHANGED" }
          : { outcome: "STARTING", workspace: mapWorkspace(starting), sticky };
      });
    },
  };
}

export type Phase5Repository = ReturnType<typeof createPhase5Repository>;
