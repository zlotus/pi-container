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
const HOUR = 3_600_000;

describeWithPostgres("Phase 18 idle stop PostgreSQL integration", () => {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = randomUUID();
  const workerId = `idle-${suffix}`;
  const offlineWorkerId = `idle-off-${suffix}`;
  let database!: DatabaseClient;
  let repository!: ReturnType<typeof createRepository>;

  async function runningWorkspace(options: { worker?: string; startedHoursAgo: number; accessedHoursAgo: number | null }) {
    const workspace = await repository.createWorkspace({
      id: randomUUID(),
      userId: ownerId,
      name: `idle-${randomUUID().slice(0, 8)}`,
      runtimeImage: "img",
      diskLimitBytes: 20 * GIB,
    });
    const started = new Date(Date.now() - options.startedHoursAgo * HOUR);
    const accessed = options.accessedHoursAgo === null ? null : new Date(Date.now() - options.accessedHoursAgo * HOUR);
    await database`
      update workspaces
      set worker_id = ${options.worker ?? workerId}, state = 'RUNNING', desired_state = 'RUNNING',
          last_activity_at = ${started}, last_access_at = ${accessed}
      where id = ${workspace.id}
    `;
    return workspace.id;
  }

  async function row(workspaceId: string) {
    const rows = await database<
      Array<{ state: string; desired_state: string; last_stop_reason: string | null; last_access_at: Date | null }>
    >`select state, desired_state, last_stop_reason, last_access_at from workspaces where id = ${workspaceId}`;
    return rows[0];
  }

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: ownerId,
      email: `idle-${ownerId}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-idle-password"),
      role: "user",
    });
    for (const [id, status] of [[workerId, "ONLINE"], [offlineWorkerId, "OFFLINE"]] as const) {
      await repository.provisionWorkerWithGateway({
        workerId: id,
        credentialHash: hashOpaqueToken(`${id}-credential-token`),
        gatewayBaseUrl: "http://127.0.0.1:18084",
      });
      await database`update workers set status = ${status} where id = ${id}`;
    }
  });

  afterAll(async () => {
    await database`delete from workspaces where user_id = ${ownerId}`;
    await database`delete from workers where id in (${workerId}, ${offlineWorkerId})`;
    await database`delete from platform_audit_events where owner_user_id = ${ownerId} or worker_id in (${workerId}, ${offlineWorkerId})`;
    await database`delete from users where id = ${ownerId}`;
    await database.end({ timeout: 5 });
  });

  it("moves the last access forward only", async () => {
    const workspaceId = await runningWorkspace({ startedHoursAgo: 1, accessedHoursAgo: null });
    const later = new Date(Date.now() - 1_000);
    await repository.recordWorkspaceAccess([{ workspaceId, at: later }]);
    await repository.recordWorkspaceAccess([{ workspaceId, at: new Date(later.getTime() - HOUR) }]);
    expect((await row(workspaceId))?.last_access_at).toEqual(later);
  });

  it("lists only long-running, unaccessed Workspaces on online Workers", async () => {
    const cutoff = new Date(Date.now() - 24 * HOUR);
    const idle = await runningWorkspace({ startedHoursAgo: 30, accessedHoursAgo: 26 });
    const neverAccessed = await runningWorkspace({ startedHoursAgo: 30, accessedHoursAgo: null });
    const recentlyAccessed = await runningWorkspace({ startedHoursAgo: 30, accessedHoursAgo: 2 });
    const recentlyStarted = await runningWorkspace({ startedHoursAgo: 3, accessedHoursAgo: null });
    const onOfflineWorker = await runningWorkspace({ worker: offlineWorkerId, startedHoursAgo: 30, accessedHoursAgo: 26 });
    const stopped = await runningWorkspace({ startedHoursAgo: 30, accessedHoursAgo: 26 });
    await database`update workspaces set state = 'STOPPED', desired_state = 'STOPPED' where id = ${stopped}`;

    const ids = (await repository.listIdleStopCandidates({ cutoff, limit: 500 })).map((entry) => entry.workspaceId);
    expect(ids).toEqual(expect.arrayContaining([idle, neverAccessed]));
    for (const excluded of [recentlyAccessed, recentlyStarted, onOfflineWorker, stopped]) {
      expect(ids).not.toContain(excluded);
    }
  });

  it("begins an idle stop with an Audit event, unless an access raced it", async () => {
    const cutoff = new Date(Date.now() - 24 * HOUR);
    const workspaceId = await runningWorkspace({ startedHoursAgo: 30, accessedHoursAgo: 26 });
    const raced = await runningWorkspace({ startedHoursAgo: 30, accessedHoursAgo: 26 });
    await repository.recordWorkspaceAccess([{ workspaceId: raced, at: new Date() }]);
    const begin = (id: string) =>
      repository.beginIdleStop({ workspaceId: id, workerId, cutoff, idleAfterHours: 24, cpuThresholdCores: 0.05 });

    expect(await begin(raced)).toBe(false);
    expect((await row(raced))?.state).toBe("RUNNING");

    expect(await begin(workspaceId)).toBe(true);
    expect(await row(workspaceId)).toMatchObject({ state: "STOPPING", desired_state: "STOPPED", last_stop_reason: "idle" });
    expect(await begin(workspaceId)).toBe(false);
    const audit = await database<Array<{ details: Record<string, unknown> }>>`
      select details from platform_audit_events
      where workspace_id = ${workspaceId} and event_type = 'workspace.idle_stopped'
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ idleAfterHours: 24, cpuThresholdCores: 0.05 });

    // The next start clears the reason.
    expect(await repository.finishWorkspaceStop({ workspaceId, workerId })).toBe(true);
    await database`update workspaces set state = 'STARTING', desired_state = 'RUNNING' where id = ${workspaceId}`;
    expect(await repository.finishWorkspaceStart({ workspaceId, workerId })).toBe(true);
    expect((await row(workspaceId))?.last_stop_reason).toBeNull();
  });
});
