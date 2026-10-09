import { createHash, randomUUID } from "node:crypto";

import { hashOpaqueToken, hashPassword } from "@agent-runtime/auth";
import {
  checkDatabase,
  createDatabaseClient,
  createRepository,
  migrateDatabase,
  nextAuthThrottleState,
  type AuthThrottleState,
  type DatabaseClient,
} from "@agent-runtime/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildControlPlane } from "./app.js";
import { AddressSet, DEFAULT_LOGIN_GUARD_POLICIES, LoginGuard } from "./login-guard.js";
import { selectWorker } from "./scheduler.js";
import { WorkspaceSessionExchange } from "./session-exchange.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl === undefined ? describe.skip : describe;
const NOW = new Date("2026-09-10T08:00:00.000Z");
const STORAGE_ENFORCED = { enforced: true, fsType: "xfs", totalBytes: 2 ** 40, freeBytes: 2 ** 39 };

describeWithPostgres("Phase 1 through 9 PostgreSQL integration", () => {
  const userAId = randomUUID();
  const userBId = randomUUID();
  const phase3UserId = randomUUID();
  const phase5UserId = randomUUID();
  const phase6UserId = randomUUID();
  const phase9AdminId = randomUUID();
  const phase9UserId = randomUUID();
  const phase10UserId = randomUUID();
  const phase10OtherUserId = randomUUID();
  const phase11AdminId = randomUUID();
  const phase11LocalUserId = randomUUID();
  const phase11JitUserId = randomUUID();
  const phase11SameEmailUserId = randomUUID();
  const phase12AdminId = randomUUID();
  const phase12UserId = randomUUID();
  const schedulingUserId = randomUUID();
  const auditFilterUserId = randomUUID();
  const egressAdminId = randomUUID();
  const suffix = randomUUID();
  const workerId = `worker-${suffix}`;
  const phase3WorkerId = `runtime-${suffix}`;
  const phase6WorkerId = `recovery-${suffix}`;
  const egressWorkerId = `egress-${suffix}`;
  const phase5WorkerIds = ["a", "b", "arch", "cap", "image", "last", "paused", "active"].map(
    (name) => `scheduler-${name}-${suffix}`,
  );
  const phase3RuntimeImage = `agent-runtime:integration-${suffix}`;
  let database!: DatabaseClient;

  /** Workers in these tests report the live revision so the scheduler accepts them. */
  async function currentEgressRevision(): Promise<number> {
    const rows = await database<Array<{ revision: string }>>`
      select revision::text from egress_policy_state
    `;
    return Number(rows[0]?.revision ?? 0);
  }

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    await migrateDatabase(database);
  });

  afterAll(async () => {
    await database`delete from egress_rules where created_by = ${egressAdminId}`;
    await database`delete from workspaces where worker_id = ${egressWorkerId}`;
    await database`delete from platform_audit_events where worker_id = ${egressWorkerId} or actor_user_id = ${egressAdminId}`;
    await database`delete from workers where id = ${egressWorkerId}`;
    await database`delete from users where id = ${egressAdminId}`;
    await database`delete from workspaces where user_id in (${userAId}, ${userBId}, ${phase3UserId}, ${phase5UserId}, ${phase6UserId}, ${phase9AdminId}, ${phase9UserId}, ${phase10UserId}, ${phase10OtherUserId}, ${phase11AdminId}, ${phase11LocalUserId}, ${phase11JitUserId}, ${phase11SameEmailUserId}, ${phase12AdminId}, ${phase12UserId}, ${schedulingUserId}, ${auditFilterUserId})`;
    await database`delete from workers where id = ${workerId} or id = ${phase3WorkerId} or id = ${phase6WorkerId} or id = any(${phase5WorkerIds})`;
    await database`
      delete from platform_audit_events
      where owner_user_id in (${userAId}, ${userBId}, ${phase3UserId}, ${phase5UserId}, ${phase6UserId}, ${phase9AdminId}, ${phase9UserId}, ${phase10UserId}, ${phase10OtherUserId}, ${phase11AdminId}, ${phase11LocalUserId}, ${phase11JitUserId}, ${phase11SameEmailUserId}, ${phase12AdminId}, ${phase12UserId}, ${schedulingUserId}, ${auditFilterUserId})
        or actor_user_id in (${userAId}, ${userBId}, ${phase3UserId}, ${phase5UserId}, ${phase6UserId}, ${phase11AdminId}, ${phase12AdminId}, ${phase12UserId}, ${schedulingUserId}, ${auditFilterUserId})
        or worker_id = ${workerId}
        or worker_id = ${phase3WorkerId}
        or worker_id = ${phase6WorkerId}
        or worker_id = any(${phase5WorkerIds})
    `;
    await database`delete from users where id in (${userAId}, ${userBId}, ${phase3UserId}, ${phase5UserId}, ${phase6UserId}, ${phase9AdminId}, ${phase9UserId}, ${phase10UserId}, ${phase10OtherUserId}, ${phase11AdminId}, ${phase11LocalUserId}, ${phase11JitUserId}, ${phase11SameEmailUserId}, ${phase12AdminId}, ${phase12UserId}, ${schedulingUserId}, ${auditFilterUserId})`;
    await database.end({ timeout: 5 });
  });

  it("persists Phase 9 status, revocation, password reset, and User Workspace metadata", async () => {
    const repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: phase9AdminId,
      email: `phase9-admin-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("phase9-admin-password"),
      role: "admin",
    });
    await repository.createUser({
      id: phase9UserId,
      email: `phase9-user-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("phase9-user-password"),
      role: "user",
    });
    const workspace = await repository.createWorkspace({
      id: randomUUID(),
      userId: phase9UserId,
      name: "phase9-metadata",
      runtimeImage: "agent-runtime:phase9-integration",
      diskLimitBytes: 20 * 1024 ** 3,
    });
    const tokenHash = hashOpaqueToken(`phase9-${suffix}`);
    await expect(
      repository.createSession({
        id: randomUUID(),
        userId: phase9UserId,
        tokenHash,
        expiresAt: new Date(NOW.getTime() + 60_000),
      }),
    ).resolves.toBe(true);

    const listed = await repository.listUsers();
    expect(listed.find((user) => user.id === phase9UserId)).toMatchObject({
      status: "active",
      source: "local",
      workspaceCount: 1,
    });
    await expect(
      repository.listManagedUserWorkspaces(phase9UserId),
    ).resolves.toMatchObject([{ id: workspace.id, userId: phase9UserId }]);
    await expect(
      repository.updateManagedUser({
        userId: phase9UserId,
        status: "disabled",
      }),
    ).resolves.toMatchObject({
      outcome: "UPDATED",
      user: { status: "disabled" },
    });
    await expect(repository.findActiveSession(tokenHash, NOW)).resolves.toBeNull();
    await expect(
      repository.resetLocalPassword({
        userId: phase9UserId,
        passwordHash: await hashPassword("phase9-replacement-password"),
      }),
    ).resolves.toBe(true);
    await expect(
      repository.revokeUserSessions(phase9UserId, NOW),
    ).resolves.toBe(true);
  });

  it("binds Phase 10 identities by provider and subject without email merging", async () => {
    const repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: phase10UserId,
      email: `phase10-a-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("phase10-user-a-password"),
      role: "user",
    });
    await repository.createUser({
      id: phase10OtherUserId,
      email: `phase10-b-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("phase10-user-b-password"),
      role: "user",
    });

    await expect(
      repository.bindExternalIdentity({
        id: randomUUID(),
        userId: phase10UserId,
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
        actorUserId: phase10UserId,
      }),
    ).resolves.toMatchObject({
      outcome: "BOUND",
      identity: { userId: phase10UserId },
    });
    await expect(
      repository.bindExternalIdentity({
        id: randomUUID(),
        userId: phase10OtherUserId,
        providerId: "enterprise-oidc",
        providerSubject: "subject-a",
        actorUserId: phase10OtherUserId,
      }),
    ).resolves.toEqual({ outcome: "IDENTITY_ALREADY_BOUND" });

    const commonSnapshot = "same-external-email@example.test";
    await expect(
      repository.completeExternalLogin({
        providerId: "enterprise-oidc",
        usernameSnapshot: null,
        autoProvision: false,
        provisionedUser: null,
        identityId: randomUUID(),
        providerSubject: "subject-with-same-email-but-no-binding",
        emailSnapshot: commonSnapshot,
        displayNameSnapshot: "Unbound subject",
        sessionId: randomUUID(),
        tokenHash: hashOpaqueToken(`phase10-unknown-${suffix}`),
        expiresAt: new Date(NOW.getTime() + 60_000),
        authenticatedAt: NOW,
      }),
    ).resolves.toEqual({ outcome: "UNKNOWN_IDENTITY" });

    const tokenHash = hashOpaqueToken(`phase10-known-${suffix}`);
    await expect(
      repository.completeExternalLogin({
        providerId: "enterprise-oidc",
        usernameSnapshot: null,
        autoProvision: false,
        provisionedUser: null,
        identityId: randomUUID(),
        providerSubject: "subject-a",
        emailSnapshot: commonSnapshot,
        displayNameSnapshot: "Known subject",
        sessionId: randomUUID(),
        tokenHash,
        expiresAt: new Date(NOW.getTime() + 60_000),
        authenticatedAt: NOW,
      }),
    ).resolves.toMatchObject({
      outcome: "AUTHENTICATED",
      user: { id: phase10UserId, role: "user", status: "active" },
    });
    await expect(repository.findActiveSession(tokenHash, NOW)).resolves.toMatchObject({
      user: { id: phase10UserId },
    });

    await repository.updateManagedUser({
      userId: phase10UserId,
      status: "disabled",
    });
    await expect(
      repository.completeExternalLogin({
        providerId: "enterprise-oidc",
        usernameSnapshot: null,
        autoProvision: false,
        provisionedUser: null,
        identityId: randomUUID(),
        providerSubject: "subject-a",
        emailSnapshot: commonSnapshot,
        displayNameSnapshot: "Known subject",
        sessionId: randomUUID(),
        tokenHash: hashOpaqueToken(`phase10-disabled-${suffix}`),
        expiresAt: new Date(NOW.getTime() + 60_000),
        authenticatedAt: NOW,
      }),
    ).resolves.toEqual({ outcome: "USER_DISABLED" });
  });

  it("atomically provisions Phase 11 external users and audits protected identity management", async () => {
    const repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: phase11AdminId,
      email: `phase11-admin-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("phase11-admin-password"),
      role: "admin",
    });
    await repository.createUser({
      id: phase11LocalUserId,
      email: `phase11-local-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("phase11-local-password"),
      role: "user",
    });

    const localIdentityId = randomUUID();
    await expect(
      repository.bindExternalIdentity({
        id: localIdentityId,
        userId: phase11LocalUserId,
        providerId: "phase11-oidc",
        providerSubject: "local-bound-subject",
        actorUserId: phase11AdminId,
      }),
    ).resolves.toMatchObject({ outcome: "BOUND" });
    await expect(repository.listUserIdentities(phase11LocalUserId)).resolves.toMatchObject([
      { id: localIdentityId, providerSubject: "local-bound-subject" },
    ]);
    await expect(
      repository.unbindExternalIdentity({
        identityId: localIdentityId,
        userId: phase11LocalUserId,
        actorUserId: phase11AdminId,
      }),
    ).resolves.toEqual({ outcome: "UNBOUND" });

    const jitInput = {
      providerId: "phase11-oauth2",
      providerSubject: "jit-subject",
      usernameSnapshot: "jit-user",
      emailSnapshot: `same-${suffix}@example.test`,
      displayNameSnapshot: "JIT User",
      identityId: randomUUID(),
      sessionId: randomUUID(),
      tokenHash: hashOpaqueToken(`phase11-jit-${suffix}`),
      expiresAt: new Date(NOW.getTime() + 60_000),
      authenticatedAt: NOW,
    };
    await expect(
      repository.completeExternalLogin({
        ...jitInput,
        autoProvision: false,
        provisionedUser: null,
      }),
    ).resolves.toEqual({ outcome: "UNKNOWN_IDENTITY" });
    await expect(
      repository.completeExternalLogin({
        ...jitInput,
        autoProvision: true,
        provisionedUser: {
          id: phase11JitUserId,
          email: jitInput.emailSnapshot,
          username: "jit-user",
        },
      }),
    ).resolves.toMatchObject({
      outcome: "AUTHENTICATED",
      provisioned: true,
      user: { id: phase11JitUserId, role: "user", status: "active" },
    });
    const jitIdentities = await repository.listUserIdentities(phase11JitUserId);
    expect(jitIdentities).toHaveLength(1);
    const jitIdentity = jitIdentities?.[0];
    if (jitIdentity === undefined) throw new Error("JIT identity missing");
    await expect(
      repository.unbindExternalIdentity({
        identityId: jitIdentity.id,
        userId: phase11JitUserId,
        actorUserId: phase11AdminId,
      }),
    ).resolves.toEqual({ outcome: "LAST_LOGIN_METHOD" });

    await expect(
      repository.completeExternalLogin({
        ...jitInput,
        providerSubject: "same-email-different-subject",
        identityId: randomUUID(),
        sessionId: randomUUID(),
        tokenHash: hashOpaqueToken(`phase11-same-email-${suffix}`),
        autoProvision: true,
        provisionedUser: {
          id: phase11SameEmailUserId,
          email: jitInput.emailSnapshot,
          username: null,
        },
      }),
    ).resolves.toMatchObject({
      outcome: "AUTHENTICATED",
      user: { id: phase11SameEmailUserId, role: "user" },
    });

    const identityAudit = await database<
      Array<{ event_type: string; details: Record<string, unknown> }>
    >`
      select event_type, details
      from platform_audit_events
      where actor_user_id = ${phase11AdminId}
        and event_type like 'identity.%'
      order by id desc
    `;
    expect(identityAudit.map((event) => event.event_type)).toEqual([
      "identity.unbound",
      "identity.bound",
    ]);
    expect(JSON.stringify(identityAudit)).not.toContain("local-bound-subject");
  });

  it("persists Phase 12 auth events transactionally and hides them from ordinary users", async () => {
    const repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: phase12AdminId,
      email: `phase12-admin-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("phase12-admin-password"),
      role: "admin",
    });
    await repository.createUser({
      id: phase12UserId,
      email: `phase12-user-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("phase12-user-password"),
      role: "user",
      actorUserId: phase12AdminId,
    });
    const audit = {
      protocol: "LOCAL" as const,
      providerId: "local",
      requestId: `phase12-${suffix}`,
      ipAddress: "127.0.0.1",
      userAgent: "phase12-integration",
    };
    const firstTokenHash = hashOpaqueToken(`phase12-first-${suffix}`);
    await expect(
      repository.createSession({
        id: randomUUID(),
        userId: phase12UserId,
        tokenHash: firstTokenHash,
        expiresAt: new Date(NOW.getTime() + 60_000),
        audit,
      }),
    ).resolves.toBe(true);
    await repository.revokeSession(firstTokenHash, NOW, {
      actorUserId: phase12UserId,
      ...audit,
    });
    await repository.createSession({
      id: randomUUID(),
      userId: phase12UserId,
      tokenHash: hashOpaqueToken(`phase12-second-${suffix}`),
      expiresAt: new Date(NOW.getTime() + 60_000),
      audit,
    });
    await repository.updateManagedUser({
      userId: phase12UserId,
      status: "disabled",
      audit: { actorUserId: phase12AdminId, ...audit },
    });
    await repository.updateManagedUser({
      userId: phase12UserId,
      status: "active",
      role: "admin",
      audit: { actorUserId: phase12AdminId, ...audit },
    });
    await repository.resetLocalPassword({
      userId: phase12UserId,
      passwordHash: await hashPassword("phase12-replacement-password"),
      audit: { actorUserId: phase12AdminId, ...audit },
    });
    await repository.revokeUserSessions(phase12UserId, NOW, {
      actorUserId: phase12AdminId,
      ...audit,
    });
    await repository.recordAuthenticationFailure({
      category: "protocol_validation_failed",
      audit: { ...audit, protocol: "OIDC", providerId: "enterprise-oidc" },
    });

    const adminEvents = await database<
      Array<{ event_type: string; details: Record<string, unknown> }>
    >`
      select event_type, details
      from platform_audit_events
      where actor_user_id in (${phase12AdminId}, ${phase12UserId})
        or owner_user_id in (${phase12AdminId}, ${phase12UserId})
        or details ->> 'requestId' = ${audit.requestId}
      order by id desc
    `;
    const ordinaryEvents = await repository.listAuditEvents({
      userId: phase12UserId,
      includeAllUsers: false,
      limit: 100,
      beforeId: null,
    });
    const eventTypes = adminEvents.map((event) => event.event_type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "auth.login_succeeded",
        "auth.login_failed",
        "auth.logout",
        "auth.session_revoked",
        "user.created",
        "user.enabled",
        "user.disabled",
        "user.role_changed",
        "user.password_reset",
      ]),
    );
    expect(ordinaryEvents).toEqual([]);
    expect(JSON.stringify(adminEvents)).not.toContain(
      "phase12-replacement-password",
    );
  });

  it("logs in two persisted users and isolates their workspaces", async () => {
    const repository = createRepository(database, selectWorker);
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
      workspaceDiskLimitBytes: 20 * 1024 ** 3,
      workspaceDiskLimitMaxBytes: 1024 * 1024 ** 3,
      loginGuard: new LoginGuard(
        "integration-session-secret-at-least-32-characters",
        DEFAULT_LOGIN_GUARD_POLICIES,
        new AddressSet(["127.0.0.1/32"]),
      ),
      trustedProxies: new AddressSet([]),
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

    const auditA = await app.inject({
      method: "GET",
      url: "/api/audit-events?limit=10",
      headers: { cookie: userA.cookie },
    });
    const auditB = await app.inject({
      method: "GET",
      url: "/api/audit-events?limit=10",
      headers: { cookie: userB.cookie },
    });
    expect(auditA.statusCode).toBe(200);
    expect(auditA.json()).toMatchObject({
      events: [
        {
          eventType: "workspace.created",
          details: {
            name: "persisted-workspace",
            runtimeImage: "agent-runtime:integration-unassigned",
          },
        },
      ],
    });
    expect(auditB.json()).toEqual({ events: [] });

    await app.close();
  });

  it("persists a bound Worker credential and rotates it atomically", async () => {
    const repository = createRepository(database, selectWorker);
    const originalToken = "originalworker0123456789abcdef0123456789abcdef";
    const rotatedToken = "rotatedworker0123456789abcdef0123456789abcdef";
    const originalHash = hashOpaqueToken(originalToken);
    const rotatedHash = hashOpaqueToken(rotatedToken);
    await repository.provisionWorkerWithGateway({
      workerId,
      credentialHash: originalHash,
      gatewayBaseUrl: "http://127.0.0.1:18080",
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
        egress: { enforced: true, revision: await currentEgressRevision() },
      storage: STORAGE_ENFORCED,
      modelRelay: { enabled: false, port: null, listening: false },
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
    const repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: phase3UserId,
      email: `runtime-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-runtime-password"),
      role: "user",
    });
    const token = "phase3worker0123456789abcdef0123456789abcdef";
    const credentialHash = hashOpaqueToken(token);
    await repository.provisionWorkerWithGateway({
      workerId: phase3WorkerId,
      credentialHash,
      gatewayBaseUrl: "http://127.0.0.1:18080",
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
        egress: { enforced: true, revision: await currentEgressRevision() },
      storage: STORAGE_ENFORCED,
      modelRelay: { enabled: false, port: null, listening: false },
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
      diskLimitBytes: 20 * 1024 ** 3,
    });

    await expect(
      repository.scheduleWorkspaceStart({
        workspaceId: workspace.id,
        userId: phase3UserId,
        heartbeatCutoff: new Date(NOW.getTime() - 35_000),
        connectedWorkerIds: [phase3WorkerId],
      }),
    ).resolves.toMatchObject({
      outcome: "STARTING",
      sticky: false,
      workspace: { workerId: phase3WorkerId, state: "STARTING" },
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
      repository.beginWorkerReconciliation(phase3WorkerId),
    ).resolves.toEqual([
      expect.objectContaining({ id: workspace.id, state: "WORKER_OFFLINE", desiredState: "RUNNING" }),
    ]);
    await expect(
      repository.reconcileWorkspaceRecovery({
        workspaceId: workspace.id,
        workerId: phase3WorkerId,
        runtimeImage: "wrong-runtime-image",
        desiredState: "RUNNING",
        state: "RUNNING",
      }),
    ).resolves.toBe(false);
    await expect(
      repository.reconcileWorkspaceRecovery({
        workspaceId: workspace.id,
        workerId: phase3WorkerId,
        runtimeImage: phase3RuntimeImage,
        desiredState: "RUNNING",
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
    const auditEvents = await repository.listAuditEvents({
      userId: phase3UserId,
      includeAllUsers: false,
      limit: 50,
      beforeId: null,
    });
    expect(auditEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "workspace.created",
        "workspace.scheduled",
        "workspace.starting",
        "workspace.running",
        "workspace.worker_offline",
        "workspace.stopping",
        "workspace.stopped",
        "workspace.deleting",
        "workspace.deleted",
      ]),
    );
    expect(
      auditEvents.every(
        (event) =>
          event.ownerUserId === phase3UserId &&
          event.workspaceId === workspace.id,
      ),
    ).toBe(true);
  });

  it("orders audit IDs numerically across a digit boundary in both list branches", async () => {
    const repository = createRepository(database, selectWorker);
    const ownerUserId = randomUUID();
    const [maxRow] = await database<{ max_id: string | null }[]>`
      select max(id)::text as max_id from platform_audit_events
    `;
    const maxId = BigInt(maxRow?.max_id ?? "0");
    let nextPowerOfTen = 1000n;
    while (nextPowerOfTen - 1n <= maxId) nextPowerOfTen *= 10n;
    const olderId = (nextPowerOfTen - 1n).toString();
    const newerId = nextPowerOfTen.toString();
    const newestId = (nextPowerOfTen + 1n).toString();

    try {
      await database`
        insert into platform_audit_events (id, event_type, owner_user_id)
        overriding system value
        values
          (${olderId}::bigint, 'workspace.created', ${ownerUserId}),
          (${newerId}::bigint, 'workspace.opened', ${ownerUserId}),
          (${newestId}::bigint, 'auth.logout', ${ownerUserId})
      `;

      const adminEvents = await repository.listAuditEvents({
        userId: ownerUserId,
        includeAllUsers: true,
        limit: 3,
        beforeId: null,
      });
      expect(adminEvents.map((event) => event.id)).toEqual([
        newestId,
        newerId,
        olderId,
      ]);

      const adminPage = await repository.listAuditEvents({
        userId: ownerUserId,
        includeAllUsers: true,
        limit: 2,
        beforeId: newestId,
      });
      expect(adminPage.map((event) => event.id)).toEqual([newerId, olderId]);

      const userEvents = await repository.listAuditEvents({
        userId: ownerUserId,
        includeAllUsers: false,
        limit: 2,
        beforeId: null,
      });
      expect(userEvents.map((event) => event.id)).toEqual([newerId, olderId]);

      const userPage = await repository.listAuditEvents({
        userId: ownerUserId,
        includeAllUsers: false,
        limit: 2,
        beforeId: newerId,
      });
      expect(userPage.map((event) => event.id)).toEqual([olderId]);
    } finally {
      await database`
        delete from platform_audit_events where owner_user_id = ${ownerUserId}
      `;
    }
  });

  it("persists desired state and conditionally recovers or finalizes deletion", async () => {
    const repository = createRepository(database, selectWorker);
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
    await repository.provisionWorkerWithGateway({
      workerId: phase6WorkerId,
      credentialHash,
      gatewayBaseUrl: "http://127.0.0.1:18080",
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
      egress: { enforced: true, revision: await currentEgressRevision() },
      storage: STORAGE_ENFORCED,
      modelRelay: { enabled: false, port: null, listening: false },
      receivedAt: NOW,
    });
    const workspace = await repository.createWorkspace({
      id: randomUUID(),
      userId: phase6UserId,
      name: "phase-6-recovery",
      runtimeImage,
      diskLimitBytes: 20 * 1024 ** 3,
    });
    await expect(
      repository.scheduleWorkspaceStart({
        workspaceId: workspace.id,
        userId: phase6UserId,
        heartbeatCutoff: new Date(NOW.getTime() - 35_000),
        connectedWorkerIds: [phase6WorkerId],
      }),
    ).resolves.toMatchObject({ outcome: "STARTING", workspace: { workerId: phase6WorkerId } });
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
    const repository = createRepository(database, selectWorker);
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
      await repository.provisionWorkerWithGateway({
        workerId: input.workerId,
        credentialHash: token,
        gatewayBaseUrl: "http://127.0.0.1:18080",
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
        egress: { enforced: true, revision: await currentEgressRevision() },
      storage: STORAGE_ENFORCED,
      modelRelay: { enabled: false, port: null, listening: false },
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
      diskLimitBytes: 20 * 1024 ** 3,
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
          diskLimitBytes: 20 * 1024 ** 3,
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

  it("pauses Worker scheduling with audit while keeping sticky placement", async () => {
    const repository = createRepository(database, selectWorker);
    const runtimeImage = `agent-runtime:scheduling-pause-${suffix}`;
    const pausedWorker = phase5WorkerIds[6];
    const activeWorker = phase5WorkerIds[7];
    if (pausedWorker === undefined || activeWorker === undefined) {
      throw new Error("scheduling pause Worker fixtures are missing");
    }
    await repository.createUser({
      id: schedulingUserId,
      email: `scheduling-pause-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-scheduling-password"),
      role: "user",
    });
    for (const id of [pausedWorker, activeWorker]) {
      const token = hashOpaqueToken(`scheduling-${id}-credential-token`);
      await repository.provisionWorkerWithGateway({
        workerId: id,
        credentialHash: token,
        gatewayBaseUrl: "http://127.0.0.1:18080",
      });
      await repository.recordWorkerHello({
        credentialHash: token,
        workerId: id,
        hostname: `${id}.internal`,
        architecture: "arm64",
        runtimeImage,
        runtimeVersion: "phase-3",
        capabilities: {
          browser: false,
          office: false,
          ffmpeg: false,
          python: true,
          node: true,
          rust: false,
        },
        maxWorkspaces: 4,
        allocatedWorkspaces: 0,
        systemResources: { logicalCpuCount: 8, memoryBytes: 16 * 1024 ** 3 },
        egress: { enforced: true, revision: await currentEgressRevision() },
      storage: STORAGE_ENFORCED,
      modelRelay: { enabled: false, port: null, listening: false },
        receivedAt: NOW,
      });
    }
    // Load activeWorker so the paused Worker would win on score if it were eligible.
    const sticky = await repository.createWorkspace({
      id: randomUUID(),
      userId: schedulingUserId,
      name: "sticky-on-paused",
      runtimeImage,
      diskLimitBytes: 20 * 1024 ** 3,
    });
    await database`
      update workspaces set worker_id = ${pausedWorker}, state = 'STOPPED'
      where id = ${sticky.id}
    `;
    for (let index = 0; index < 2; index += 1) {
      await database`
        insert into workspaces (id, user_id, name, worker_id, state, runtime_image)
        values (
          ${randomUUID()}, ${schedulingUserId}, ${`load-active-${index}`},
          ${activeWorker}, 'STOPPED', ${runtimeImage}
        )
      `;
    }
    const audit = {
      actorUserId: schedulingUserId,
      requestId: "req-scheduling",
      ipAddress: "127.0.0.1",
      userAgent: null,
    };

    expect(
      await repository.setWorkerSchedulable({
        workerId: `missing-${suffix}`,
        schedulable: false,
        audit,
      }),
    ).toEqual({ outcome: "NOT_FOUND" });
    const paused = await repository.setWorkerSchedulable({
      workerId: pausedWorker,
      schedulable: false,
      audit,
    });
    expect(paused).toMatchObject({
      outcome: "UPDATED",
      worker: { id: pausedWorker, schedulable: false, enabled: true, status: "ONLINE" },
    });
    await repository.setWorkerSchedulable({ workerId: pausedWorker, schedulable: false, audit });

    const target = await repository.createWorkspace({
      id: randomUUID(),
      userId: schedulingUserId,
      name: "placed-while-paused",
      runtimeImage,
      diskLimitBytes: 20 * 1024 ** 3,
    });
    const connected = [pausedWorker, activeWorker];
    const cutoff = new Date(NOW.getTime() - 35_000);
    expect(
      await repository.scheduleWorkspaceStart({
        workspaceId: target.id,
        userId: schedulingUserId,
        heartbeatCutoff: cutoff,
        connectedWorkerIds: connected,
      }),
    ).toMatchObject({ outcome: "STARTING", sticky: false, workspace: { workerId: activeWorker } });
    expect(
      await repository.scheduleWorkspaceStart({
        workspaceId: sticky.id,
        userId: schedulingUserId,
        heartbeatCutoff: cutoff,
        connectedWorkerIds: connected,
      }),
    ).toMatchObject({ outcome: "STARTING", sticky: true, workspace: { workerId: pausedWorker } });

    await repository.setWorkerSchedulable({ workerId: pausedWorker, schedulable: true, audit });
    const events = await database<Array<{ event_type: string; actor_user_id: string; details: Record<string, unknown> }>>`
      select event_type, actor_user_id, details
      from platform_audit_events
      where worker_id = ${pausedWorker} and event_type like 'worker.scheduling_%'
      order by id asc
    `;
    expect(events.map((event) => event.event_type)).toEqual([
      "worker.scheduling_paused",
      "worker.scheduling_resumed",
    ]);
    expect(events[0]).toMatchObject({
      actor_user_id: schedulingUserId,
      details: { requestId: "req-scheduling", ipAddress: "127.0.0.1" },
    });
    // The pause is not a status change, so the status trigger adds no worker.* status event.
    const statusEvents = await database<Array<{ count: number }>>`
      select count(*)::integer as count from platform_audit_events
      where worker_id = ${pausedWorker} and event_type in ('worker.disabled', 'worker.offline')
    `;
    expect(statusEvents[0]?.count).toBe(0);
  });

  it("filters audit events in SQL within each visibility scope and lists all Workspaces", async () => {
    const repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: auditFilterUserId,
      email: `audit-filter-${suffix}@example.test`,
      username: `audit-filter-${suffix.slice(0, 8)}`,
      passwordHash: await hashPassword("integration-audit-filter-password"),
      role: "user",
    });
    const workspace = await repository.createWorkspace({
      id: randomUUID(),
      userId: auditFilterUserId,
      name: "audit-filter-target",
      runtimeImage: "agent-runtime:audit-filter",
      diskLimitBytes: 20 * 1024 ** 3,
    });
    await database`
      insert into platform_audit_events (event_type, actor_user_id, owner_user_id, details)
      values ('auth.logout', ${auditFilterUserId}, ${auditFilterUserId}, '{}'::jsonb)
    `;

    const admin = (filter: Parameters<typeof repository.listAuditEvents>[0]["filter"]) =>
      repository.listAuditEvents({
        userId: auditFilterUserId,
        includeAllUsers: true,
        limit: 100,
        beforeId: null,
        ...(filter === undefined ? {} : { filter }),
      });
    const own = (filter: Parameters<typeof repository.listAuditEvents>[0]["filter"]) =>
      repository.listAuditEvents({
        userId: auditFilterUserId,
        includeAllUsers: false,
        limit: 100,
        beforeId: null,
        ...(filter === undefined ? {} : { filter }),
      });

    const byUser = await admin({ userId: auditFilterUserId });
    expect(byUser.map((event) => event.eventType).sort()).toEqual([
      "auth.logout",
      "workspace.created",
    ]);
    expect((await admin({ userId: auditFilterUserId, category: "auth" }))
      .map((event) => event.eventType)).toEqual(["auth.logout"]);
    expect((await admin({ workspaceId: workspace.id })).map((event) => event.eventType))
      .toEqual(["workspace.created"]);
    expect(await admin({ userId: auditFilterUserId, from: new Date("2099-01-01T00:00:00Z") }))
      .toEqual([]);
    expect(await admin({ userId: auditFilterUserId, to: new Date("2000-01-01T00:00:00Z") }))
      .toEqual([]);
    // The ordinary-user scope stays workspace.* only, even when a filter names another category.
    expect(await own({ category: "auth" })).toEqual([]);
    expect((await own({})).map((event) => event.eventType)).toEqual(["workspace.created"]);

    const all = await repository.listAllWorkspaces();
    expect(all.find((candidate) => candidate.id === workspace.id)).toMatchObject({
      name: "audit-filter-target",
      userId: auditFilterUserId,
      ownerEmail: `audit-filter-${suffix}@example.test`,
    });
  });

  it("persists egress rules with revisions and audit, and Worker egress enforcement", async () => {
    const repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: egressAdminId,
      email: `egress-admin-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("egress-admin-password"),
      role: "admin",
    });
    const audit = {
      actorUserId: egressAdminId,
      requestId: randomUUID(),
      ipAddress: "127.0.0.1",
      userAgent: null,
    };
    const start = (await repository.getEgressPolicy()).revision;
    const allow = {
      action: "allow" as const,
      network: "10.77.0.0/16",
      protocol: "tcp" as const,
      portMin: 443,
      portMax: 443,
      description: "integration",
      audit,
    };

    const created = await repository.createEgressRule({ ...allow, validate: () => null });
    expect(created).toMatchObject({
      outcome: "CREATED",
      revision: start + 1,
      rule: { network: "10.77.0.0/16", protocol: "tcp", portMin: 443, portMax: 443 },
    });
    expect(await repository.createEgressRule({ ...allow, validate: () => null })).toEqual({
      outcome: "DUPLICATE",
    });
    const seen: string[][] = [];
    expect(
      await repository.createEgressRule({
        ...allow,
        network: "10.78.0.0/16",
        validate: (rules) => {
          seen.push(rules.map((rule) => rule.network));
          return "EGRESS_ALLOW_OUTSIDE_DENY";
        },
      }),
    ).toEqual({ outcome: "REJECTED", code: "EGRESS_ALLOW_OUTSIDE_DENY" });
    expect(seen[0]).toEqual(expect.arrayContaining(["10.77.0.0/16", "10.78.0.0/16"]));
    expect((await repository.getEgressPolicy()).revision).toBe(start + 1);

    // The schema rejects what the API rejects, even for direct writes.
    await expect(database`
      insert into egress_rules (id, action, network, protocol, created_by)
      values (${randomUUID()}, 'deny', '10.79.0.0/16', 'tcp', ${egressAdminId})
    `).rejects.toThrow();
    await expect(database`
      insert into egress_rules (id, action, network, created_by)
      values (${randomUUID()}, 'allow', '::1/128', ${egressAdminId})
    `).rejects.toThrow();

    if (created.outcome !== "CREATED") throw new Error("rule was not created");
    expect(
      await repository.deleteEgressRule({ ruleId: created.rule.id, validate: () => null, audit }),
    ).toEqual({ outcome: "DELETED", revision: start + 2 });
    expect(
      await repository.deleteEgressRule({ ruleId: created.rule.id, validate: () => null, audit }),
    ).toEqual({ outcome: "NOT_FOUND" });
    const ruleEvents = await database<Array<{ event_type: string; details: Record<string, unknown> }>>`
      select event_type, details from platform_audit_events
      where actor_user_id = ${egressAdminId} order by id asc
    `;
    expect(ruleEvents.map((event) => event.event_type)).toEqual([
      "egress.rule_created",
      "egress.rule_deleted",
    ]);
    expect(ruleEvents[0]?.details).toMatchObject({
      network: "10.77.0.0/16",
      revision: start + 1,
      requestId: audit.requestId,
    });

    const credentialHash = hashOpaqueToken(`egress-${suffix}-credential-token`);
    await repository.provisionWorkerWithGateway({
      workerId: egressWorkerId,
      credentialHash,
      gatewayBaseUrl: "http://127.0.0.1:18080",
    });
    expect(
      (await repository.listWorkers()).find((worker) => worker.id === egressWorkerId)?.egress,
    ).toEqual({ enforced: false, revision: null, checkedAt: null });
    const heartbeat = (enforced: boolean) =>
      repository.recordWorkerHeartbeat({
        credentialHash,
        workerId: egressWorkerId,
        allocatedWorkspaces: 1,
        egress: { enforced, revision: start + 2 },
        storage: STORAGE_ENFORCED,
        modelRelay: { enabled: false, port: null, listening: false },
        workspaceDisk: [],
        receivedAt: NOW,
      }).then((result) => result !== null);
    expect(await heartbeat(true)).toBe(true);
    const workspaceId = randomUUID();
    await database`
      insert into workspaces (id, user_id, name, worker_id, state, runtime_image)
      values (${workspaceId}, ${egressAdminId}, 'egress-running', ${egressWorkerId}, 'RUNNING', 'img')
    `;
    expect(await heartbeat(false)).toBe(true);
    expect(await heartbeat(false)).toBe(true);
    expect(await heartbeat(true)).toBe(true);

    const [workspace] = await database<Array<{ state: string }>>`
      select state from workspaces where id = ${workspaceId}
    `;
    expect(workspace?.state).toBe("ERROR");
    expect(
      (await repository.listWorkers()).find((worker) => worker.id === egressWorkerId)?.egress,
    ).toEqual({ enforced: true, revision: start + 2, checkedAt: NOW });
    const workerEvents = await database<Array<{ event_type: string }>>`
      select event_type from platform_audit_events
      where worker_id = ${egressWorkerId} and event_type like 'worker.egress_%'
      order by id asc
    `;
    expect(workerEvents.map((event) => event.event_type)).toEqual([
      "worker.egress_enforced",
      "worker.egress_unenforced",
      "worker.egress_enforced",
    ]);
  });
});

describeWithPostgres("Phase 15 login throttle PostgreSQL integration", () => {
  const userId = randomUUID();
  const suffix = randomUUID();
  let database!: DatabaseClient;
  const audit = {
    protocol: "LOCAL" as const,
    providerId: "local",
    requestId: "request",
    ipAddress: "198.51.100.1",
    userAgent: null,
  };
  const policy = { threshold: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };
  const keyHash = (label: string) =>
    createHash("sha256").update(`${suffix}:${label}`).digest("hex");

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    await createRepository(database, selectWorker).createUser({
      id: userId,
      email: `throttle-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-throttle-password"),
      role: "user",
    });
  });

  afterAll(async () => {
    await database`delete from platform_audit_events where owner_user_id = ${userId}`;
    await database`delete from auth_throttle where user_id = ${userId}`;
    await database`delete from users where id = ${userId}`;
    await database.end({ timeout: 5 });
  });

  it("counts concurrent failures exactly and records one lock event", async () => {
    const repository = createRepository(database, selectWorker);
    const hit = {
      scope: "login_ip" as const,
      keyHash: keyHash("concurrent"),
      policy,
      ipAddress: "198.51.100.1",
      userId,
    };
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        repository.recordAuthThrottleHits({ hits: [hit], now: NOW, audit }),
      ),
    );
    expect(results.flat()).toEqual(["login_ip"]);
    const [row] = await database<Array<{ failures: number; locked_until: Date }>>`
      select failures, locked_until from auth_throttle
      where scope = 'login_ip' and key_hash = ${hit.keyHash}
    `;
    expect(row?.failures).toBe(50);
    expect(row?.locked_until).toEqual(new Date(NOW.getTime() + policy.lockMs));
    const events = await database<Array<{ details: Record<string, unknown> }>>`
      select details from platform_audit_events
      where event_type = 'auth.login_locked' and owner_user_id = ${userId}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ scope: "login_ip", ipAddress: "198.51.100.1" });

    expect(await repository.findAuthLock([hit], NOW)).toEqual(row?.locked_until);
    const locks = await repository.listAuthLocks(NOW);
    expect(locks.find((lock) => lock.userId === userId)).toMatchObject({
      scope: "login_ip",
      ipAddress: "198.51.100.1",
      userEmail: `throttle-${suffix}@example.test`,
    });
  });

  it("matches the shared transition when windows and locks expire", async () => {
    const repository = createRepository(database, selectWorker);
    const hit = {
      scope: "ip" as const,
      keyHash: keyHash("expiry"),
      policy: { threshold: 2, windowMs: 60_000, lockMs: 120_000 },
      ipAddress: "198.51.100.2",
      userId: null,
    };
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    let state: AuthThrottleState | null = null;
    for (const offset of [0, 1_000, 61_000, 200_000, 200_500, 400_000, 400_500]) {
      await repository.recordAuthThrottleHits({ hits: [hit], now: at(offset), audit });
      state = nextAuthThrottleState(state, hit.policy, at(offset));
      const [row] = await database<
        Array<{ window_start: Date; failures: number; locked_until: Date | null }>
      >`
        select window_start, failures, locked_until from auth_throttle
        where scope = 'ip' and key_hash = ${hit.keyHash}
      `;
      expect({
        windowStart: row?.window_start,
        failures: row?.failures,
        lockedUntil: row?.locked_until,
      }).toEqual(state);
    }
    expect(
      await repository.clearAuthLocks({
        target: { kind: "keys", keys: [hit] },
        now: at(400_500),
        source: "cli",
        actorUserId: null,
        requestId: null,
      }),
    ).toBe(1);
    expect(await repository.findAuthLock([hit], at(400_500))).toBeNull();
    expect(await repository.deleteExpiredAuthThrottle(at(10 * 60 * 60_000), 60 * 60_000)).toBeGreaterThanOrEqual(0);
    await database`delete from platform_audit_events where event_type in ('auth.login_locked', 'auth.lock_cleared') and details->>'ipAddress' = '198.51.100.2'`;
  });
});

describeWithPostgres("Phase 15 storage PostgreSQL integration", () => {
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const suffix = randomUUID();
  const workerId = `storage-${suffix}`;
  const otherWorkerId = `storage-other-${suffix}`;
  const GIB = 1024 ** 3;
  let database!: DatabaseClient;

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    const repository = createRepository(database, selectWorker);
    for (const [id, role] of [[ownerId, "user"], [adminId, "admin"]] as const) {
      await repository.createUser({
        id,
        email: `${role}-${suffix}@example.test`,
        username: null,
        passwordHash: await hashPassword("integration-storage-password"),
        role,
      });
    }
  });

  afterAll(async () => {
    await database`delete from platform_audit_events where worker_id in (${workerId}, ${otherWorkerId}) or owner_user_id = ${ownerId}`;
    await database`delete from workspaces where user_id = ${ownerId}`;
    await database`delete from workers where id in (${workerId}, ${otherWorkerId})`;
    await database`delete from users where id in (${ownerId}, ${adminId})`;
    await database.end({ timeout: 5 });
  });

  it("stores limits, usage samples, Worker storage state and fails closed", async () => {
    const repository = createRepository(database, selectWorker);
    const credentialHash = hashOpaqueToken(`storage-${suffix}-credential-token`);
    for (const [id, hash] of [
      [workerId, credentialHash],
      [otherWorkerId, hashOpaqueToken(`storage-other-${suffix}-credential-token`)],
    ] as const) {
      await repository.provisionWorkerWithGateway({
        workerId: id,
        credentialHash: hash,
        gatewayBaseUrl: "http://127.0.0.1:18081",
      });
    }
    const own = await repository.createWorkspace({
      id: randomUUID(),
      userId: ownerId,
      name: "storage-own",
      runtimeImage: "img",
      diskLimitBytes: 7 * GIB,
    });
    const foreign = await repository.createWorkspace({
      id: randomUUID(),
      userId: ownerId,
      name: "storage-foreign",
      runtimeImage: "img",
      diskLimitBytes: 9 * GIB,
    });
    expect(own.disk).toEqual({
      limitBytes: 7 * GIB,
      usedBytes: null,
      usedInodes: null,
      piUsedBytes: null,
      piLimitBytes: null,
      sampledAt: null,
    });
    await database`update workspaces set worker_id = ${workerId}, state = 'RUNNING' where id = ${own.id}`;
    await database`update workspaces set worker_id = ${otherWorkerId}, state = 'RUNNING' where id = ${foreign.id}`;

    const sample = (workspaceId: string) => ({
      workspaceId,
      dataUsedBytes: 3 * GIB,
      dataLimitBytes: 7 * GIB,
      dataUsedInodes: 1234,
      piUsedBytes: 5_000,
      piLimitBytes: 2 * GIB,
    });
    const heartbeat = (enforced: boolean) =>
      repository.recordWorkerHeartbeat({
        credentialHash,
        workerId,
        allocatedWorkspaces: 1,
        egress: { enforced: true, revision: 0 },
        storage: { ...STORAGE_ENFORCED, enforced },
        modelRelay: { enabled: false, port: null, listening: false },
        workspaceDisk: [sample(own.id), sample(foreign.id)],
        receivedAt: NOW,
      });
    // A Worker cannot write usage for a Workspace assigned to another Worker.
    await expect(heartbeat(true)).resolves.toEqual({ ignoredDiskSamples: 1 });
    const listed = await repository.listManagedUserWorkspaces(ownerId);
    expect(listed?.find((workspace) => workspace.id === own.id)?.disk).toEqual({
      limitBytes: 7 * GIB,
      usedBytes: 3 * GIB,
      usedInodes: 1234,
      piUsedBytes: 5_000,
      piLimitBytes: 2 * GIB,
      sampledAt: NOW,
    });
    expect(listed?.find((workspace) => workspace.id === foreign.id)?.disk.usedBytes).toBeNull();

    const workers = await repository.listWorkersWithAssignments();
    expect(workers.find((worker) => worker.id === workerId)).toMatchObject({
      storage: { ...STORAGE_ENFORCED, checkedAt: NOW },
      allocatedDiskLimitBytes: 7 * GIB,
    });

    await heartbeat(false);
    const [state] = await database<Array<{ state: string }>>`
      select state from workspaces where id = ${own.id}
    `;
    expect(state?.state).toBe("ERROR");
    const flips = await database<Array<{ event_type: string }>>`
      select event_type from platform_audit_events
      where worker_id = ${workerId} and event_type like 'worker.storage_%'
      order by id asc
    `;
    expect(flips.map((event) => event.event_type)).toEqual([
      "worker.storage_enforced",
      "worker.storage_unenforced",
    ]);

    const changed = await repository.updateWorkspaceDiskLimit({
      workspaceId: own.id,
      diskLimitBytes: 11 * GIB,
      audit: { actorUserId: adminId, requestId: "request", ipAddress: "127.0.0.1", userAgent: null },
    });
    expect(changed).toMatchObject({
      outcome: "UPDATED",
      previousLimitBytes: 7 * GIB,
      workspace: { id: own.id, disk: { limitBytes: 11 * GIB } },
    });
    const [audit] = await database<Array<{ actor_user_id: string; details: Record<string, unknown> }>>`
      select actor_user_id, details from platform_audit_events
      where workspace_id = ${own.id} and event_type = 'workspace.storage_limit_changed'
    `;
    expect(audit).toMatchObject({
      actor_user_id: adminId,
      details: { previousLimitBytes: 7 * GIB, limitBytes: 11 * GIB },
    });
    await expect(
      repository.updateWorkspaceDiskLimit({
        workspaceId: randomUUID(),
        diskLimitBytes: GIB,
        audit: { actorUserId: adminId, requestId: "request", ipAddress: "127.0.0.1", userAgent: null },
      }),
    ).resolves.toEqual({ outcome: "NOT_FOUND" });
  });
});

describeWithPostgres("Phase 15 storage PostgreSQL integration", () => {
  const suffix = randomUUID();
  const adminId = randomUUID();
  const workerA = `storage-a-${suffix}`;
  const workerB = `storage-b-${suffix}`;
  const credentialA = hashOpaqueToken(`storage-a-${suffix}-credential-token`);
  const ownId = randomUUID();
  const foreignId = randomUUID();
  const GIB = 1024 ** 3;
  let database!: DatabaseClient;

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    const repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: adminId,
      email: `storage-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-storage-password"),
      role: "admin",
    });
    await repository.provisionWorkerWithGateway({
      workerId: workerA,
      credentialHash: credentialA,
      gatewayBaseUrl: "http://127.0.0.1:18081",
    });
    await repository.provisionWorkerWithGateway({
      workerId: workerB,
      credentialHash: hashOpaqueToken(`storage-b-${suffix}-credential-token`),
      gatewayBaseUrl: "http://127.0.0.1:18082",
    });
    for (const [id, workerId] of [
      [ownId, workerA],
      [foreignId, workerB],
    ] as const) {
      await database`
        insert into workspaces (id, user_id, name, worker_id, state, runtime_image, disk_limit_bytes)
        values (${id}, ${adminId}, ${`storage-${id.slice(0, 8)}`}, ${workerId}, 'RUNNING', 'img', ${10 * GIB})
      `;
    }
  });

  afterAll(async () => {
    await database`delete from platform_audit_events where worker_id in (${workerA}, ${workerB}) or actor_user_id = ${adminId} or owner_user_id = ${adminId}`;
    await database`delete from workspaces where user_id = ${adminId}`;
    await database`delete from workers where id in (${workerA}, ${workerB})`;
    await database`delete from users where id = ${adminId}`;
    await database.end({ timeout: 5 });
  });

  it("keeps usage for own Workspaces only and fails running ones closed when quotas stop", async () => {
    const repository = createRepository(database, selectWorker);
    const usage = (workspaceId: string) => ({
      workspaceId,
      dataUsedBytes: 3 * GIB,
      dataLimitBytes: 10 * GIB,
      dataUsedInodes: 77,
      piUsedBytes: 5_000,
      piLimitBytes: 2 * GIB,
    });
    const heartbeat = (enforced: boolean) =>
      repository.recordWorkerHeartbeat({
        credentialHash: credentialA,
        workerId: workerA,
        allocatedWorkspaces: 1,
        egress: { enforced: true, revision: 0 },
        storage: { enforced, fsType: "xfs", totalBytes: 100 * GIB, freeBytes: 60 * GIB },
        modelRelay: { enabled: false, port: null, listening: false },
        workspaceDisk: [usage(ownId), usage(foreignId)],
        receivedAt: NOW,
      });
    await expect(heartbeat(true)).resolves.toEqual({ ignoredDiskSamples: 1 });
    const workspaces = await repository.listAllWorkspaces();
    expect(workspaces.find((entry) => entry.id === ownId)?.disk).toEqual({
      limitBytes: 10 * GIB,
      usedBytes: 3 * GIB,
      usedInodes: 77,
      piUsedBytes: 5_000,
      piLimitBytes: 2 * GIB,
      sampledAt: NOW,
    });
    expect(workspaces.find((entry) => entry.id === foreignId)?.disk.usedBytes).toBeNull();

    const placement = (await repository.listWorkersWithAssignments()).find(
      (worker) => worker.id === workerA,
    );
    expect(placement).toMatchObject({
      allocatedDiskLimitBytes: 10 * GIB,
      storage: { enforced: true, fsType: "xfs", totalBytes: 100 * GIB, freeBytes: 60 * GIB, checkedAt: NOW },
    });

    await heartbeat(false);
    await heartbeat(false);
    const [own] = await database<Array<{ state: string }>>`select state from workspaces where id = ${ownId}`;
    const [foreign] = await database<Array<{ state: string }>>`select state from workspaces where id = ${foreignId}`;
    expect(own?.state).toBe("ERROR");
    expect(foreign?.state).toBe("RUNNING");
    const flips = await database<Array<{ event_type: string }>>`
      select event_type from platform_audit_events
      where worker_id = ${workerA} and event_type like 'worker.storage_%' order by id asc
    `;
    expect(flips.map((event) => event.event_type)).toEqual([
      "worker.storage_enforced",
      "worker.storage_unenforced",
    ]);
  });

  it("changes a disk limit with an Audit event", async () => {
    const repository = createRepository(database, selectWorker);
    const result = await repository.updateWorkspaceDiskLimit({
      workspaceId: ownId,
      diskLimitBytes: 50 * GIB,
      audit: { actorUserId: adminId, requestId: "request", ipAddress: "127.0.0.1", userAgent: null },
    });
    expect(result).toMatchObject({
      outcome: "UPDATED",
      previousLimitBytes: 10 * GIB,
      workspace: { id: ownId, disk: { limitBytes: 50 * GIB } },
    });
    const [event] = await database<Array<{ owner_user_id: string; worker_id: string; details: Record<string, unknown> }>>`
      select owner_user_id, worker_id, details from platform_audit_events
      where event_type = 'workspace.storage_limit_changed' and workspace_id = ${ownId}
    `;
    expect(event).toMatchObject({
      owner_user_id: adminId,
      worker_id: workerA,
      details: { previousLimitBytes: 10 * GIB, limitBytes: 50 * GIB, requestId: "request" },
    });
    expect(
      await repository.updateWorkspaceDiskLimit({
        workspaceId: randomUUID(),
        diskLimitBytes: 50 * GIB,
        audit: { actorUserId: adminId, requestId: "request", ipAddress: "127.0.0.1", userAgent: null },
      }),
    ).toEqual({ outcome: "NOT_FOUND" });
    await expect(database`
      update workspaces set disk_limit_bytes = 0 where id = ${ownId}
    `).rejects.toThrow();
  });
});
