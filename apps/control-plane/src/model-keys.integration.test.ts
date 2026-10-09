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

describeWithPostgres("Phase 16 model key PostgreSQL integration", () => {
  const suffix = randomUUID();
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const adminId = randomUUID();
  const workerId = `model-${suffix}`;
  let database!: DatabaseClient;
  let repository!: ReturnType<typeof createRepository>;

  async function runningWorkspace(userId = ownerId) {
    const workspace = await repository.createWorkspace({
      id: randomUUID(),
      userId,
      name: `model-${randomUUID().slice(0, 8)}`,
      runtimeImage: "img",
      diskLimitBytes: 20 * GIB,
    });
    await database`update workspaces set worker_id = ${workerId}, state = 'RUNNING' where id = ${workspace.id}`;
    return workspace.id;
  }

  async function keyRows(workspaceId: string) {
    return database<Array<{ key_alias: string; status: string; revoke_reason: string | null }>>`
      select key_alias, status, revoke_reason from model_keys
      where key_alias like ${`arw-${workspaceId}-%`}
      order by created_at, key_alias
    `;
  }

  async function issue(workspaceId: string) {
    const begun = await repository.beginModelKeyIssue({ workspaceId, issueReason: "start" });
    if (begun.outcome !== "ISSUING") throw new Error(`expected ISSUING, got ${begun.outcome}`);
    expect(await repository.activateModelKey(begun.key.id)).toBe(true);
    return begun.key;
  }

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    repository = createRepository(database, selectWorker);
    for (const [id, role] of [
      [ownerId, "user"],
      [otherOwnerId, "user"],
      [adminId, "admin"],
    ] as const) {
      await repository.createUser({
        id,
        email: `model-${id}@example.test`,
        username: null,
        passwordHash: await hashPassword("integration-model-password"),
        role,
      });
    }
    await repository.provisionWorkerWithGateway({
      workerId,
      credentialHash: hashOpaqueToken(`model-${suffix}-credential-token`),
      gatewayBaseUrl: "http://127.0.0.1:18081",
    });
    await database`update workers set model_relay_enabled = true where id = ${workerId}`;
  });

  afterAll(async () => {
    await database`delete from model_keys where user_id in (${ownerId}, ${otherOwnerId})`;
    await database`delete from platform_audit_events where owner_user_id in (${ownerId}, ${otherOwnerId}) or actor_user_id = ${adminId} or worker_id = ${workerId}`;
    await database`delete from workspaces where user_id in (${ownerId}, ${otherOwnerId})`;
    await database`delete from workers where id = ${workerId}`;
    await database`delete from users where id in (${ownerId}, ${otherOwnerId}, ${adminId})`;
    await database.end({ timeout: 5 });
  });

  it("issues one live key per Workspace with increasing aliases and audits it", async () => {
    const workspaceId = await runningWorkspace();
    const first = await issue(workspaceId);
    expect(first.keyAlias).toBe(`arw-${workspaceId}-1`);
    expect(first.workerId).toBe(workerId);
    await expect(repository.beginModelKeyIssue({ workspaceId, issueReason: "start" })).resolves.toEqual({
      outcome: "ALREADY_LIVE",
      keyAlias: first.keyAlias,
      status: "active",
    });
    await expect(
      database`insert into model_keys (id, workspace_id, user_id, key_alias, status, issue_reason)
               values (${randomUUID()}, ${workspaceId}, ${ownerId}, ${`arw-${workspaceId}-9`}, 'active', 'start')`,
    ).rejects.toThrow();

    await repository.requestModelKeyRevoke({ workspaceId, reason: "admin", actorUserId: adminId, requestId: randomUUID() });
    const second = await issue(workspaceId);
    expect(second.keyAlias).toBe(`arw-${workspaceId}-2`);
    const events = await database<Array<{ event_type: string; actor_user_id: string | null; details: Record<string, unknown> }>>`
      select event_type, actor_user_id, details from platform_audit_events
      where workspace_id = ${workspaceId} and event_type like 'model.%' order by id
    `;
    expect(events.map((event) => event.event_type)).toEqual([
      "model.key_issued",
      "model.key_revoke_requested",
      "model.key_issued",
    ]);
    expect(events[1]).toMatchObject({ actor_user_id: adminId, details: { reason: "admin", keyAlias: first.keyAlias } });
    expect(JSON.stringify(events)).not.toMatch(/sk-/);
    const filtered = await repository.listAuditEvents({
      userId: adminId,
      includeAllUsers: true,
      limit: 100,
      beforeId: null,
      filter: { category: "model", workspaceId },
    });
    expect(filtered.map((event) => event.eventType)).toEqual([
      "model.key_issued",
      "model.key_revoke_requested",
      "model.key_issued",
    ].reverse());
  });

  it("issues no key for a Worker without a relay and reports per-Workspace state", async () => {
    const workspaceId = await runningWorkspace();
    await database`update workers set model_relay_enabled = false where id = ${workerId}`;
    try {
      await expect(repository.beginModelKeyIssue({ workspaceId, issueReason: "start" })).resolves.toEqual({
        outcome: "RELAY_DISABLED",
      });
      await expect(repository.listWorkspaceModelKeyStates([workspaceId])).resolves.toEqual([
        { workspaceId, keyStatus: null, relayEnabled: false },
      ]);
    } finally {
      await database`update workers set model_relay_enabled = true where id = ${workerId}`;
    }
    await issue(workspaceId);
    await expect(repository.listWorkspaceModelKeyStates([workspaceId])).resolves.toEqual([
      { workspaceId, keyStatus: "active", relayEnabled: true },
    ]);
  });

  it("lets exactly one of many concurrent issues for a Workspace win", async () => {
    const workspaceId = await runningWorkspace();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repository.beginModelKeyIssue({ workspaceId, issueReason: "start" })),
    );
    expect(results.filter((result) => result.outcome === "ISSUING")).toHaveLength(1);
    expect(results.every((result) => result.outcome === "ISSUING" || result.outcome === "ALREADY_LIVE")).toBe(true);
    expect((await keyRows(workspaceId)).map((row) => row.status)).toEqual(["issuing"]);
  });

  it("revokes every key of a user disabled by any path, and refuses to issue while disabled", async () => {
    const first = await runningWorkspace(otherOwnerId);
    const second = await runningWorkspace(otherOwnerId);
    await issue(first);
    const pending = await repository.beginModelKeyIssue({ workspaceId: second, issueReason: "start" });
    expect(pending.outcome).toBe("ISSUING");

    // Not through updateManagedUser: the trigger covers every way the status changes.
    await database`update users set status = 'disabled' where id = ${otherOwnerId}`;
    expect((await keyRows(first)).map((row) => [row.status, row.revoke_reason])).toEqual([["revoking", "user_disabled"]]);
    expect((await keyRows(second)).map((row) => row.status)).toEqual(["revoking"]);
    // The gateway call for `second` finished after the disable: it must not become usable.
    if (pending.outcome === "ISSUING") {
      await expect(repository.activateModelKey(pending.key.id)).resolves.toBe(false);
    }
    await expect(repository.beginModelKeyIssue({ workspaceId: first, issueReason: "reissue" })).resolves.toEqual({
      outcome: "USER_DISABLED",
    });
    await expect(repository.listWorkspacesNeedingModelKey(100)).resolves.not.toContainEqual(
      expect.objectContaining({ workspaceId: first }),
    );

    await database`update users set status = 'active' where id = ${otherOwnerId}`;
    await expect(repository.beginModelKeyIssue({ workspaceId: first, issueReason: "reissue" })).resolves.toMatchObject({
      outcome: "ISSUING",
    });
  });

  it("revokes a Workspace's key on every delete path and never leaves a live key without a Workspace", async () => {
    const lifecycle = await runningWorkspace();
    await issue(lifecycle);
    await expect(
      repository.beginWorkspaceDelete({ workspaceId: lifecycle, userId: ownerId, workerId }),
    ).resolves.toBe(true);
    expect((await keyRows(lifecycle))[0]).toMatchObject({ status: "revoking", revoke_reason: "workspace_deleted" });
    await expect(repository.beginModelKeyIssue({ workspaceId: lifecycle, issueReason: "start" })).resolves.toEqual({
      outcome: "WORKSPACE_UNAVAILABLE",
    });

    const direct = await runningWorkspace();
    const key = await issue(direct);
    await database`delete from workspaces where id = ${direct}`;
    const rows = await database<Array<{ workspace_id: string | null; status: string }>>`
      select workspace_id, status from model_keys where key_alias = ${key.keyAlias}
    `;
    expect(rows).toEqual([{ workspace_id: null, status: "revoking" }]);
    const due = await repository.listDueModelKeyRevocations(new Date(Date.now() + 1_000), 1_000);
    expect(due).toContainEqual(
      expect.objectContaining({ keyAlias: key.keyAlias, workspaceId: null, workerId: null, reason: "workspace_deleted" }),
    );
  });

  it("marks a key revoked only after a confirmed gateway deletion and backs off failures", async () => {
    const workspaceId = await runningWorkspace();
    const key = await issue(workspaceId);
    await repository.requestModelKeyRevoke({ keyIds: [key.id], reason: "lost" });
    await repository.recordModelKeyRevokeResult(key.id, { ok: false, errorCode: "MODEL_GATEWAY_UNAVAILABLE" });
    const [failed] = await database<Array<{ status: string; revoke_attempts: number; delay: number; last_error_code: string }>>`
      select status, revoke_attempts, extract(epoch from next_attempt_at - now())::int as delay, last_error_code
      from model_keys where id = ${key.id}
    `;
    expect(failed).toMatchObject({ status: "revoking", revoke_attempts: 1, last_error_code: "MODEL_GATEWAY_UNAVAILABLE" });
    expect(failed?.delay).toBeGreaterThanOrEqual(25);
    expect(failed?.delay).toBeLessThanOrEqual(31);
    await expect(repository.listDueModelKeyRevocations(new Date(), 1_000)).resolves.not.toContainEqual(
      expect.objectContaining({ id: key.id }),
    );
    const overview = await repository.modelKeyOverview();
    expect(overview.pendingRevocations).toBeGreaterThanOrEqual(1);

    await repository.recordModelKeyRevokeResult(key.id, { ok: true });
    const [done] = await database<Array<{ status: string }>>`select status from model_keys where id = ${key.id}`;
    expect(done?.status).toBe("revoked");
    const revoked = await database<Array<{ count: number }>>`
      select count(*)::int as count from platform_audit_events
      where event_type = 'model.key_revoked' and details->>'keyAlias' = ${key.keyAlias}
    `;
    expect(revoked[0]?.count).toBe(1);
  });

  it("finds running Workspaces without a key only on Workers with a listening relay", async () => {
    const workspaceId = await runningWorkspace();
    await expect(repository.listWorkspacesNeedingModelKey(1_000)).resolves.not.toContainEqual(
      expect.objectContaining({ workspaceId }),
    );
    await database`
      update workers set status = 'ONLINE', model_relay_enabled = true, model_relay_listening = true, model_relay_port = 3101
      where id = ${workerId}
    `;
    await expect(repository.listWorkspacesNeedingModelKey(1_000)).resolves.toContainEqual({ workspaceId, workerId });
    await issue(workspaceId);
    await expect(repository.listWorkspacesNeedingModelKey(1_000)).resolves.not.toContainEqual(
      expect.objectContaining({ workspaceId }),
    );
    await expect(repository.listActiveModelKeysForWorker(workerId)).resolves.toContainEqual(
      expect.objectContaining({ workspaceId, keyAlias: `arw-${workspaceId}-1` }),
    );
    await database`update workers set status = 'OFFLINE' where id = ${workerId}`;
  });

  it("expires interrupted issues and records budget changes", async () => {
    const workspaceId = await runningWorkspace();
    const begun = await repository.beginModelKeyIssue({ workspaceId, issueReason: "start" });
    expect(begun.outcome).toBe("ISSUING");
    await expect(repository.expireStaleModelKeyIssues(new Date(Date.now() + 60_000))).resolves.toBeGreaterThanOrEqual(1);
    expect((await keyRows(workspaceId))[0]).toMatchObject({ status: "revoking", revoke_reason: "issue_failed" });

    await expect(repository.findUserModelBudget(ownerId)).resolves.toEqual({ found: true, budgetUsd: null });
    await expect(
      repository.setUserModelBudget({ userId: ownerId, budgetUsd: 12.5, actorUserId: adminId, requestId: randomUUID() }),
    ).resolves.toEqual({ found: true, previousUsd: null });
    await expect(repository.findUserModelBudget(ownerId)).resolves.toEqual({ found: true, budgetUsd: 12.5 });
    await expect(
      database`update users set model_budget_usd = -1 where id = ${ownerId}`,
    ).rejects.toThrow();
    const [event] = await database<Array<{ details: Record<string, unknown> }>>`
      select details from platform_audit_events where event_type = 'model.budget_changed' and owner_user_id = ${ownerId}
    `;
    expect(event?.details).toMatchObject({ fromUsd: null, toUsd: 12.5 });
  });
});
