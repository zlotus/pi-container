import type {
  Architecture,
  WorkerCapabilities,
  WorkerSystemResources,
} from "@agent-runtime/protocol";

import type { DatabaseClient } from "./index.js";
import { createPhase1Repository } from "./phase1.js";

export type WorkerStatus = "REGISTERED" | "ONLINE" | "OFFLINE" | "DISABLED";

export interface WorkerRecord {
  id: string;
  hostname: string | null;
  architecture: Architecture | null;
  status: WorkerStatus;
  enabled: boolean;
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
  runtime_image: string | null;
  runtime_version: string | null;
  capabilities: Partial<WorkerCapabilities>;
  max_workspaces: number | null;
  allocated_workspaces: number;
  cpu_capacity: { logicalCpuCount?: number };
  memory_bytes: string | null;
  last_heartbeat_at: Date | null;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPhase2Repository(database: DatabaseClient) {
  return {
    ...createPhase1Repository(database),

    async provisionWorker(input: {
      workerId: string;
      credentialHash: string;
    }): Promise<void> {
      await database`
        insert into workers (id, credential_hash)
        values (${input.workerId}, ${input.credentialHash})
      `;
    },

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
      receivedAt: Date;
    }): Promise<boolean> {
      const capabilities = database.json(input.capabilities);
      const cpuCapacity = database.json({
        logicalCpuCount: input.systemResources.logicalCpuCount,
      });
      const rows = await database<{ id: string }[]>`
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
          last_heartbeat_at = ${input.receivedAt},
          updated_at = ${input.receivedAt}
        where id = ${input.workerId}
          and credential_hash = ${input.credentialHash}
          and enabled
        returning id
      `;
      return rows.length === 1;
    },

    async recordWorkerHeartbeat(input: {
      credentialHash: string;
      workerId: string;
      allocatedWorkspaces: number;
      receivedAt: Date;
    }): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        update workers
        set
          status = 'ONLINE',
          allocated_workspaces = ${input.allocatedWorkspaces},
          last_heartbeat_at = ${input.receivedAt},
          updated_at = ${input.receivedAt}
        where id = ${input.workerId}
          and credential_hash = ${input.credentialHash}
          and enabled
        returning id
      `;
      return rows.length === 1;
    },

    async markWorkersOffline(cutoff: Date): Promise<number> {
      const rows = await database<{ id: string }[]>`
        update workers
        set status = 'OFFLINE', updated_at = now()
        where enabled
          and status = 'ONLINE'
          and (last_heartbeat_at is null or last_heartbeat_at <= ${cutoff})
        returning id
      `;
      return rows.length;
    },

    async listWorkers(): Promise<WorkerRecord[]> {
      const rows = await database<WorkerRow[]>`
        select
          id, hostname, architecture, status, enabled, runtime_image,
          runtime_version, capabilities, max_workspaces,
          allocated_workspaces, cpu_capacity, memory_bytes,
          last_heartbeat_at, created_at, updated_at
        from workers
        order by id asc
      `;
      return rows.map(mapWorker);
    },
  };
}

export type Phase2Repository = ReturnType<typeof createPhase2Repository>;
