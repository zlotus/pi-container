import { randomUUID } from "node:crypto";

import { hashOpaqueToken, hashPassword } from "@agent-runtime/auth";
import {
  createDatabaseClient,
  createRepository,
  type DatabaseClient,
  migrateDatabase,
} from "@agent-runtime/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { selectWorker } from "./scheduler.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl === undefined ? describe.skip : describe;
const GIB = 1024 ** 3;

describeWithPostgres("Phase 17 metrics snapshot PostgreSQL integration", () => {
  const suffix = randomUUID();
  const ownerId = randomUUID();
  const workerId = `metrics-${suffix}`;
  const otherWorkerId = `metrics-other-${suffix}`;
  let database!: DatabaseClient;
  let repository!: ReturnType<typeof createRepository>;
  const running = randomUUID();
  const stopped = randomUUID();
  const elsewhere = randomUUID();

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: ownerId,
      email: `metrics-${ownerId}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-metrics-password"),
      role: "user",
    });
    for (const id of [workerId, otherWorkerId]) {
      await repository.provisionWorkerWithGateway({
        workerId: id,
        credentialHash: hashOpaqueToken(`${id}-credential-token-0123456789`),
        gatewayBaseUrl: "http://127.0.0.1:18082",
      });
    }
    await database`
      update workers set status = 'ONLINE', last_heartbeat_at = now(), max_workspaces = 8,
        storage_enforced = true, storage_total_bytes = ${1000 * GIB}, storage_free_bytes = ${400 * GIB}
      where id = ${workerId}
    `;
    for (const [id, worker, state] of [
      [running, workerId, "RUNNING"],
      [stopped, workerId, "STOPPED"],
      [elsewhere, otherWorkerId, "RUNNING"],
    ] as const) {
      await repository.createWorkspace({
        id,
        userId: ownerId,
        name: `metrics-${id.slice(0, 8)}`,
        runtimeImage: "img",
        diskLimitBytes: 20 * GIB,
      });
      await database`update workspaces set worker_id = ${worker}, state = ${state} where id = ${id}`;
    }
    await database`
      update workspaces set disk_used_bytes = ${19 * GIB}, disk_used_inodes = 7, pi_used_bytes = 1,
        pi_limit_bytes = ${2 * GIB}, disk_usage_at = now()
      where id = ${running}
    `;
  });

  afterAll(async () => {
    await database`delete from platform_audit_events where owner_user_id = ${ownerId} or worker_id in (${workerId}, ${otherWorkerId})`;
    await database`delete from workspaces where user_id = ${ownerId}`;
    await database`delete from workers where id in (${workerId}, ${otherWorkerId})`;
    await database`delete from users where id = ${ownerId}`;
    await database.end({ timeout: 5 });
  });

  it("reads Worker, Workspace and disk state in one read-only snapshot", async () => {
    const snapshot = await repository.metricsSnapshot();
    expect(snapshot.workers.find((worker) => worker.workerId === workerId)).toMatchObject({
      status: "ONLINE",
      enabled: true,
      maxWorkspaces: 8,
      storageEnforced: true,
      storageTotalBytes: 1000 * GIB,
      storageFreeBytes: 400 * GIB,
      diskLimitAllocatedBytes: 40 * GIB,
    });
    expect(snapshot.workspaces).toEqual(
      expect.arrayContaining([
        { state: "RUNNING", workerId, count: 1 },
        { state: "STOPPED", workerId, count: 1 },
      ]),
    );
    expect(snapshot.workspaceDisk.find((row) => row.workspaceId === running)).toMatchObject({
      userId: ownerId,
      workerId,
      state: "RUNNING",
      dataUsedBytes: 19 * GIB,
      dataLimitBytes: 20 * GIB,
      dataUsedInodes: 7,
      piLimitBytes: 2 * GIB,
    });
    expect(snapshot.workspaceDisk.find((row) => row.workspaceId === stopped)?.sampledAt).toBeNull();
    expect(snapshot.activeSessions).toBeGreaterThanOrEqual(0);
    expect(snapshot.oldestPendingRevocationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("accepts usage only for Workspaces assigned to and running on the reporting Worker", async () => {
    await expect(
      repository.activeAssignedWorkspaceIds(workerId, [running, stopped, elsewhere, randomUUID()]),
    ).resolves.toEqual(new Set([running]));
    await expect(repository.activeAssignedWorkspaceIds(workerId, [])).resolves.toEqual(new Set());
  });

  it("fails fast instead of piling up when a query exceeds the statement timeout", async () => {
    const blocker = createDatabaseClient(databaseUrl ?? "");
    try {
      await blocker.begin(async (transaction) => {
        await transaction`lock table workers in access exclusive mode`;
        await expect(repository.metricsSnapshot(200)).rejects.toThrow();
      });
    } finally {
      await blocker.end({ timeout: 5 });
    }
  });
});
