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
const OLD = "agent-runtime:it-old";
const NEW = "agent-runtime:it-new";
const CAPABILITIES = { browser: true, office: true, ffmpeg: true, python: true, node: true, rust: true };

describeWithPostgres("Phase 18 Runtime change PostgreSQL integration", () => {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = randomUUID();
  const workerId = `runtime-${suffix}`;
  const credentialHash = hashOpaqueToken(`${workerId}-credential-token`);
  let database!: DatabaseClient;
  let repository!: ReturnType<typeof createRepository>;

  async function stoppedWorkspace(image = OLD) {
    const workspace = await repository.createWorkspace({
      id: randomUUID(),
      userId: ownerId,
      name: `runtime-${randomUUID().slice(0, 8)}`,
      runtimeImage: image,
      diskLimitBytes: 20 * GIB,
    });
    await database`
      update workspaces set worker_id = ${workerId}, state = 'STOPPED', desired_state = 'STOPPED'
      where id = ${workspace.id}
    `;
    return workspace.id;
  }

  async function row(workspaceId: string) {
    const rows = await database<
      Array<{ state: string; runtime_image: string; previous_runtime_image: string | null; complete: boolean }>
    >`
      select state, runtime_image, previous_runtime_image, runtime_changed_at is not null as complete
      from workspaces where id = ${workspaceId}
    `;
    return rows[0];
  }

  const begin = (workspaceId: string, fromImage: string, toImage: string) =>
    repository.beginWorkspaceRuntimeChange({
      workspaceId,
      workerId,
      fromImage,
      toImage,
      direction: "upgrade",
      actorUserId: ownerId,
    });

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: ownerId,
      email: `runtime-${ownerId}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-runtime-password"),
      role: "user",
    });
    await repository.provisionWorkerWithGateway({
      workerId,
      credentialHash,
      gatewayBaseUrl: "http://127.0.0.1:18083",
    });
  });

  afterAll(async () => {
    await database`delete from workspaces where user_id = ${ownerId}`;
    await database`delete from workers where id = ${workerId}`;
    await database`delete from platform_audit_events where owner_user_id = ${ownerId} or worker_id = ${workerId}`;
    await database`delete from users where id = ${ownerId}`;
    await database.end({ timeout: 5 });
  });

  it("stores every image of a hello and counts Workspaces per image", async () => {
    const image = (name: string, version: string) => ({
      image: name,
      imageId: `sha256:${"a".repeat(64)}`,
      runtimeVersion: version,
      piWebVersion: null,
      piVersion: null,
      capabilities: CAPABILITIES,
    });
    expect(
      await repository.recordWorkerHello({
        credentialHash,
        workerId,
        workerVersion: "1.0.0-test",
        hostname: "runtime.internal",
        architecture: "arm64",
        runtimeImages: [image(OLD, "old"), image(NEW, "new")],
        maxWorkspaces: 8,
        allocatedWorkspaces: 0,
        systemResources: { logicalCpuCount: 8, memoryBytes: 16 * GIB },
        egress: { enforced: true, revision: 0 },
        storage: { enforced: true, fsType: "xfs", totalBytes: 2 ** 40, freeBytes: 2 ** 39 },
        modelRelay: { enabled: false, port: null, listening: false },
        receivedAt: new Date(),
      }),
    ).toBe(true);
    await stoppedWorkspace(OLD);

    expect((await repository.listWorkerRuntimeImages()).get(workerId)?.map((entry) => entry.image)).toEqual([OLD, NEW]);
    const worker = (await repository.listWorkersWithAssignments()).find((entry) => entry.id === workerId);
    expect(worker).toMatchObject({ runtimeImage: OLD, runtimeVersion: "old" });
    expect(worker?.workspacesByImage[OLD]).toBeGreaterThanOrEqual(1);
    const audit = await database<Array<{ details: { runtimeImages: Array<{ image: string }> } }>>`
      select details from platform_audit_events
      where worker_id = ${workerId} and event_type = 'worker.runtime_reported'
      order by id desc limit 1
    `;
    expect(audit[0]?.details.runtimeImages.map((entry) => entry.image)).toEqual([OLD, NEW]);
  });

  it("persists the intent only from STOPPED on the source image, and completes it", async () => {
    const workspaceId = await stoppedWorkspace();

    expect(await begin(workspaceId, NEW, OLD)).toBe(false);
    await database`update workspaces set desired_state = 'RUNNING' where id = ${workspaceId}`;
    expect(await begin(workspaceId, OLD, NEW)).toBe(false);
    await database`update workspaces set desired_state = 'STOPPED' where id = ${workspaceId}`;

    expect(await begin(workspaceId, OLD, NEW)).toBe(true);
    expect(await row(workspaceId)).toEqual({
      state: "UPGRADING",
      runtime_image: NEW,
      previous_runtime_image: OLD,
      complete: false,
    });
    // Nothing else may act on a Workspace in the middle of a change.
    expect(await begin(workspaceId, OLD, NEW)).toBe(false);
    await expect(
      repository.scheduleWorkspaceStart({
        workspaceId,
        userId: ownerId,
        connectedWorkerIds: [workerId],
        heartbeatCutoff: new Date(0),
      }),
    ).resolves.toEqual({ outcome: "WORKSPACE_CHANGED" });
    expect(
      await repository.beginWorkspaceDelete({ workspaceId, userId: ownerId, workerId }),
    ).toBe(false);

    expect(
      await repository.finishWorkspaceRuntimeChange({ workspaceId, workerId, toImage: NEW, actorUserId: ownerId }),
    ).toBe(true);
    expect(await row(workspaceId)).toEqual({
      state: "STOPPED",
      runtime_image: NEW,
      previous_runtime_image: OLD,
      complete: true,
    });
    const events = await database<Array<{ event_type: string; actor_user_id: string | null }>>`
      select event_type, actor_user_id from platform_audit_events
      where workspace_id = ${workspaceId} and event_type like 'workspace.runtime%'
      order by id
    `;
    // The state trigger fires on the UPDATE, before the explicit event of the same transaction.
    expect(events.map((event) => event.event_type)).toEqual([
      "workspace.runtime_upgrading",
      "workspace.runtime_change_requested",
      "workspace.runtime_changed",
    ]);
    expect(events[1]?.actor_user_id).toBe(ownerId);
  });

  it("restores everything on a clean refusal", async () => {
    const workspaceId = await stoppedWorkspace();
    await begin(workspaceId, OLD, NEW);

    expect(
      await repository.revertWorkspaceRuntimeChange({
        workspaceId,
        workerId,
        restore: { runtimeImage: OLD, previousRuntimeImage: null, runtimeChangedAt: null, state: "STOPPED" },
        code: "RUNTIME_IMAGE_UNAVAILABLE",
        actorUserId: ownerId,
      }),
    ).toBe(true);
    expect(await row(workspaceId)).toEqual({
      state: "STOPPED",
      runtime_image: OLD,
      previous_runtime_image: null,
      complete: false,
    });
  });

  it("allows retry or rollback of an interrupted change, and reconciliation completes it", async () => {
    const workspaceId = await stoppedWorkspace();
    await begin(workspaceId, OLD, NEW);
    await repository.markWorkspaceRuntimeFailure({ workspaceId, workerId, workerOffline: false });
    expect(await row(workspaceId)).toMatchObject({ state: "ERROR", complete: false });

    // Retry (same intent) and rollback (reverse) are both accepted from the interrupted state.
    expect(await begin(workspaceId, NEW, OLD)).toBe(true);
    await repository.markWorkspaceRuntimeFailure({ workspaceId, workerId, workerOffline: true });
    expect(await row(workspaceId)).toMatchObject({ state: "WORKER_OFFLINE", runtime_image: OLD });

    // The Worker reconnects and observes the Workspace stopped on the intended image.
    expect(
      await repository.reconcileWorkspaceRecovery({
        workspaceId,
        workerId,
        runtimeImage: OLD,
        desiredState: "STOPPED",
        state: "STOPPED",
      }),
    ).toBe(true);
    expect(await row(workspaceId)).toEqual({
      state: "STOPPED",
      runtime_image: OLD,
      previous_runtime_image: NEW,
      complete: true,
    });
  });

  it("takes an UPGRADING Workspace offline with its Worker", async () => {
    const workspaceId = await stoppedWorkspace();
    await begin(workspaceId, OLD, NEW);
    await database`update workers set status = 'ONLINE', last_heartbeat_at = now() - interval '1 hour' where id = ${workerId}`;

    await repository.markWorkersOffline(new Date());

    expect(await row(workspaceId)).toMatchObject({ state: "WORKER_OFFLINE" });
  });
});
