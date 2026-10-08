import type { Logger } from "@agent-runtime/logging";
import type { ModelRelayStatus, WorkerModelKeyHolding } from "@agent-runtime/protocol";

import { ModelKeyStore } from "./keys.js";
import { DISABLED_MODEL_RELAY_STATUS, ModelRelay, type RelayEndpoint } from "./relay.js";

/** The model relay and its virtual keys as the daemon uses them (specs.md Phase 16.10). */
export interface WorkerModelAccess {
  status(): ModelRelayStatus;
  /** The relay port written into models.json; null when the relay is not enabled. */
  relayPort(): number | null;
  holdings(): WorkerModelKeyHolding[];
  setKey(workspaceId: string, keyAlias: string, secret: string): Promise<void>;
  clearKey(workspaceId: string): Promise<void>;
  /** The Workspace directory is gone (delete): stop serving its key. */
  forget(workspaceId: string): void;
  /** Re-reads which managed Workspaces are running (after lifecycle changes). */
  refresh(): Promise<void>;
}

export class ModelAccessError extends Error {
  constructor(
    readonly code: "MODEL_RELAY_DISABLED" | "MODEL_KEY_STORE_FAILED",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export const DISABLED_MODEL_ACCESS: WorkerModelAccess = {
  status: () => DISABLED_MODEL_RELAY_STATUS,
  relayPort: () => null,
  holdings: () => [],
  setKey: async () => {
    throw new ModelAccessError("MODEL_RELAY_DISABLED", "The model relay is not enabled on this Worker", false);
  },
  clearKey: async () => undefined,
  forget: () => undefined,
  refresh: async () => undefined,
};

export interface ModelAccessRuntime {
  modelKeyDirectory(workspaceId: string): Promise<string>;
  relayEndpoints(): Promise<RelayEndpoint[]>;
}

export class RelayModelAccess implements WorkerModelAccess {
  readonly #keys = new ModelKeyStore();
  readonly #relay: ModelRelay;
  readonly #runtime: ModelAccessRuntime;
  readonly #workspacesRoot: string;
  readonly #log: Pick<Logger, "info" | "warn">;

  constructor(options: {
    runtime: ModelAccessRuntime;
    workspacesRoot: string;
    port: number;
    upstream: URL;
    maxBodyBytes: number;
    log: Pick<Logger, "info" | "warn">;
  }) {
    this.#runtime = options.runtime;
    this.#workspacesRoot = options.workspacesRoot;
    this.#log = options.log;
    this.#relay = new ModelRelay({
      port: options.port,
      upstream: options.upstream,
      maxBodyBytes: options.maxBodyBytes,
      keys: this.#keys,
      endpoints: () => this.#runtime.relayEndpoints(),
      log: options.log,
    });
  }

  /** Loads persisted keys, then listens. A listen failure leaves `listening=false`. */
  async start(): Promise<void> {
    const { loaded, ignored } = await this.#keys.load(this.#workspacesRoot);
    if (ignored > 0) this.#log.warn({ ignored }, "ignored invalid model key files");
    try {
      await this.#relay.start();
      this.#log.info({ port: this.#relay.status().port, keys: loaded }, "model relay listening");
    } catch (error) {
      this.#log.warn({ err: error }, "model relay could not listen");
    }
  }

  stop(): Promise<void> {
    return this.#relay.stop();
  }

  status(): ModelRelayStatus {
    return this.#relay.status();
  }

  relayPort(): number | null {
    return this.#relay.status().port;
  }

  holdings(): WorkerModelKeyHolding[] {
    return this.#keys.holdings();
  }

  async setKey(workspaceId: string, keyAlias: string, secret: string): Promise<void> {
    const directory = await this.#runtime.modelKeyDirectory(workspaceId);
    try {
      await this.#keys.set(workspaceId, directory, keyAlias, secret);
    } catch {
      throw new ModelAccessError("MODEL_KEY_STORE_FAILED", "The model key could not be stored", true);
    }
  }

  async clearKey(workspaceId: string): Promise<void> {
    let directory: string | null = null;
    try {
      directory = await this.#runtime.modelKeyDirectory(workspaceId);
    } catch {
      // Not (or no longer) a managed Workspace here: nothing on disk to remove.
    }
    await this.#keys.clear(workspaceId, directory);
  }

  forget(workspaceId: string): void {
    this.#keys.forget(workspaceId);
  }

  refresh(): Promise<void> {
    return this.#relay.refresh();
  }
}
