import { randomUUID } from "node:crypto";

import { hashOpaqueToken, hashPassword } from "@agent-runtime/auth";
import {
  checkDatabase,
  createDatabaseClient,
  createPhase6Repository,
  migrateDatabase,
  type DatabaseClient,
} from "@agent-runtime/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildControlPlane } from "./app.js";
import { selectWorker } from "./scheduler.js";
import { WorkspaceSessionExchange } from "./session-exchange.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl === undefined ? describe.skip : describe;
const NOW = new Date("2026-09-10T08:00:00.000Z");

describeWithPostgres("Phase 1 through 6 PostgreSQL integration", () => {
  const userAId = randomUUID();
  const userBId = randomUUID();
  const phase3UserId = randomUUID();
  const phase5UserId = randomUUID();
  const phase6UserId = randomUUID();
  const suffix = randomUUID();
  const workerId = `worker-${suffix}`;
  const phase3WorkerId = `runtime-${suffix}`;
  const phase6WorkerId = `recovery-${suffix}`;
  const phase5WorkerIds = ["a", "b", "arch", "cap", "image", "last"].map(
    (name) => `scheduler-${name}-${suffix}`,
  );
  const phase3RuntimeImage = `agent-runtime:integration-${suffix}`;
  let database!: DatabaseClient;

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    await migrateDatabase(database);
  });

  afterAll(async () => {
    await database`delete from workspaces where user_id in (${userAId}, ${userBId}, ${phase3UserId}, ${phase5UserId}, ${phase6UserId})`;
    await database`delete from workers where id = ${workerId} or id = ${phase3WorkerId} or id = ${phase6WorkerId} or id = any(${phase5WorkerIds})`;
    await database`delete from users where id in (${userAId}, ${userBId}, ${phase3UserId}, ${phase5UserId}, ${phase6UserId})`;
    await database.end({ timeout: 5 });
  });

  it("logs in two persisted users and isolates their workspaces", async () => {
    const repository = createPhase6Repository(database, selectWorker);
    await repository.createUser({
      id: userAId,
      email: `a-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-password-a"),
      role: "user",
    });
    await repository.createUser({
      id: userBId,
      email: `b-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-password-b"),
      role: "user",
    });

    const app = buildControlPlane({
      checkDatabase: async () => checkDatabase(database),
      store: repository,
      workerStore: repository,
      sessionSecret: "integration-session-secret-at-least-32-characters",
      portalOrigin: "http://portal.test",
      secureCookies: false,
      sessionTtlMs: 60 * 60 * 1_000,
      workspaceBaseUrl: "http://agent.test:3001",
      sessionExchanges: new WorkspaceSessionExchange(60_000),
      defaultRuntimeImage: "agent-runtime:integration-unassigned",
      workerOfflineAfterMs: 35_000,
      workerCommandTimeoutMs: 1_000,
      workspaceResources: {
        cpuCount: 2,
        memoryBytes: 4 * 1024 ** 3,
        pidsLimit: 512,
      },
    });

    async function login(email: string, password: string) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "http://portal.test" },
        payload: { login: email, password },
      });
      expect(response.statusCode).toBe(200);
      const setCookie = response.headers["set-cookie"];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const cookie = header?.split(";")[0];
      if (cookie === undefined) throw new Error("login cookie is missing");
      return {
        cookie,
        csrfToken: response.json<{ csrfToken: string }>().csrfToken,
      };
    }

    const userA = await login(
      `a-${suffix}@example.test`,
      "integration-password-a",
    );
    const userB = await login(
      `b-${suffix}@example.test`,
      "integration-password-b",
    );
    const create = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userA.cookie,
        origin: "http://portal.test",
        "x-csrf-token": userA.csrfToken,
      },
      payload: { name: "persisted-workspace" },
    });
    expect(create.statusCode).toBe(201);

    const listA = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: userA.cookie },
    });
    const listB = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: userB.cookie },
    });
    expect(listA.json()).toMatchObject({
      workspaces: [{ name: "persisted-workspace", state: "CREATED" }],
    });
    expect(listB.json()).toEqual({ workspaces: [] });

    await app.close();
  });

  it("persists a bound Worker credential and rotates it atomically", async () => {
    const repository = createPhase6Repository(database, selectWorker);
    const originalToken = "originalworker0123456789abcdef0123456789abcdef";
    const rotatedToken = "rotatedworker0123456789abcdef0123456789abcdef";
    const originalHash = hashOpaqueToken(originalToken);
    const rotatedHash = hashOpaqueToken(rotatedToken);
    await repository.provisionWorker({
      workerId,
      credentialHash: originalHash,
    });

    expect(await repository.findWorkerByCredentialHash(originalHash)).toEqual({
      workerId,
      enabled: true,
    });
    expect(
      await repository.recordWorkerHello({
        credentialHash: originalHash,
        workerId,
        hostname: "integration-worker.internal",
        architecture: "arm64",
        runtimeImage: "unavailable",
        runtimeVersion: "phase-2",
        capabilities: {
          browser: false,
          office: false,
          ffmpeg: false,
          python: false,
          node: false,
          rust: false,
        },
        maxWorkspaces: 4,
        allocatedWorkspaces: 0,
        systemResources: {
          logicalCpuCount: 8,
          memoryBytes: 16 * 1024 ** 3,
        },
        receivedAt: NOW,
      }),
    ).toBe(true);

    expect(
      await repository.rotateWorkerCredential({
        workerId,
        credentialHash: rotatedHash,
      }),
    ).toBe(true);
    expect(await repository.findWorkerByCredentialHash(originalHash)).toBeNull();
    expect(await repository.findWorkerByCredentialHash(rotatedHash)).toEqual({
      workerId,
      enabled: true,
    });
    expect((await repository.listWorkers()).find((worker) => worker.id === workerId))
      .toMatchObject({ status: "OFFLINE", lastHeartbeatAt: null });
  });

  it("persists minimal placement and lifecycle transitions atomically", async () => {
    const repository = createPhase6Repository(database, selectWorker);
    await repository.createUser({
      id: phase3UserId,
      email: `runtime-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-runtime-password"),
      role: "user",
    });
    const token = "phase3worker0123456789abcdef0123456789abcdef";
    const credentialHash = hashOpaqueToken(token);
    await repository.provisionWorker({
      workerId: phase3WorkerId,
      credentialHash,
    });
    expect(
      await repository.recordWorkerHello({
        credentialHash,
        workerId: phase3WorkerId,
        hostname: "runtime-worker.internal",
        architecture: "arm64",
        runtimeImage: phase3RuntimeImage,
        runtimeVersion: "phase-3",
        capabilities: {
          browser: false,
          office: false,
          ffmpeg: false,
          python: true,
          node: true,
          rust: false,
        },
        maxWorkspaces: 2,
        allocatedWorkspaces: 0,
        systemResources: {
          logicalCpuCount: 8,
          memoryBytes: 16 * 1024 ** 3,
        },
        receivedAt: NOW,
      }),
    ).toBe(true);
    expect(
      await repository.configureWorkerGateway({
        workerId: phase3WorkerId,
        gatewayBaseUrl: "https://runtime-worker.internal:3100",
      }),
    ).toBe(true);
    await expect(
      repository.findWorkerGatewayRoute({
        workerId: phase3WorkerId,
        heartbeatCutoff: new Date(NOW.getTime() - 35_000),
      }),
    ).resolves.toEqual({
      workerId: phase3WorkerId,
      gatewayBaseUrl: "https://runtime-worker.internal:3100",
    });
    const workspace = await repository.createWorkspace({
      id: randomUUID(),
      userId: phase3UserId,
      name: "phase-3-lifecycle",
      runtimeImage: phase3RuntimeImage,
    });

    await expect(
      repository.listEligibleWorkerIds({
        workspaceId: workspace.id,
        userId: phase3UserId,
        heartbeatCutoff: new Date(NOW.getTime() - 35_000),
      }),
    ).resolves.toEqual([phase3WorkerId]);
    await expect(
      repository.beginWorkspaceStart({
        workspaceId: workspace.id,
        userId: phase3UserId,
        workerId: phase3WorkerId,
      }),
    ).resolves.toMatchObject({
      workerId: phase3WorkerId,
      state: "STARTING",
    });
    await expect(
      repository.finishWorkspaceStart({
        workspaceId: workspace.id,
        workerId: phase3WorkerId,
      }),
    ).resolves.toBe(true);
    expect(
      (await repository.listWorkersWithAssignments()).find(
        (worker) => worker.id === phase3WorkerId,
      ),
    ).toMatchObject({ assignedWorkspaces: 1 });
    await expect(repository.markWorkersOffline(NOW)).resolves.toBe(1);
    await expect(
      repository.findOwnedWorkspace(workspace.id, phase3UserId),
    ).resolves.toMatchObject({
      workerId: phase3WorkerId,
      state: "WORKER_OFFLINE",
    });
    await expect(
      repository.reconcileWorkerOfflineWorkspace({
        workspaceId: workspace.id,
        workerId: phase3WorkerId,
        runtimeImage: "wrong-runtime-image",
        state: "RUNNING",
      }),
    ).resolves.toBe(false);
    await expect(
      repository.listWorkerOfflineWorkspaces(phase3WorkerId),
    ).resolves.toEqual([
      expect.objectContaining({ id: workspace.id, state: "WORKER_OFFLINE" }),
    ]);
    await expect(
      repository.reconcileWorkerOfflineWorkspace({
        workspaceId: workspace.id,
        workerId: phase3WorkerId,
        runtimeImage: phase3RuntimeImage,
        state: "RUNNING",
      }),
    ).resolves.toBe(true);
    await expect(
      repository.beginWorkspaceStop({
        workspaceId: workspace.id,
        userId: phase3UserId,
        workerId: phase3WorkerId,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.finishWorkspaceStop({
        workspaceId: workspace.id,
        workerId: phase3WorkerId,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.beginWorkspaceDelete({
        workspaceId: workspace.id,
        userId: phase3UserId,
        workerId: phase3WorkerId,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.deleteConfirmedWorkspace({
        workspaceId: workspace.id,
        userId: phase3UserId,
        workerId: phase3WorkerId,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.findOwnedWorkspace(workspace.id, phase3UserId),
    ).resolves.toBeNull();
    expect(
      (await repository.listWorkersWithAssignments()).find(
        (worker) => worker.id === phase3WorkerId,
      ),
    ).toMatchObject({ assignedWorkspaces: 0 });
  });

  it("persists desired state and conditionally recovers or finalizes deletion", async () => {
    const repository = createPhase6Repository(database, selectWorker);
    const runtimeImage = `agent-runtime:recovery-${suffix}`;
    const credentialHash = hashOpaqueToken(
      `recovery-${suffix}-credential-token`,
    );
    await repository.createUser({
      id: phase6UserId,
      email: `recovery-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-recovery-password"),
      role: "user",
    });
    await repository.provisionWorker({
      workerId: phase6WorkerId,
      credentialHash,
    });
    await repository.recordWorkerHello({
      credentialHash,
      workerId: phase6WorkerId,
      hostname: "recovery-worker.internal",
      architecture: "arm64",
      runtimeImage,
      runtimeVersion: "phase-6",
      capabilities: {
        browser: false,
        office: false,
        ffmpeg: false,
        python: true,
        node: true,
        rust: false,
      },
      maxWorkspaces: 2,
      allocatedWorkspaces: 1,
      systemResources: {
        logicalCpuCount: 8,
        memoryBytes: 16 * 1024 ** 3,
      },
      receivedAt: NOW,
    });
    const workspace = await repository.createWorkspace({
      id: randomUUID(),
      userId: phase6UserId,
      name: "phase-6-recovery",
      runtimeImage,
    });
    await repository.beginWorkspaceStart({
      workspaceId: workspace.id,
      userId: phase6UserId,
      workerId: phase6WorkerId,
    });
    await repository.finishWorkspaceStart({
      workspaceId: workspace.id,
      workerId: phase6WorkerId,
    });

    await expect(
      repository.markAllWorkersOfflineForRecovery(
        new Date(NOW.getTime() + 1),
      ),
    ).resolves.toBe(1);
    const [recovering] =
      await repository.beginWorkerReconciliation(phase6WorkerId);
    expect(recovering).toMatchObject({
      id: workspace.id,
      state: "WORKER_OFFLINE",
      desiredState: "RUNNING",
    });
    await expect(
      repository.reconcileWorkspaceRecovery({
        workspaceId: workspace.id,
        workerId: phase6WorkerId,
        runtimeImage,
        desiredState: "STOPPED",
        state: "RUNNING",
      }),
    ).resolves.toBe(false);
    await expect(
      repository.reconcileWorkspaceRecovery({
        workspaceId: workspace.id,
        workerId: phase6WorkerId,
        runtimeImage,
        desiredState: "RUNNING",
        state: "RUNNING",
      }),
    ).resolves.toBe(true);

    await repository.beginWorkspaceDelete({
      workspaceId: workspace.id,
      userId: phase6UserId,
      workerId: phase6WorkerId,
    });
    const [deleting] =
      await repository.beginWorkerReconciliation(phase6WorkerId);
    expect(deleting).toMatchObject({
      state: "WORKER_OFFLINE",
      desiredState: "DELETED",
    });
    await expect(
      repository.deleteRecoveredWorkspace({
        workspaceId: workspace.id,
        userId: phase6UserId,
        workerId: phase6WorkerId,
        runtimeImage,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.findOwnedWorkspace(workspace.id, phase6UserId),
    ).resolves.toBeNull();
  });

  it("schedules compatible Workers by authoritative load and reserves the final slot once", async () => {
    const repository = createPhase6Repository(database, selectWorker);
    const runtimeImage = `agent-runtime:scheduler-${suffix}`;
    const finalSlotImage = `agent-runtime:last-slot-${suffix}`;
    await repository.createUser({
      id: phase5UserId,
      email: `scheduler-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-scheduler-password"),
      role: "user",
    });

    const [workerA, workerB, wrongArch, wrongCapability, wrongImage, lastSlot] =
      phase5WorkerIds;
    if (
      workerA === undefined ||
      workerB === undefined ||
      wrongArch === undefined ||
      wrongCapability === undefined ||
      wrongImage === undefined ||
      lastSlot === undefined
    ) {
      throw new Error("Phase 5 Worker fixtures are missing");
    }

    async function onlineWorker(input: {
      workerId: string;
      image: string;
      architecture: "amd64" | "arm64";
      browser: boolean;
      maxWorkspaces: number;
    }) {
      const token = hashOpaqueToken(`scheduler-${input.workerId}-credential-token`);
      await repository.provisionWorker({
        workerId: input.workerId,
        credentialHash: token,
      });
      await repository.recordWorkerHello({
        credentialHash: token,
        workerId: input.workerId,
        hostname: `${input.workerId}.internal`,
        architecture: input.architecture,
        runtimeImage: input.image,
        runtimeVersion: "phase-3",
        capabilities: {
          browser: input.browser,
          office: false,
          ffmpeg: false,
          python: true,
          node: true,
          rust: false,
        },
        maxWorkspaces: input.maxWorkspaces,
        // Deliberately stale-low: scheduler capacity and score must use
        // Control Plane assignments, not this Worker observation.
        allocatedWorkspaces: 0,
        systemResources: {
          logicalCpuCount: 8,
          memoryBytes: 16 * 1024 ** 3,
        },
        receivedAt: NOW,
      });
    }

    await onlineWorker({
      workerId: workerA,
      image: runtimeImage,
      architecture: "arm64",
      browser: true,
      maxWorkspaces: 4,
    });
    await onlineWorker({
      workerId: workerB,
      image: runtimeImage,
      architecture: "arm64",
      browser: true,
      maxWorkspaces: 8,
    });
    await onlineWorker({
      workerId: wrongArch,
      image: runtimeImage,
      architecture: "amd64",
      browser: true,
      maxWorkspaces: 100,
    });
    await onlineWorker({
      workerId: wrongCapability,
      image: runtimeImage,
      architecture: "arm64",
      browser: false,
      maxWorkspaces: 100,
    });
    await onlineWorker({
      workerId: wrongImage,
      image: `${runtimeImage}-other`,
      architecture: "arm64",
      browser: true,
      maxWorkspaces: 100,
    });
    await onlineWorker({
      workerId: lastSlot,
      image: finalSlotImage,
      architecture: "arm64",
      browser: false,
      maxWorkspaces: 1,
    });

    for (const [workerId, count] of [
      [workerA, 2],
      [workerB, 2],
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        await database`
          insert into workspaces (
            id, user_id, name, worker_id, state, runtime_image
          ) values (
            ${randomUUID()}, ${phase5UserId},
            ${`load-${workerId}-${index}`}, ${workerId}, 'STOPPED', ${runtimeImage}
          )
        `;
      }
    }

    const target = await repository.createWorkspace({
      id: randomUUID(),
      userId: phase5UserId,
      name: "scored-placement",
      runtimeImage,
    });
    await database`
      update workspaces
      set
        required_architecture = 'arm64',
        required_capabilities = ${database.json({ browser: true, python: true })}
      where id = ${target.id}
    `;
    const placed = await repository.scheduleWorkspaceStart({
      workspaceId: target.id,
      userId: phase5UserId,
      heartbeatCutoff: new Date(NOW.getTime() - 35_000),
      connectedWorkerIds: phase5WorkerIds,
    });
    expect(placed).toMatchObject({
      outcome: "STARTING",
      sticky: false,
      workspace: { workerId: workerB },
    });
    expect(
      (await repository.listWorkersWithAssignments()).find(
        (worker) => worker.id === workerB,
      ),
    ).toMatchObject({ assignedWorkspaces: 3, allocatedWorkspaces: 0 });

    await database`update workspaces set state = 'STOPPED' where id = ${target.id}`;
    await database`update workers set status = 'OFFLINE' where id = ${workerB}`;
    const sticky = await repository.scheduleWorkspaceStart({
      workspaceId: target.id,
      userId: phase5UserId,
      heartbeatCutoff: new Date(NOW.getTime() - 35_000),
      connectedWorkerIds: [workerA],
    });
    expect(sticky).toMatchObject({
      outcome: "STARTING",
      sticky: true,
      workspace: { workerId: workerB },
    });

    const contenders = await Promise.all(
      ["last-slot-one", "last-slot-two"].map(async (name) => {
        const workspace = await repository.createWorkspace({
          id: randomUUID(),
          userId: phase5UserId,
          name,
          runtimeImage: finalSlotImage,
        });
        return repository.scheduleWorkspaceStart({
          workspaceId: workspace.id,
          userId: phase5UserId,
          heartbeatCutoff: new Date(NOW.getTime() - 35_000),
          connectedWorkerIds: [lastSlot],
        });
      }),
    );
    expect(contenders.map((result) => result.outcome).sort()).toEqual([
      "NO_ELIGIBLE_WORKER",
      "STARTING",
    ]);
    const assignments = await database<Array<{ count: number }>>`
      select count(*)::integer as count
      from workspaces
      where worker_id = ${lastSlot}
    `;
    expect(assignments[0]?.count).toBe(1);
  });
});
