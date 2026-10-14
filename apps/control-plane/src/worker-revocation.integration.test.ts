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

describeWithPostgres("Phase 18 Worker revocation PostgreSQL integration", () => {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = randomUUID();
  const workerIds: string[] = [];
  let database!: DatabaseClient;
  let repository!: ReturnType<typeof createRepository>;

  async function provisionWorker(status: "ONLINE" | "OFFLINE" = "ONLINE") {
    const workerId = `revoke-${suffix}-${workerIds.length}`;
    workerIds.push(workerId);
    await repository.provisionWorkerWithGateway({
      workerId,
      credentialHash: hashOpaqueToken(`${workerId}-credential-token`),
      gatewayBaseUrl: "http://127.0.0.1:18082",
    });
    await database`
      update workers
      set status = ${status}, model_relay_enabled = true, last_heartbeat_at = now()
      where id = ${workerId}
    `;
    return workerId;
  }

  async function workspaceOn(workerId: string, state: string) {
    const workspace = await repository.createWorkspace({
      id: randomUUID(),
      userId: ownerId,
      name: `revoke-${randomUUID().slice(0, 8)}`,
      runtimeImage: "img",
      diskLimitBytes: 20 * GIB,
    });
    await database`update workspaces set worker_id = ${workerId}, state = ${state} where id = ${workspace.id}`;
    return workspace.id;
  }

  async function liveKey(workspaceId: string) {
    const begun = await repository.beginModelKeyIssue({ workspaceId, issueReason: "start" });
    if (begun.outcome !== "ISSUING") throw new Error(`expected ISSUING, got ${begun.outcome}`);
    expect(await repository.activateModelKey(begun.key.id)).toBe(true);
    return begun.key.keyAlias;
  }

  async function states(workerId: string) {
    const rows = await database<Array<{ state: string }>>`
      select state from workspaces where worker_id = ${workerId} order by state
    `;
    return rows.map((row) => row.state);
  }

  async function worker(workerId: string) {
    const rows = await database<Array<{ status: string; enabled: boolean }>>`
      select status, enabled from workers where id = ${workerId}
    `;
    return rows[0];
  }

  async function auditEvents(workerId: string) {
    return database<Array<{ event_type: string; details: Record<string, unknown> }>>`
      select event_type, details from platform_audit_events
      where worker_id = ${workerId} and event_type like 'worker.%'
      order by id
    `;
  }

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    repository = createRepository(database, selectWorker);
    await repository.createUser({
      id: ownerId,
      email: `revoke-${ownerId}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-revoke-password"),
      role: "user",
    });
  });

  afterAll(async () => {
    await database`delete from model_keys where user_id = ${ownerId}`;
    await database`delete from workspaces where user_id = ${ownerId}`;
    await database`delete from workers where id = any(${workerIds})`;
    await database`delete from platform_audit_events where owner_user_id = ${ownerId} or worker_id = any(${workerIds})`;
    await database`delete from users where id = ${ownerId}`;
    await database.end({ timeout: 5 });
  });

  it("worker:disable takes the Worker's Workspaces offline and revokes their model keys", async () => {
    const workerId = await provisionWorker();
    const other = await provisionWorker();
    const running = await workspaceOn(workerId, "RUNNING");
    const stopped = await workspaceOn(workerId, "STOPPED");
    const elsewhere = await workspaceOn(other, "RUNNING");
    const runningKey = await liveKey(running);
    const elsewhereKey = await liveKey(elsewhere);

    const result = await repository.disableWorker(workerId);

    expect(result).toEqual({ outcome: "DISABLED", workspaces: 2, modelKeys: 1 });
    expect(await worker(workerId)).toEqual({ status: "DISABLED", enabled: false });
    expect(await states(workerId)).toEqual(["WORKER_OFFLINE", "WORKER_OFFLINE"]);
    expect(await states(other)).toEqual(["RUNNING"]);
    const keys = await database<Array<{ key_alias: string; status: string; revoke_reason: string | null }>>`
      select key_alias, status, revoke_reason from model_keys
      where key_alias in (${runningKey}, ${elsewhereKey})
      order by key_alias = ${runningKey} desc
    `;
    expect(keys).toEqual([
      { key_alias: runningKey, status: "revoking", revoke_reason: "worker_disabled" },
      { key_alias: elsewhereKey, status: "active", revoke_reason: null },
    ]);
    const events = await auditEvents(workerId);
    expect(events.filter((event) => event.event_type === "worker.disabled")).toEqual([
      {
        event_type: "worker.disabled",
        details: { source: "cli", fromStatus: "ONLINE", workspaces: 2, modelKeys: 1 },
      },
    ]);
    expect(stopped).toBeTypeOf("string");

    expect(await repository.disableWorker(workerId)).toEqual({ outcome: "ALREADY_DISABLED" });
    expect(await repository.disableWorker(`missing-${suffix}`)).toEqual({ outcome: "NOT_FOUND" });
    expect(await repository.listRevokedWorkerAssignments()).toContainEqual({
      workerId,
      workspaceIds: expect.arrayContaining([running, stopped]) as unknown as string[],
    });
  });

  it("applies the same consequences when enabled is changed directly in SQL", async () => {
    const workerId = await provisionWorker();
    const workspaceId = await workspaceOn(workerId, "RUNNING");
    const keyAlias = await liveKey(workspaceId);

    await database`update workers set enabled = false where id = ${workerId}`;

    expect(await worker(workerId)).toEqual({ status: "DISABLED", enabled: false });
    expect(await states(workerId)).toEqual(["WORKER_OFFLINE"]);
    const keys = await database<Array<{ status: string; revoke_reason: string }>>`
      select status, revoke_reason from model_keys where key_alias = ${keyAlias}
    `;
    expect(keys).toEqual([{ status: "revoking", revoke_reason: "worker_disabled" }]);
    const disabled = (await auditEvents(workerId)).filter(
      (event) => event.event_type === "worker.disabled",
    );
    expect(disabled).toHaveLength(1);
    expect(disabled[0]?.details.source).toBe("database");
  });

  it("never lets a disabled Worker be anything but DISABLED", async () => {
    const workerId = await provisionWorker();
    await repository.disableWorker(workerId);

    await expect(
      database`update workers set status = 'ONLINE' where id = ${workerId}`,
    ).rejects.toThrow(/workers_enabled_status/);
    const enabled = await provisionWorker();
    await expect(
      database`update workers set status = 'DISABLED' where id = ${enabled}`,
    ).rejects.toThrow(/workers_enabled_status/);
  });

  it("worker:enable requires a new credential and reconnects through reconciliation", async () => {
    const workerId = await provisionWorker();
    await workspaceOn(workerId, "RUNNING");
    const oldHash = hashOpaqueToken(`${workerId}-credential-token`);
    await repository.disableWorker(workerId);

    expect(
      await repository.enableWorker({ workerId, credentialHash: hashOpaqueToken(`${workerId}-new`) }),
    ).toBe("ENABLED");

    expect(await worker(workerId)).toEqual({ status: "OFFLINE", enabled: true });
    expect(await repository.findWorkerByCredentialHash(oldHash)).toBeNull();
    expect(await repository.findWorkerByCredentialHash(hashOpaqueToken(`${workerId}-new`))).toEqual({
      workerId,
      enabled: true,
    });
    // Workspaces stay offline until the Worker's own reconciliation recovers them.
    expect(await states(workerId)).toEqual(["WORKER_OFFLINE"]);
    const events = (await auditEvents(workerId)).map((event) => event.event_type);
    expect(events).toContain("worker.enabled");
    expect(events).not.toContain("worker.offline");
    expect(
      await repository.enableWorker({ workerId, credentialHash: hashOpaqueToken(`${workerId}-again`) }),
    ).toBe("ALREADY_ENABLED");
  });

  it("worker:delete only removes a disabled Worker without Workspaces, and audits it", async () => {
    const empty = await provisionWorker("OFFLINE");
    const busy = await provisionWorker("OFFLINE");
    await workspaceOn(busy, "STOPPED");

    expect(await repository.deleteWorker(empty)).toEqual({ outcome: "ENABLED" });
    await repository.disableWorker(empty);
    await repository.disableWorker(busy);
    expect(await repository.deleteWorker(busy)).toEqual({ outcome: "HAS_WORKSPACES", workspaces: 1 });
    expect(await repository.deleteWorker(empty)).toEqual({ outcome: "DELETED" });
    expect(await repository.deleteWorker(empty)).toEqual({ outcome: "NOT_FOUND" });

    expect(await worker(empty)).toBeUndefined();
    const deleted = (await auditEvents(empty)).filter((event) => event.event_type === "worker.deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.details.source).toBe("cli");
  });

  it("worker:rotate takes the Worker's Workspaces offline with it", async () => {
    const workerId = await provisionWorker();
    await workspaceOn(workerId, "RUNNING");
    await workspaceOn(workerId, "STOPPED");

    expect(
      await repository.rotateWorkerCredential({
        workerId,
        credentialHash: hashOpaqueToken(`${workerId}-rotated`),
      }),
    ).toBe(true);

    expect(await worker(workerId)).toEqual({ status: "OFFLINE", enabled: true });
    expect(await states(workerId)).toEqual(["WORKER_OFFLINE", "WORKER_OFFLINE"]);
  });
});
