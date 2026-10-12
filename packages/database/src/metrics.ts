import type { DatabaseClient } from "./index.js";

/** Platform state read once per Prometheus scrape (specs.md Phase 17.4). */
export interface MetricsSnapshot {
  workspaces: Array<{ state: string; workerId: string | null; count: number }>;
  /** Workspaces per Runtime image (Phase 18.8). */
  workspacesByRuntime: Array<{ runtimeImage: string; count: number }>;
  workers: Array<{
    workerId: string;
    /** The images the Worker offers. */
    runtimeImages: Array<{ image: string; runtimeVersion: string }>;
    status: string;
    enabled: boolean;
    schedulable: boolean;
    lastHeartbeatAt: Date | null;
    allocatedWorkspaces: number;
    maxWorkspaces: number | null;
    egressEnforced: boolean;
    storageEnforced: boolean;
    storageTotalBytes: number | null;
    storageFreeBytes: number | null;
    modelRelayEnabled: boolean;
    modelRelayListening: boolean;
    diskLimitAllocatedBytes: number;
  }>;
  workspaceDisk: Array<{
    workspaceId: string;
    userId: string;
    workerId: string | null;
    state: string;
    dataUsedBytes: number | null;
    dataLimitBytes: number;
    dataUsedInodes: number | null;
    piUsedBytes: number | null;
    piLimitBytes: number | null;
    sampledAt: Date | null;
  }>;
  activeSessions: number;
  activeAuthLocks: Array<{ scope: string; count: number }>;
  modelKeys: Array<{ status: string; count: number }>;
  oldestPendingRevocationSeconds: number;
}

function toNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

export function createMetricsRepository(database: DatabaseClient) {
  return {
    /** Which of the reported Workspaces are assigned to the Worker and running (Phase 17.6). */
    async activeAssignedWorkspaceIds(workerId: string, workspaceIds: readonly string[]): Promise<Set<string>> {
      if (workspaceIds.length === 0) return new Set();
      const rows = await database<Array<{ id: string }>>`
        select id from workspaces
        where worker_id = ${workerId}
          and state in ('RUNNING', 'STARTING')
          and id = any(${workspaceIds as string[]}::uuid[])
      `;
      return new Set(rows.map((row) => row.id));
    },

    /**
     * One read-only transaction with a short statement timeout, so a slow database makes the
     * scrape report `collector_up 0` instead of piling up.
     */
    async metricsSnapshot(timeoutMs = 2_000): Promise<MetricsSnapshot> {
      return database.begin("read only", async (transaction) => {
        await transaction.unsafe(`set local statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
        const workspaces = await transaction<Array<{ state: string; worker_id: string | null; count: string }>>`
          select state, worker_id, count(*)::text as count
          from workspaces
          group by state, worker_id
        `;
        const workers = await transaction<
          Array<{
            id: string;
            status: string;
            enabled: boolean;
            schedulable: boolean;
            last_heartbeat_at: Date | null;
            allocated_workspaces: number;
            max_workspaces: number | null;
            egress_enforced: boolean;
            storage_enforced: boolean;
            storage_total_bytes: string | null;
            storage_free_bytes: string | null;
            model_relay_enabled: boolean;
            model_relay_listening: boolean;
            disk_limit_allocated_bytes: string;
            runtime_images: Array<{ image: string; runtimeVersion: string }>;
          }>
        >`
          select
            w.runtime_images,
            w.id, w.status, w.enabled, w.schedulable, w.last_heartbeat_at,
            w.allocated_workspaces, w.max_workspaces, w.egress_enforced, w.storage_enforced,
            w.storage_total_bytes::text as storage_total_bytes,
            w.storage_free_bytes::text as storage_free_bytes,
            w.model_relay_enabled, w.model_relay_listening,
            coalesce((
              select sum(s.disk_limit_bytes) from workspaces s where s.worker_id = w.id
            ), 0)::text as disk_limit_allocated_bytes
          from workers w
          order by w.id
        `;
        const byRuntime = await transaction<Array<{ runtime_image: string; count: string }>>`
          select runtime_image, count(*)::text as count from workspaces group by runtime_image
        `;
        const disk = await transaction<
          Array<{
            id: string;
            user_id: string;
            worker_id: string | null;
            state: string;
            disk_used_bytes: string | null;
            disk_limit_bytes: string;
            disk_used_inodes: string | null;
            pi_used_bytes: string | null;
            pi_limit_bytes: string | null;
            disk_usage_at: Date | null;
          }>
        >`
          select
            id, user_id, worker_id, state,
            disk_used_bytes::text as disk_used_bytes,
            disk_limit_bytes::text as disk_limit_bytes,
            disk_used_inodes::text as disk_used_inodes,
            pi_used_bytes::text as pi_used_bytes,
            pi_limit_bytes::text as pi_limit_bytes,
            disk_usage_at
          from workspaces
          order by id
        `;
        const [sessions] = await transaction<Array<{ count: string }>>`
          select count(*)::text as count
          from user_sessions
          where revoked_at is null and expires_at > now()
        `;
        const locks = await transaction<Array<{ scope: string; count: string }>>`
          select scope, count(*)::text as count
          from auth_throttle
          where locked_until > now()
          group by scope
        `;
        const keys = await transaction<Array<{ status: string; count: string }>>`
          select status, count(*)::text as count from model_keys group by status
        `;
        const [pending] = await transaction<Array<{ seconds: string | null }>>`
          select extract(epoch from (now() - min(revoke_requested_at)))::text as seconds
          from model_keys
          where status = 'revoking'
        `;
        return {
          workspaces: workspaces.map((row) => ({
            state: row.state,
            workerId: row.worker_id,
            count: Number(row.count),
          })),
          workspacesByRuntime: byRuntime.map((row) => ({
            runtimeImage: row.runtime_image,
            count: Number(row.count),
          })),
          workers: workers.map((row) => ({
            workerId: row.id,
            runtimeImages: row.runtime_images.map((image) => ({
              image: image.image,
              runtimeVersion: image.runtimeVersion,
            })),
            status: row.status,
            enabled: row.enabled,
            schedulable: row.schedulable,
            lastHeartbeatAt: row.last_heartbeat_at,
            allocatedWorkspaces: row.allocated_workspaces,
            maxWorkspaces: row.max_workspaces,
            egressEnforced: row.egress_enforced,
            storageEnforced: row.storage_enforced,
            storageTotalBytes: toNumber(row.storage_total_bytes),
            storageFreeBytes: toNumber(row.storage_free_bytes),
            modelRelayEnabled: row.model_relay_enabled,
            modelRelayListening: row.model_relay_listening,
            diskLimitAllocatedBytes: Number(row.disk_limit_allocated_bytes),
          })),
          workspaceDisk: disk.map((row) => ({
            workspaceId: row.id,
            userId: row.user_id,
            workerId: row.worker_id,
            state: row.state,
            dataUsedBytes: toNumber(row.disk_used_bytes),
            dataLimitBytes: Number(row.disk_limit_bytes),
            dataUsedInodes: toNumber(row.disk_used_inodes),
            piUsedBytes: toNumber(row.pi_used_bytes),
            piLimitBytes: toNumber(row.pi_limit_bytes),
            sampledAt: row.disk_usage_at,
          })),
          activeSessions: Number(sessions?.count ?? 0),
          activeAuthLocks: locks.map((row) => ({ scope: row.scope, count: Number(row.count) })),
          modelKeys: keys.map((row) => ({ status: row.status, count: Number(row.count) })),
          oldestPendingRevocationSeconds: Math.max(0, Number(pending?.seconds ?? 0)),
        };
      });
    },
  };
}
