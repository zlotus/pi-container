import type {
  Architecture,
  ModelRelayStatus,
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
      const rows = await database<{ id: string }[]>`
        update workers
        set
          credential_hash = ${input.credentialHash},
          status = case when enabled then 'OFFLINE' else 'DISABLED' end,
          last_heartbeat_at = null,
          updated_at = now()
        where id = ${input.workerId}
        returning id
      `;
      return rows.length === 1;
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
      hostname: string;
      architecture: Architecture;
      runtimeImage: string;
      runtimeVersion: string;
      capabilities: WorkerCapabilities;
      maxWorkspaces: number;
      allocatedWorkspaces: number;
      systemResources: WorkerSystemResources;
      egress: WorkerEgressStatus;
      storage: WorkerStorageStatus;
      modelRelay: ModelRelayStatus;
      receivedAt: Date;
    }): Promise<boolean> {
      const capabilities = database.json(input.capabilities);
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
            runtime_image = ${input.runtimeImage},
            runtime_version = ${input.runtimeVersion},
            capabilities = ${capabilities},
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
          runtime_version, capabilities, max_workspaces,
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
                and state in ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR')
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
