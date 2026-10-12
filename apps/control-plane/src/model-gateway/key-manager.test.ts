import type { ModelKeyRevokeReason } from "@agent-runtime/database";
import type { ControlToWorkerMessage, ModelGatewayConfig } from "@agent-runtime/protocol";
import { describe, expect, it, vi } from "vitest";

import { WorkerChannel } from "../worker-channel.js";
import { ModelGatewayError, type ModelGatewayAdmin } from "./admin-client.js";
import { ModelKeyManager, type ModelKeyStore } from "./key-manager.js";

const WORKSPACE = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const OTHER = "a1b2c3d4-aa9a-4bc6-8eee-528b4e0c7c60";
const USER = "5d9f1c2e-1f53-4c55-8a38-9a0f8f2f0d01";
const WORKER = "worker-01";
const SECRET = "sk-generated-virtual-key";
const CATALOG: ModelGatewayConfig = {
  providerId: "platform",
  defaultModel: "deepseek-v4-flash",
  models: [
    { id: "deepseek-v4-flash", api: "openai-completions" },
    { id: "mimo-v2.5-pro", api: "openai-completions" },
  ],
};

interface Row {
  id: string;
  workspaceId: string | null;
  userId: string;
  keyAlias: string;
  status: "issuing" | "active" | "revoking" | "revoked";
  reason: ModelKeyRevokeReason | null;
  actor: string | null;
  attempts: number;
  lastError: string | null;
}

/** The repository semantics the manager relies on (the real ones run on PostgreSQL). */
class MemoryStore implements ModelKeyStore {
  rows: Row[] = [];
  userActive = true;
  relayEnabled = true;
  running = new Set<string>([WORKSPACE]);
  budget: number | null = null;
  /** Simulates a disable that commits while the gateway call is in flight. */
  revokeBeforeActivate = false;

  async beginModelKeyIssue({ workspaceId }: { workspaceId: string }) {
    if (!this.userActive) return { outcome: "USER_DISABLED" as const };
    if (!this.relayEnabled) return { outcome: "RELAY_DISABLED" as const };
    const live = this.rows.find((row) => row.workspaceId === workspaceId && (row.status === "issuing" || row.status === "active"));
    if (live !== undefined) {
      return { outcome: "ALREADY_LIVE" as const, keyAlias: live.keyAlias, status: live.status as "issuing" | "active" };
    }
    const sequence = this.rows.filter((row) => row.keyAlias.startsWith(`arw-${workspaceId}-`)).length + 1;
    const row: Row = {
      id: `key-${this.rows.length + 1}`,
      workspaceId,
      userId: USER,
      keyAlias: `arw-${workspaceId}-${sequence}`,
      status: "issuing",
      reason: null,
      actor: null,
      attempts: 0,
      lastError: null,
    };
    this.rows.push(row);
    return { outcome: "ISSUING" as const, key: { id: row.id, workspaceId, userId: USER, keyAlias: row.keyAlias, workerId: WORKER } };
  }

  async activateModelKey(id: string) {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (this.revokeBeforeActivate && row !== undefined) {
      row.status = "revoking";
      row.reason = "user_disabled";
    }
    if (row?.status !== "issuing") return false;
    row.status = "active";
    return true;
  }

  async requestModelKeyRevoke(input: {
    keyIds?: readonly string[];
    workspaceId?: string;
    userId?: string;
    reason: ModelKeyRevokeReason;
    errorCode?: string | null;
    actorUserId?: string | null;
  }) {
    let count = 0;
    for (const row of this.rows) {
      if (row.status !== "issuing" && row.status !== "active") continue;
      if (input.keyIds !== undefined && !input.keyIds.includes(row.id)) continue;
      if (input.workspaceId !== undefined && row.workspaceId !== input.workspaceId) continue;
      if (input.userId !== undefined && row.userId !== input.userId) continue;
      row.status = "revoking";
      row.reason = input.reason;
      row.actor = input.actorUserId ?? null;
      row.lastError = input.errorCode ?? null;
      count += 1;
    }
    return count;
  }

  async listDueModelKeyRevocations() {
    return this.rows
      .filter((row) => row.status === "revoking")
      .map((row) => ({
        id: row.id,
        keyAlias: row.keyAlias,
        userId: row.userId,
        workspaceId: row.workspaceId,
        workerId: row.workspaceId === null ? null : WORKER,
        reason: row.reason ?? "admin",
        attempts: row.attempts,
      }));
  }

  async recordModelKeyRevokeResult(id: string, result: { ok: true } | { ok: false; errorCode: string }) {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined) return;
    if (result.ok) row.status = "revoked";
    else {
      row.attempts += 1;
      row.lastError = result.errorCode;
    }
  }

  async findLiveModelKey() {
    return null;
  }

  async listActiveModelKeysForWorker() {
    return this.rows
      .filter((row) => row.status === "active" && row.workspaceId !== null)
      .map((row) => ({ id: row.id, workspaceId: row.workspaceId ?? "", keyAlias: row.keyAlias }));
  }

  async listWorkspacesNeedingModelKey() {
    if (!this.userActive) return [];
    return [...this.running]
      .filter((id) => !this.rows.some((row) => row.workspaceId === id && (row.status === "issuing" || row.status === "active")))
      .map((workspaceId) => ({ workspaceId, workerId: WORKER }));
  }

  async expireStaleModelKeyIssues() {
    return 0;
  }

  async modelKeyOverview() {
    return {
      pendingRevocations: this.rows.filter((row) => row.status === "revoking").length,
      oldestPendingAt: null,
      lastErrorCode: null,
      activeKeys: this.rows.filter((row) => row.status === "active").length,
    };
  }

  async findUserModelBudget() {
    return { found: true, budgetUsd: this.budget };
  }

  async listWorkspaceModelKeyStates(ids: readonly string[]) {
    return ids.map((workspaceId) => {
      const live = this.rows.find((row) => row.workspaceId === workspaceId && (row.status === "issuing" || row.status === "active"));
      return {
        workspaceId,
        keyStatus: (live?.status ?? null) as "issuing" | "active" | null,
        relayEnabled: this.relayEnabled,
      };
    });
  }
}

class FakeAdmin implements ModelGatewayAdmin {
  readonly generated: Array<{ keyAlias: string; models: readonly string[] }> = [];
  readonly users: Array<{ userId: string; maxBudgetUsd: number | null }> = [];
  readonly deleted: string[] = [];
  down = false;

  async ensureUser(userId: string, budget: { maxBudgetUsd: number | null }) {
    if (this.down) throw new ModelGatewayError("MODEL_GATEWAY_UNAVAILABLE", null);
    this.users.push({ userId, maxBudgetUsd: budget.maxBudgetUsd });
  }

  async generateKey(input: { keyAlias: string; models: readonly string[] }) {
    if (this.down) throw new ModelGatewayError("MODEL_GATEWAY_UNAVAILABLE", null);
    this.generated.push({ keyAlias: input.keyAlias, models: input.models });
    return SECRET;
  }

  async deleteKey(keyAlias: string) {
    if (this.down) throw new ModelGatewayError("MODEL_GATEWAY_UNAVAILABLE", null);
    this.deleted.push(keyAlias);
  }

  async listModels() {
    if (this.down) throw new ModelGatewayError("MODEL_GATEWAY_UNAVAILABLE", null);
    return ["deepseek-v4-flash"];
  }

  async userUsage() {
    if (this.down) throw new ModelGatewayError("MODEL_GATEWAY_UNAVAILABLE", null);
    return { spendUsd: 1.25, maxBudgetUsd: 10, budgetResetAt: "2026-11-01T00:00:00Z" };
  }
}

/** A Worker that holds keys and answers model key commands like the real daemon. */
class FakeWorker {
  readyState = 1;
  readonly held = new Map<string, string>();
  readonly commands: ControlToWorkerMessage[] = [];
  readonly raw: string[] = [];

  constructor(readonly channel: WorkerChannel) {}

  send(data: string): void {
    this.raw.push(data);
    const message = JSON.parse(data) as ControlToWorkerMessage;
    this.commands.push(message);
    queueMicrotask(() => {
      if (message.type === "workspace.model_key.set") {
        this.held.set(message.payload.workspaceId, message.payload.keyAlias);
      } else if (message.type === "workspace.model_key.clear") {
        if (this.held.get(message.payload.workspaceId) === message.payload.keyAlias) {
          this.held.delete(message.payload.workspaceId);
        }
      } else {
        return;
      }
      this.channel.acceptResponse(WORKER, {
        version: 6,
        type: "response.ok",
        requestId: message.requestId,
        payload: {
          requestType: message.type,
          modelKey: {
            workspaceId: message.payload.workspaceId,
            keyAlias: this.held.get(message.payload.workspaceId) ?? null,
          },
        },
      });
    });
  }

  close(): void {
    this.readyState = 3;
  }
}

function setup(options: { connected?: boolean } = {}) {
  const store = new MemoryStore();
  const admin = new FakeAdmin();
  const channel = new WorkerChannel(1_000);
  const worker = new FakeWorker(channel);
  if (options.connected !== false) channel.register(WORKER, worker);
  const warn = vi.fn();
  const manager = new ModelKeyManager({
    store,
    admin,
    channel,
    catalog: CATALOG,
    policy: { defaultBudgetUsd: 20, budgetDuration: "30d", rpmLimit: 60, tpmLimit: null },
    log: { info: vi.fn(), warn },
  });
  return { store, admin, channel, worker, manager, warn };
}

describe("model key manager (Phase 16.6)", () => {
  it("issues a key for the catalog models with the user's budget and hands it to the Worker", async () => {
    const { store, admin, worker, manager, warn } = setup();
    store.budget = 5;
    await expect(manager.ensureWorkspaceKey(WORKSPACE)).resolves.toBe("available");
    expect(admin.users).toEqual([{ userId: USER, maxBudgetUsd: 5 }]);
    expect(admin.generated).toEqual([
      { keyAlias: `arw-${WORKSPACE}-1`, models: ["deepseek-v4-flash", "mimo-v2.5-pro"] },
    ]);
    expect(worker.held.get(WORKSPACE)).toBe(`arw-${WORKSPACE}-1`);
    expect(store.rows[0]?.status).toBe("active");
    // Exactly one message carried the secret, to the Worker; logs never do.
    expect(worker.raw.filter((data) => data.includes(SECRET))).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    await expect(manager.ensureWorkspaceKey(WORKSPACE)).resolves.toBe("available");
    expect(admin.generated).toHaveLength(1);
  });

  it("starts without a key when the gateway is down and leaves nothing usable behind", async () => {
    const { store, admin, worker, manager } = setup();
    admin.down = true;
    await expect(manager.ensureWorkspaceKey(WORKSPACE)).resolves.toBe("unavailable");
    expect(store.rows[0]).toMatchObject({ status: "revoking", reason: "issue_failed", lastError: "MODEL_GATEWAY_UNAVAILABLE" });
    expect(worker.commands.filter((command) => command.type === "workspace.model_key.set")).toHaveLength(0);
  });

  it("never delivers a key that was revoked while the gateway call was in flight", async () => {
    const { store, worker, manager } = setup();
    store.revokeBeforeActivate = true;
    await expect(manager.ensureWorkspaceKey(WORKSPACE)).resolves.toBe("unavailable");
    expect(worker.commands.filter((command) => command.type === "workspace.model_key.set")).toHaveLength(0);
    expect(store.rows[0]?.status).not.toBe("active");
  });

  it("does not loop or pile up keys while the gateway is unreachable", async () => {
    const { store, admin, manager } = setup();
    admin.down = true;
    await manager.processPending();
    await manager.processPending();
    // One reservation per pass at most, each pending deletion; no busy loop.
    expect(store.rows.length).toBeLessThanOrEqual(2);
    expect(store.rows.every((row) => row.status === "revoking")).toBe(true);
    admin.down = false;
    await manager.processPending();
    expect(store.rows.filter((row) => row.status === "active")).toHaveLength(1);
    expect(store.rows.filter((row) => row.status === "revoking")).toHaveLength(0);
  });

  it("revokes a key it could not deliver", async () => {
    const { store, admin, manager } = setup({ connected: false });
    await expect(manager.ensureWorkspaceKey(WORKSPACE)).resolves.toBe("unavailable");
    expect(store.rows[0]).toMatchObject({ reason: "lost", lastError: "MODEL_KEY_DELIVERY_FAILED" });
    await manager.processPending();
    expect(store.rows[0]?.status).toBe("revoked");
    expect(admin.deleted).toEqual([`arw-${WORKSPACE}-1`]);
  });

  it("issues no key for a disabled user or a Worker without a relay", async () => {
    const { store, admin, manager } = setup();
    store.userActive = false;
    await expect(manager.ensureWorkspaceKey(WORKSPACE)).resolves.toBe("unavailable");
    store.userActive = true;
    store.relayEnabled = false;
    await expect(manager.ensureWorkspaceKey(WORKSPACE)).resolves.toBe("unavailable");
    expect(admin.generated).toHaveLength(0);
  });

  it("clears the Worker first, then deletes at the gateway, and marks revoked only on success", async () => {
    const { store, admin, worker, manager } = setup();
    store.running.clear();
    await manager.ensureWorkspaceKey(WORKSPACE);
    await store.requestModelKeyRevoke({ workspaceId: WORKSPACE, reason: "user_disabled" });

    admin.down = true;
    await manager.processPending();
    // The Worker stopped using it although the gateway could not be reached.
    expect(worker.held.has(WORKSPACE)).toBe(false);
    expect(store.rows[0]).toMatchObject({ status: "revoking", attempts: 1, lastError: "MODEL_GATEWAY_UNAVAILABLE" });

    admin.down = false;
    await manager.processPending();
    expect(admin.deleted).toEqual([`arw-${WORKSPACE}-1`]);
    expect(store.rows[0]?.status).toBe("revoked");
    const clears = worker.commands.filter((command) => command.type === "workspace.model_key.clear");
    expect(clears.every((command) => "keyAlias" in command.payload && command.payload.keyAlias === `arw-${WORKSPACE}-1`)).toBe(true);
  });

  it("rotates: the old key is deleted and a running Workspace gets a new one", async () => {
    const { store, admin, worker, manager } = setup();
    await manager.ensureWorkspaceKey(WORKSPACE);
    await expect(
      manager.rotate({ userId: USER, actorUserId: "admin-1", requestId: "req-1" }),
    ).resolves.toBe(1);
    expect(store.rows[0]).toMatchObject({ status: "revoked", reason: "admin", actor: "admin-1" });
    expect(admin.deleted).toEqual([`arw-${WORKSPACE}-1`]);
    expect(store.rows[1]).toMatchObject({ status: "active", keyAlias: `arw-${WORKSPACE}-2` });
    expect(worker.held.get(WORKSPACE)).toBe(`arw-${WORKSPACE}-2`);
  });

  it("reconciles a Worker: clears keys it should not hold and rotates keys it lost", async () => {
    const { store, worker, manager } = setup();
    store.running.clear();
    await manager.ensureWorkspaceKey(WORKSPACE);
    worker.held.clear();
    worker.held.set(OTHER, `arw-${OTHER}-7`);
    worker.commands.length = 0;
    await manager.reconcileWorker(WORKER, [{ workspaceId: OTHER, keyAlias: `arw-${OTHER}-7` }]);
    expect(worker.commands).toContainEqual(
      expect.objectContaining({
        type: "workspace.model_key.clear",
        payload: { workspaceId: OTHER, keyAlias: `arw-${OTHER}-7` },
      }),
    );
    expect(store.rows[0]).toMatchObject({ status: "revoking", reason: "lost" });
  });

  it("reports gateway status and per-Workspace access, and degrades when the gateway is down", async () => {
    const { store, admin, manager } = setup();
    await expect(manager.status()).resolves.toMatchObject({
      reachable: true,
      catalog: [
        { id: "deepseek-v4-flash", presentInGateway: true },
        { id: "mimo-v2.5-pro", presentInGateway: false },
      ],
    });
    await expect(manager.usage(USER)).resolves.toEqual({ spendUsd: 1.25, maxBudgetUsd: 10, budgetResetAt: "2026-11-01T00:00:00Z" });
    admin.down = true;
    await expect(manager.usage("someone-else")).resolves.toBe("unavailable");

    const access = await manager.workspaceAccess([
      { id: WORKSPACE, state: "RUNNING" },
      { id: OTHER, state: "STOPPED" },
    ]);
    expect(access.get(WORKSPACE)).toEqual({ status: "unavailable", reason: "MODEL_KEY_PENDING" });
    expect(access.get(OTHER)).toEqual({ status: "pending", reason: null });
    admin.down = false;
    await manager.ensureWorkspaceKey(WORKSPACE);
    expect((await manager.workspaceAccess([{ id: WORKSPACE, state: "RUNNING" }])).get(WORKSPACE)).toEqual({
      status: "available",
      reason: null,
    });
    manager.recordModelConfig(WORKSPACE, "user_config_invalid");
    expect((await manager.workspaceAccess([{ id: WORKSPACE, state: "RUNNING" }])).get(WORKSPACE)).toEqual({
      status: "unavailable",
      reason: "USER_CONFIG_INVALID",
    });
    store.relayEnabled = false;
    manager.recordModelConfig(WORKSPACE, "removed");
    expect((await manager.workspaceAccess([{ id: WORKSPACE, state: "STOPPED" }])).get(WORKSPACE)).toEqual({
      status: "unavailable",
      reason: "MODEL_RELAY_DISABLED",
    });
  });
});
