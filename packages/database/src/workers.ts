import type {
  Architecture,
  ModelRelayStatus,
  RuntimeImageReport,
  WorkerCapabilities,
  WorkerEgressStatus,
  WorkerStorageStatus,
  WorkerSystemResources,
  WorkspaceDiskUsage,
} from "@agent-runtime/protocol";

import { createEgressRepository } from "./egress.js";
import type { DatabaseClient } from "./index.js";
import { createStorageRepository } from "./storage.js";

export type WorkerStatus = "REGISTERED" | "ONLINE" | "OFFLINE" | "DISABLED";

/** One Runtime image a Worker offers, as its last hello reported it (Phase 18.4). */
export interface WorkerRuntimeImage {
  image: string;
  /** Null only for rows migrated from before Phase 18. */
  imageId: string | null;
  runtimeVersion: string;
  piWebVersion: string | null;
  piVersion: string | null;
  capabilities: WorkerCapabilities;
}

export interface WorkerRecord {
  id: string;
  hostname: string | null;
  architecture: Architecture | null;
  status: WorkerStatus;
  enabled: boolean;
  /** Admin scheduling pause; false excludes the Worker from new placements only. */
  schedulable: boolean;
  runtimeImage: string | null;
  runtimeVersion: string | null;
  capabilities: Partial<WorkerCapabilities>;
  /** Every image the Worker offers; the three fields above repeat the first one. */
  runtimeImages: WorkerRuntimeImage[];
  /** The software version from the Worker's last hello (protocol v7); null before. */
  workerVersion: string | null;
  maxWorkspaces: number | null;
  allocatedWorkspaces: number;
  systemResources: {
    logicalCpuCount: number | null;
    memoryBytes: number | null;
  };
  lastHeartbeatAt: Date | null;
  /** Last reported egress rule state (specs.md Phase 14). */
  egress: {
    enforced: boolean;
    revision: number | null;
    checkedAt: Date | null;
  };
  /** Last reported quota filesystem state (specs.md Phase 15). */
  storage: WorkerStorageStatus & { checkedAt: Date | null };
  /** Last reported model relay state (specs.md Phase 16). */
  modelRelay: ModelRelayStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkerIdentity {
  workerId: string;
  enabled: boolean;
}

interface WorkerRow {
  id: string;
  hostname: string | null;
  architecture: Architecture | null;
  status: WorkerStatus;
  enabled: boolean;
  schedulable: boolean;
  runtime_image: string | null;
  runtime_version: string | null;
  capabilities: Partial<WorkerCapabilities>;
  runtime_images: WorkerRuntimeImage[];
  worker_version: string | null;
  max_workspaces: number | null;
  allocated_workspaces: number;
  cpu_capacity: { logicalCpuCount?: number };
  memory_bytes: string | null;
  last_heartbeat_at: Date | null;
  egress_enforced: boolean;
  egress_revision: string | null;
  egress_checked_at: Date | null;
  storage_enforced: boolean;
  storage_fs_type: string | null;
  storage_total_bytes: string | null;
  storage_free_bytes: string | null;
  storage_checked_at: Date | null;
  model_relay_enabled: boolean;
  model_relay_port: number | null;
  model_relay_listening: boolean;
  created_at: Date;
  updated_at: Date;
}

function mapWorker(row: WorkerRow): WorkerRecord {
  return {
    id: row.id,
    hostname: row.hostname,
    architecture: row.architecture,
    status: row.status,
    enabled: row.enabled,
    schedulable: row.schedulable,
    runtimeImage: row.runtime_image,
    runtimeVersion: row.runtime_version,
    capabilities: row.capabilities,
    runtimeImages: row.runtime_images,
    workerVersion: row.worker_version,
    maxWorkspaces: row.max_workspaces,
    allocatedWorkspaces: row.allocated_workspaces,
    systemResources: {
      logicalCpuCount: row.cpu_capacity.logicalCpuCount ?? null,
      memoryBytes:
        row.memory_bytes === null ? null : Number.parseInt(row.memory_bytes, 10),
    },
    lastHeartbeatAt: row.last_heartbeat_at,
    egress: {
      enforced: row.egress_enforced,
      revision: row.egress_revision === null ? null : Number(row.egress_revision),
      checkedAt: row.egress_checked_at,
    },
    storage: {
      enforced: row.storage_enforced,
      fsType: row.storage_fs_type,
      totalBytes: row.storage_total_bytes === null ? null : Number(row.storage_total_bytes),
      freeBytes: row.storage_free_bytes === null ? null : Number(row.storage_free_bytes),
      checkedAt: row.storage_checked_at,
    },
    modelRelay: {
      enabled: row.model_relay_enabled,
      port: row.model_relay_port,
      listening: row.model_relay_listening,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type WorkerDisableResult =
  | { outcome: "DISABLED"; workspaces: number; modelKeys: number }
  | { outcome: "NOT_FOUND" }
  | { outcome: "ALREADY_DISABLED" };

export type WorkerDeleteResult =
  | { outcome: "DELETED" }
  | { outcome: "NOT_FOUND" }
  | { outcome: "ENABLED" }
  | { outcome: "HAS_WORKSPACES"; workspaces: number };

export interface RevokedWorkerAssignment {
  workerId: string;
  workspaceIds: string[];
}

export interface WorkerGatewayRoute {
  workerId: string;
  gatewayBaseUrl: string;
}

export function createWorkerRepository(database: DatabaseClient) {
  const egress = createEgressRepository(database);
  const storage = createStorageRepository(database);
  return {
    async rotateWorkerCredential(input: {
      workerId: string;
      credentialHash: string;
    }): Promise<boolean> {
      return database.begin(async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
          update workers
          set
            credential_hash = ${input.credentialHash},
            status = case when enabled then 'OFFLINE' else 'DISABLED' end,
            last_heartbeat_at = null,
            updated_at = now()
          where id = ${input.workerId}
          returning id
        `;
        if (rows.length !== 1) return false;
        // The old credential no longer reaches this Worker; nothing it reported holds.
        await transaction`
          update workspaces
          set state = 'WORKER_OFFLINE', updated_at = now()
          where worker_id = ${input.workerId}
            and state in ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR', 'UPGRADING')
        `;
        return true;
      });
    },

    /**
     * Revokes a Worker (specs.md Phase 18.6). Migration 0013's triggers do the rest in the
     * same transaction: DISABLED, Workspaces WORKER_OFFLINE, model keys revoking, Audit.
     */
    async disableWorker(workerId: string): Promise<WorkerDisableResult> {
      return database.begin(async (transaction) => {
        await transaction`select set_config('agent_runtime.audit_source', 'cli', true)`;
        const current = await transaction<Array<{ enabled: boolean }>>`
          select enabled from workers where id = ${workerId} for update
        `;
        if (current[0] === undefined) return { outcome: "NOT_FOUND" };
        if (!current[0].enabled) return { outcome: "ALREADY_DISABLED" };
        await transaction`
          update workers set enabled = false, updated_at = now() where id = ${workerId}
        `;
        const audit = await transaction<Array<{ details: { workspaces: number; modelKeys: number } }>>`
          select details from platform_audit_events
          where worker_id = ${workerId} and event_type = 'worker.disabled'
          order by id desc
          limit 1
        `;
        return {
          outcome: "DISABLED",
          workspaces: audit[0]?.details.workspaces ?? 0,
          modelKeys: audit[0]?.details.modelKeys ?? 0,
        };
      });
    },

    /** Re-enables a revoked Worker under a new credential only (Phase 18.6, Q7). */
    async enableWorker(input: {
      workerId: string;
      credentialHash: string;
    }): Promise<"ENABLED" | "NOT_FOUND" | "ALREADY_ENABLED"> {
      return database.begin(async (transaction) => {
        await transaction`select set_config('agent_runtime.audit_source', 'cli', true)`;
        const current = await transaction<Array<{ enabled: boolean }>>`
          select enabled from workers where id = ${input.workerId} for update
        `;
        if (current[0] === undefined) return "NOT_FOUND";
        if (current[0].enabled) return "ALREADY_ENABLED";
        await transaction`
          update workers
          set
            enabled = true,
            credential_hash = ${input.credentialHash},
            last_heartbeat_at = null,
            updated_at = now()
          where id = ${input.workerId}
        `;
        return "ENABLED";
      });
    },

    /** Deletes a revoked Worker that no Workspace is assigned to (Phase 18.6, Q8). */
    async deleteWorker(workerId: string): Promise<WorkerDeleteResult> {
      return database.begin(async (transaction) => {
        await transaction`select set_config('agent_runtime.audit_source', 'cli', true)`;
        const current = await transaction<Array<{ enabled: boolean }>>`
          select enabled from workers where id = ${workerId} for update
        `;
        if (current[0] === undefined) return { outcome: "NOT_FOUND" };
        if (current[0].enabled) return { outcome: "ENABLED" };
        const assigned = await transaction<Array<{ count: string }>>`
          select count(*)::text as count from workspaces where worker_id = ${workerId}
        `;
        const workspaces = Number(assigned[0]?.count ?? 0);
        if (workspaces > 0) return { outcome: "HAS_WORKSPACES", workspaces };
        await transaction`delete from workers where id = ${workerId}`;
        return { outcome: "DELETED" };
      });
    },

    /** The Runtime images each Worker last reported, for Workspace Runtime info (18.4). */
    async listWorkerRuntimeImages(): Promise<Map<string, WorkerRuntimeImage[]>> {
      const rows = await database<Array<{ id: string; runtime_images: WorkerRuntimeImage[] }>>`
        select id, runtime_images from workers
      `;
      return new Map(rows.map((row) => [row.id, row.runtime_images]));
    },

    /** Revoked Workers and their Workspaces, for closing what is still connected. */
    async listRevokedWorkerAssignments(): Promise<RevokedWorkerAssignment[]> {
      const rows = await database<Array<{ id: string; workspace_ids: string[] }>>`
        select
          workers.id,
          coalesce(
            array_agg(workspaces.id) filter (where workspaces.id is not null),
            '{}'
          ) as workspace_ids
        from workers
        left join workspaces on workspaces.worker_id = workers.id
        where not workers.enabled
        group by workers.id
        order by workers.id
      `;
      return rows.map((row) => ({ workerId: row.id, workspaceIds: row.workspace_ids }));
    },

    async findWorkerByCredentialHash(
      credentialHash: string,
    ): Promise<WorkerIdentity | null> {
      const rows = await database<Array<{ id: string; enabled: boolean }>>`
        select id, enabled
        from workers
        where credential_hash = ${credentialHash}
        limit 1
      `;
      const row = rows[0];
      return row === undefined
        ? null
        : { workerId: row.id, enabled: row.enabled };
    },

    async recordWorkerHello(input: {
      credentialHash: string;
      workerId: string;
      workerVersion: string;
      hostname: string;
      architecture: Architecture;
      runtimeImages: RuntimeImageReport[];
      maxWorkspaces: number;
      allocatedWorkspaces: number;
      systemResources: WorkerSystemResources;
      egress: WorkerEgressStatus;
      storage: WorkerStorageStatus;
      modelRelay: ModelRelayStatus;
      receivedAt: Date;
    }): Promise<boolean> {
      const [first] = input.runtimeImages;
      if (first === undefined) throw new Error("A Worker hello reports at least one Runtime image");
      const capabilities = database.json(first.capabilities);
      const runtimeImages = database.json(input.runtimeImages);
      const cpuCapacity = database.json({
        logicalCpuCount: input.systemResources.logicalCpuCount,
      });
      return database.begin(async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
          update workers
          set
            hostname = ${input.hostname},
            architecture = ${input.architecture},
            status = 'ONLINE',
            runtime_image = ${first.image},
            runtime_version = ${first.runtimeVersion},
            capabilities = ${capabilities},
            runtime_images = ${runtimeImages},
            worker_version = ${input.workerVersion},
            max_workspaces = ${input.maxWorkspaces},
            allocated_workspaces = ${input.allocatedWorkspaces},
            cpu_capacity = ${cpuCapacity},
            memory_bytes = ${input.systemResources.memoryBytes},
            model_relay_enabled = ${input.modelRelay.enabled},
            model_relay_port = ${input.modelRelay.port},
            model_relay_listening = ${input.modelRelay.listening},
            last_heartbeat_at = ${input.receivedAt},
            updated_at = ${input.receivedAt}
          where id = ${input.workerId}
            and credential_hash = ${input.credentialHash}
            and enabled
          returning id
        `;
        if (rows.length !== 1) return false;
        await egress.recordWorkerEgressInTransaction(transaction, input);
        await storage.recordWorkerStorageInTransaction(transaction, input);
        return true;
      });
    },

    /**
     * Returns null when the Worker is not (or no longer) allowed to report; otherwise the
     * number of disk samples ignored because they named Workspaces assigned elsewhere.
     */
    async recordWorkerHeartbeat(input: {
      credentialHash: string;
      workerId: string;
      allocatedWorkspaces: number;
      egress: WorkerEgressStatus;
      storage: WorkerStorageStatus;
      modelRelay: ModelRelayStatus;
      workspaceDisk: readonly WorkspaceDiskUsage[];
      receivedAt: Date;
    }): Promise<{ ignoredDiskSamples: number } | null> {
      return database.begin(async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
          update workers
          set
            status = 'ONLINE',
            allocated_workspaces = ${input.allocatedWorkspaces},
            model_relay_enabled = ${input.modelRelay.enabled},
            model_relay_port = ${input.modelRelay.port},
            model_relay_listening = ${input.modelRelay.listening},
            last_heartbeat_at = ${input.receivedAt},
            updated_at = ${input.receivedAt}
          where id = ${input.workerId}
            and credential_hash = ${input.credentialHash}
            and enabled
          returning id
        `;
        if (rows.length !== 1) return null;
        await egress.recordWorkerEgressInTransaction(transaction, input);
        await storage.recordWorkerStorageInTransaction(transaction, input);
        const ignoredDiskSamples = await storage.recordWorkspaceDiskUsageInTransaction(
          transaction,
          { workerId: input.workerId, usage: input.workspaceDisk, receivedAt: input.receivedAt },
        );
        return { ignoredDiskSamples };
      });
    },

    async listWorkers(): Promise<WorkerRecord[]> {
      const rows = await database<WorkerRow[]>`
        select
          id, hostname, architecture, status, enabled, schedulable, runtime_image,
          runtime_version, capabilities, runtime_images, worker_version, max_workspaces,
          allocated_workspaces, cpu_capacity, memory_bytes,
          last_heartbeat_at, egress_enforced, egress_revision::text,
          egress_checked_at, storage_enforced, storage_fs_type,
          storage_total_bytes::text as storage_total_bytes,
          storage_free_bytes::text as storage_free_bytes, storage_checked_at,
          model_relay_enabled, model_relay_port, model_relay_listening,
          created_at, updated_at
        from workers
        order by id asc
      `;
      return rows.map(mapWorker);
    },

    async markWorkersOffline(cutoff: Date): Promise<number> {
      return database.begin(async (transaction) => {
          const offlineWorkers = await transaction<{ id: string }[]>`
            update workers
            set status = 'OFFLINE', updated_at = now()
            where enabled
              and status = 'ONLINE'
              and (last_heartbeat_at is null or last_heartbeat_at <= ${cutoff})
            returning id
          `;
          for (const worker of offlineWorkers) {
            await transaction`
              update workspaces
              set state = 'WORKER_OFFLINE', updated_at = now()
              where worker_id = ${worker.id}
                and state in ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR', 'UPGRADING')
            `;
          }
          return offlineWorkers.length;
      });
    },

    async provisionWorkerWithGateway(input: {
      workerId: string;
      credentialHash: string;
      gatewayBaseUrl: string;
    }): Promise<void> {
      await database`
        insert into workers (id, credential_hash, gateway_base_url)
        values (
          ${input.workerId},
          ${input.credentialHash},
          ${input.gatewayBaseUrl}
        )
      `;
    },

    async configureWorkerGateway(input: {
      workerId: string;
      gatewayBaseUrl: string;
    }): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        update workers
        set gateway_base_url = ${input.gatewayBaseUrl}, updated_at = now()
        where id = ${input.workerId}
        returning id
      `;
      return rows.length === 1;
    },

    async findWorkerGatewayRoute(input: {
      workerId: string;
      heartbeatCutoff: Date;
    }): Promise<WorkerGatewayRoute | null> {
      const rows = await database<
        Array<{ id: string; gateway_base_url: string }>
      >`
        select id, gateway_base_url
        from workers
        where id = ${input.workerId}
          and enabled
          and status = 'ONLINE'
          and last_heartbeat_at > ${input.heartbeatCutoff}
          and gateway_base_url is not null
        limit 1
      `;
      const row = rows[0];
      return row === undefined
        ? null
        : { workerId: row.id, gatewayBaseUrl: row.gateway_base_url };
    },
  };
}
