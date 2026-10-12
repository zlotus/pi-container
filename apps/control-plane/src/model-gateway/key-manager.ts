import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Repository } from "@agent-runtime/database";
import type { Logger } from "@agent-runtime/logging";
import {
  ModelGatewayConfigSchema,
  WORKER_PROTOCOL_VERSION,
  type ModelConfigResult,
  type ModelGatewayConfig,
  type WorkerModelKeyHolding,
} from "@agent-runtime/protocol";

import type { WorkerChannel } from "../worker-channel.js";
import { ModelGatewayError, type ModelGatewayAdmin, type ModelUsage } from "./admin-client.js";

/** Reads and validates the platform model catalog (specs.md Phase 16.5). */
export async function loadModelCatalog(path: string): Promise<ModelGatewayConfig> {
  const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
  return ModelGatewayConfigSchema.parse(decoded);
}

export type ModelKeyStore = Pick<
  Repository,
  | "beginModelKeyIssue"
  | "activateModelKey"
  | "requestModelKeyRevoke"
  | "listDueModelKeyRevocations"
  | "recordModelKeyRevokeResult"
  | "findLiveModelKey"
  | "listActiveModelKeysForWorker"
  | "listWorkspacesNeedingModelKey"
  | "expireStaleModelKeyIssues"
  | "modelKeyOverview"
  | "findUserModelBudget"
  | "listWorkspaceModelKeyStates"
>;

/** Platform model access of one Workspace as the Portal shows it (specs.md Phase 16.8). */
export interface WorkspaceModelAccess {
  status: "available" | "pending" | "unavailable";
  reason: "MODEL_KEY_PENDING" | "MODEL_RELAY_DISABLED" | "USER_CONFIG_INVALID" | null;
}

/** What routes and the Worker channel use; ModelKeyManager is the implementation. */
export interface ModelAccessService {
  readonly catalog: ModelGatewayConfig;
  ensureWorkspaceKey(workspaceId: string): Promise<ModelKeyAvailability>;
  recordModelConfig(workspaceId: string, result: ModelConfigResult | undefined): void;
  workspaceAccess(
    workspaces: ReadonlyArray<{ id: string; state: string }>,
  ): Promise<Map<string, WorkspaceModelAccess>>;
  rotate(input: { userId?: string; workspaceId?: string; actorUserId: string; requestId: string }): Promise<number>;
  reconcileWorker(workerId: string, holdings: readonly WorkerModelKeyHolding[]): Promise<void>;
  kick(): void;
  status(): Promise<ModelGatewayStatus>;
  usage(userId: string): Promise<ModelUsage | null | "unavailable">;
  applyBudget(userId: string): Promise<boolean>;
}

export interface ModelKeyPolicy {
  defaultBudgetUsd: number | null;
  budgetDuration: string;
  rpmLimit: number;
  tpmLimit: number | null;
}

export type ModelKeyAvailability = "available" | "unavailable";

export interface ModelGatewayStatus {
  enabled: true;
  reachable: boolean;
  providerId: string;
  catalog: Array<{ id: string; name: string | null; presentInGateway: boolean | null }>;
  pendingRevocations: number;
  oldestPendingAt: Date | null;
  lastErrorCode: string | null;
  activeKeys: number;
}

const ISSUE_STALE_MS = 60_000;
const GATEWAY_MODELS_TTL_MS = 10 * 60_000;
const USAGE_TTL_MS = 60_000;

/**
 * Issues, delivers, rotates and revokes Workspace virtual keys (specs.md Phase 16.6).
 * Revocation is fail-closed: the Worker stops using a key right away when it is online,
 * and the row becomes `revoked` only after the gateway confirmed the deletion; failures
 * stay pending and are retried with backoff. Issuing is best effort: a Workspace starts
 * without platform models when the gateway is unavailable (16.14 Q3).
 */
export class ModelKeyManager implements ModelAccessService {
  readonly #store: ModelKeyStore;
  readonly #admin: ModelGatewayAdmin;
  readonly #channel: WorkerChannel;
  readonly #catalog: ModelGatewayConfig;
  readonly #policy: ModelKeyPolicy;
  readonly #log: Pick<Logger, "info" | "warn"> | undefined;
  readonly #onMaintenanceFailure: (() => void) | undefined;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  /** Set while a maintenance pass runs: its own failures must not schedule another pass. */
  #inPass = false;
  /** A gateway call failed as unreachable during the current pass. */
  #gatewayDown = false;
  #gatewayModels: { at: number; models: string[] | null } | null = null;
  readonly #usage = new Map<string, { at: number; usage: ModelUsage | null }>();
  /** Last models.json outcome per Workspace; a hint for the Portal, not persisted. */
  readonly #modelConfig = new Map<string, ModelConfigResult>();

  constructor(options: {
    store: ModelKeyStore;
    admin: ModelGatewayAdmin;
    channel: WorkerChannel;
    catalog: ModelGatewayConfig;
    policy: ModelKeyPolicy;
    log?: Pick<Logger, "info" | "warn">;
    /** Counts failed maintenance passes (specs.md Phase 17.4). */
    onMaintenanceFailure?: () => void;
  }) {
    this.#store = options.store;
    this.#admin = options.admin;
    this.#channel = options.channel;
    this.#catalog = options.catalog;
    this.#policy = options.policy;
    this.#log = options.log;
    this.#onMaintenanceFailure = options.onMaintenanceFailure;
  }

  get catalog(): ModelGatewayConfig {
    return this.#catalog;
  }

  start(intervalMs = 30_000): void {
    this.#timer ??= setInterval(() => this.kick(), intervalMs);
    this.kick();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Runs the pending work soon; concurrent requests coalesce into one more pass. */
  kick(): void {
    if (this.#inPass) return;
    void this.processPending();
  }

  /** Issues a key for a Workspace that has none and hands it to its Worker. */
  async ensureWorkspaceKey(
    workspaceId: string,
    issueReason: "start" | "reissue" | "rotation" = "start",
  ): Promise<ModelKeyAvailability> {
    let begun;
    try {
      begun = await this.#store.beginModelKeyIssue({ workspaceId, issueReason });
    } catch (error) {
      this.#log?.warn({ workspaceId, err: error }, "could not reserve a model key");
      return "unavailable";
    }
    if (begun.outcome === "ALREADY_LIVE") return begun.status === "active" ? "available" : "unavailable";
    if (begun.outcome !== "ISSUING") return "unavailable";
    const { key } = begun;

    let secret: string;
    try {
      const budget = await this.#store.findUserModelBudget(key.userId);
      await this.#admin.ensureUser(key.userId, {
        maxBudgetUsd: budget.budgetUsd ?? this.#policy.defaultBudgetUsd,
        budgetDuration: this.#policy.budgetDuration,
      });
      secret = await this.#admin.generateKey({
        userId: key.userId,
        workspaceId,
        keyAlias: key.keyAlias,
        models: this.#catalog.models.map((model) => model.id),
        rpmLimit: this.#policy.rpmLimit,
        tpmLimit: this.#policy.tpmLimit,
      });
    } catch (error) {
      if (gatewayErrorCode(error) === "MODEL_GATEWAY_UNAVAILABLE") this.#gatewayDown = true;
      await this.#revokeOne(key.id, "issue_failed", gatewayErrorCode(error));
      this.#log?.warn({ workspaceId, keyAlias: key.keyAlias, code: gatewayErrorCode(error) }, "model key could not be issued");
      return "unavailable";
    }
    if (!(await this.#store.activateModelKey(key.id))) {
      // Revoked while the gateway call was in flight (user disabled, Workspace deleted).
      this.kick();
      return "unavailable";
    }
    const delivered = await this.#send(key.workerId, {
      type: "workspace.model_key.set",
      payload: { workspaceId, keyAlias: key.keyAlias, secret },
    });
    if (!delivered) {
      await this.#revokeOne(key.id, "lost", "MODEL_KEY_DELIVERY_FAILED");
      return "unavailable";
    }
    return "available";
  }

  recordModelConfig(workspaceId: string, result: ModelConfigResult | undefined): void {
    if (result === undefined || result === "unchanged_running") return;
    this.#modelConfig.set(workspaceId, result);
  }

  async workspaceAccess(
    workspaces: ReadonlyArray<{ id: string; state: string }>,
  ): Promise<Map<string, WorkspaceModelAccess>> {
    const states = new Map(
      (await this.#store.listWorkspaceModelKeyStates(workspaces.map((workspace) => workspace.id))).map(
        (state) => [state.workspaceId, state],
      ),
    );
    const access = new Map<string, WorkspaceModelAccess>();
    for (const workspace of workspaces) {
      const state = states.get(workspace.id);
      const config = this.#modelConfig.get(workspace.id);
      let entry: WorkspaceModelAccess;
      if (config === "user_config_invalid") {
        entry = { status: "unavailable", reason: "USER_CONFIG_INVALID" };
      } else if (state !== undefined && state.keyStatus === "active" && state.relayEnabled) {
        entry = { status: "available", reason: null };
      } else if (state !== undefined && !state.relayEnabled && workspace.state !== "CREATED") {
        entry = { status: "unavailable", reason: "MODEL_RELAY_DISABLED" };
      } else if (workspace.state === "RUNNING") {
        entry = { status: "unavailable", reason: "MODEL_KEY_PENDING" };
      } else {
        entry = { status: "pending", reason: null };
      }
      access.set(workspace.id, entry);
    }
    return access;
  }

  /** Revokes the user's or Workspace's keys (admin rotation); running Workspaces get new ones. */
  async rotate(input: { userId?: string; workspaceId?: string; actorUserId: string; requestId: string }): Promise<number> {
    const revoked = await this.#store.requestModelKeyRevoke({
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      reason: "admin",
      actorUserId: input.actorUserId,
      requestId: input.requestId,
    });
    await this.processPending();
    return revoked;
  }

  /**
   * Compares what a Worker holds with the active keys of its Workspaces: keys it should
   * not hold are cleared there, active keys it lost are revoked (and reissued if running).
   */
  async reconcileWorker(workerId: string, holdings: readonly WorkerModelKeyHolding[]): Promise<void> {
    const active = await this.#store.listActiveModelKeysForWorker(workerId);
    const expected = new Map(active.map((key) => [key.workspaceId, key]));
    const held = new Map(holdings.map((holding) => [holding.workspaceId, holding.keyAlias]));
    for (const holding of holdings) {
      if (expected.get(holding.workspaceId)?.keyAlias !== holding.keyAlias) {
        await this.#send(workerId, {
          type: "workspace.model_key.clear",
          payload: { workspaceId: holding.workspaceId, keyAlias: holding.keyAlias },
        });
      }
    }
    const lost = active.filter((key) => held.get(key.workspaceId) !== key.keyAlias).map((key) => key.id);
    if (lost.length > 0) {
      await this.#store.requestModelKeyRevoke({ keyIds: lost, reason: "lost", errorCode: "MODEL_KEY_NOT_HELD" });
    }
    this.kick();
  }

  async processPending(): Promise<void> {
    if (this.#running !== null) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      // At most one extra pass for requests that arrived meanwhile; the timer does the rest.
      for (let pass = 0; pass < 2; pass += 1) {
        this.#again = false;
        this.#inPass = true;
        this.#gatewayDown = false;
        try {
          await this.#pass();
        } catch (error) {
          this.#onMaintenanceFailure?.();
          this.#log?.warn({ err: error }, "model key maintenance failed");
        } finally {
          this.#inPass = false;
        }
        if (!this.#again) break;
      }
    })().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #pass(): Promise<void> {
    await this.#store.expireStaleModelKeyIssues(new Date(Date.now() - ISSUE_STALE_MS));
    for (const pending of await this.#store.listDueModelKeyRevocations(new Date())) {
      // Stop using the key on the Worker first; the gateway deletion is what counts.
      if (pending.workspaceId !== null && pending.workerId !== null && this.#channel.isConnected(pending.workerId)) {
        await this.#send(pending.workerId, {
          type: "workspace.model_key.clear",
          payload: { workspaceId: pending.workspaceId, keyAlias: pending.keyAlias },
        });
      }
      try {
        await this.#admin.deleteKey(pending.keyAlias);
        await this.#store.recordModelKeyRevokeResult(pending.id, { ok: true });
      } catch (error) {
        const code = gatewayErrorCode(error);
        if (code === "MODEL_GATEWAY_UNAVAILABLE") this.#gatewayDown = true;
        await this.#store.recordModelKeyRevokeResult(pending.id, { ok: false, errorCode: code });
        this.#log?.warn({ keyAlias: pending.keyAlias, code, attempts: pending.attempts + 1 }, "model key revocation is still pending");
      }
    }
    // Issuing against an unreachable gateway would only pile up keys to revoke later.
    if (this.#gatewayDown) return;
    for (const needed of await this.#store.listWorkspacesNeedingModelKey()) {
      if (!this.#channel.isConnected(needed.workerId)) continue;
      await this.ensureWorkspaceKey(needed.workspaceId, "reissue");
      if (this.#gatewayDown) return;
    }
  }

  async status(): Promise<ModelGatewayStatus> {
    const models = await this.#gatewayModelNames();
    const overview = await this.#store.modelKeyOverview();
    return {
      enabled: true,
      reachable: models !== null,
      providerId: this.#catalog.providerId,
      catalog: this.#catalog.models.map((model) => ({
        id: model.id,
        name: model.name ?? null,
        presentInGateway: models === null ? null : models.includes(model.id),
      })),
      ...overview,
    };
  }

  /** The user's spend and budget for the current period; null when the gateway cannot say. */
  async usage(userId: string): Promise<ModelUsage | null | "unavailable"> {
    const cached = this.#usage.get(userId);
    if (cached !== undefined && Date.now() - cached.at < USAGE_TTL_MS) return cached.usage;
    try {
      const usage = await this.#admin.userUsage(userId);
      this.#usage.set(userId, { at: Date.now(), usage });
      return usage;
    } catch {
      return "unavailable";
    }
  }

  /** Re-applies the budget of one user right away (admin change). */
  async applyBudget(userId: string): Promise<boolean> {
    try {
      const budget = await this.#store.findUserModelBudget(userId);
      if (!budget.found) return false;
      await this.#admin.ensureUser(userId, {
        maxBudgetUsd: budget.budgetUsd ?? this.#policy.defaultBudgetUsd,
        budgetDuration: this.#policy.budgetDuration,
      });
      this.#usage.delete(userId);
      return true;
    } catch {
      return false;
    }
  }

  async #gatewayModelNames(): Promise<string[] | null> {
    if (this.#gatewayModels !== null && Date.now() - this.#gatewayModels.at < GATEWAY_MODELS_TTL_MS) {
      return this.#gatewayModels.models;
    }
    let models: string[] | null = null;
    try {
      models = await this.#admin.listModels();
      const missing = this.#catalog.models.map((model) => model.id).filter((id) => !models?.includes(id));
      if (missing.length > 0) {
        this.#log?.warn({ missing }, "catalog models are not configured in the model gateway");
      }
    } catch (error) {
      this.#log?.warn({ code: gatewayErrorCode(error) }, "model gateway is not reachable");
    }
    this.#gatewayModels = { at: Date.now(), models };
    return models;
  }

  async #revokeOne(id: string, reason: "issue_failed" | "lost", errorCode: string): Promise<void> {
    try {
      await this.#store.requestModelKeyRevoke({ keyIds: [id], reason, errorCode });
    } catch (error) {
      this.#log?.warn({ err: error }, "could not mark a model key for revocation");
    }
    this.kick();
  }

  async #send(
    workerId: string,
    command:
      | { type: "workspace.model_key.set"; payload: { workspaceId: string; keyAlias: string; secret: string } }
      | { type: "workspace.model_key.clear"; payload: { workspaceId: string; keyAlias: string } },
  ): Promise<boolean> {
    try {
      const response = await this.#channel.dispatch(workerId, {
        version: WORKER_PROTOCOL_VERSION,
        requestId: randomUUID(),
        ...command,
      });
      if (response.type !== "response.ok" || !("modelKey" in response.payload)) return false;
      const { modelKey } = response.payload;
      return (
        modelKey.workspaceId === command.payload.workspaceId &&
        (command.type === "workspace.model_key.clear" || modelKey.keyAlias === command.payload.keyAlias)
      );
    } catch {
      return false;
    }
  }
}

function gatewayErrorCode(error: unknown): string {
  return error instanceof ModelGatewayError ? error.code : "MODEL_GATEWAY_UNAVAILABLE";
}
