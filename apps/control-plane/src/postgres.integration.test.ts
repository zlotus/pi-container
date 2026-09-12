import { randomUUID } from "node:crypto";

import { hashOpaqueToken, hashPassword } from "@agent-runtime/auth";
import {
  checkDatabase,
  createDatabaseClient,
  createPhase4Repository,
  migrateDatabase,
  type DatabaseClient,
} from "@agent-runtime/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildControlPlane } from "./app.js";
import { WorkspaceSessionExchange } from "./session-exchange.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl === undefined ? describe.skip : describe;
const NOW = new Date("2026-09-10T08:00:00.000Z");

describeWithPostgres("Phase 1 through 4 PostgreSQL integration", () => {
  const userAId = randomUUID();
  const userBId = randomUUID();
  const phase3UserId = randomUUID();
  const suffix = randomUUID();
  const workerId = `worker-${suffix}`;
  const phase3WorkerId = `runtime-${suffix}`;
  const phase3RuntimeImage = `agent-runtime:integration-${suffix}`;
  let database!: DatabaseClient;

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    await migrateDatabase(database);
  });

  afterAll(async () => {
    await database`delete from workspaces where user_id in (${userAId}, ${userBId}, ${phase3UserId})`;
    await database`delete from workers where id in (${workerId}, ${phase3WorkerId})`;
    await database`delete from users where id in (${userAId}, ${userBId}, ${phase3UserId})`;
    await database.end({ timeout: 5 });
  });

  it("logs in two persisted users and isolates their workspaces", async () => {
    const repository = createPhase4Repository(database);
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
    const repository = createPhase4Repository(database);
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
    const repository = createPhase4Repository(database);
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
  });
});
