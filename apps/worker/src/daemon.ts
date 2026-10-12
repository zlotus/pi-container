import { randomUUID } from "node:crypto";
import { cpus, hostname, totalmem } from "node:os";

import { createJsonLogger, type Logger } from "@agent-runtime/logging";
import {
  ControlToWorkerMessageSchema,
  WORKER_PROTOCOL_VERSION,
  type Architecture,
  type ControlToWorkerMessage,
  type EgressPolicy,
  type ModelConfigResult,
  type ModelGatewayConfig,
  type ModelRelayStatus,
  type WorkerCapabilities,
  type WorkerEgressStatus,
  type WorkerReconcileAssignment,
  type WorkerReconciliationReport,
  type WorkerHostUsage,
  type WorkerStorageStatus,
  type WorkerToControlMessage,
  type WorkspaceDiskUsage,
  type WorkspaceResources,
  type WorkspaceUsage,
} from "@agent-runtime/protocol";
import WebSocket from "ws";

import type { WorkerConfig } from "./config.js";
import type { RuntimeCapabilityProbe } from "./capabilities.js";
import { EgressApplyError } from "./egress/controller.js";
import { DISABLED_MODEL_ACCESS, ModelAccessError, type WorkerModelAccess } from "./model-relay/access.js";
import {
  WorkspaceRuntimeError,
  type WorkspaceRuntimeObservation,
} from "./runtime.js";
import { HOST_ONLY_USAGE, type WorkerUsage } from "./usage/reporter.js";

type WorkerHelloMessage = Extract<
  WorkerToControlMessage,
  { type: "worker.hello" }
>;
type WorkerHeartbeatMessage = Extract<
  WorkerToControlMessage,
  { type: "worker.heartbeat" }
>;

export interface WorkspaceRuntime {
  ensure(
    workspaceId: string,
    runtimeImage: string,
    resources: WorkspaceResources,
    storage: { diskLimitBytes: number },
  ): Promise<WorkspaceRuntimeObservation>;
  setDiskLimit(
    workspaceId: string,
    dataLimitBytes: number,
  ): Promise<{ dataLimitBytes: number; dataUsedBytes: number }>;
  diskUsage(): Promise<WorkspaceDiskUsage[]>;
  start(workspaceId: string): Promise<WorkspaceRuntimeObservation>;
  stop(workspaceId: string): Promise<WorkspaceRuntimeObservation>;
  delete(workspaceId: string): Promise<WorkspaceRuntimeObservation>;
  inspect(workspaceId: string): Promise<WorkspaceRuntimeObservation>;
  reconcile(
    assignments: readonly WorkerReconcileAssignment[],
  ): Promise<Omit<WorkerReconciliationReport, "modelKeys">>;
  configureModelProvider(
    workspaceId: string,
    config: ModelGatewayConfig | null,
    relayPort: number | null,
  ): Promise<ModelConfigResult>;
  allocatedWorkspaces(): Promise<number>;
  stopRunningWorkspaces(): Promise<string[]>;
}

/** The Worker's egress rule controller as used by the daemon. */
export interface WorkerEgress {
  status(): WorkerEgressStatus;
  ensure(): Promise<WorkerEgressStatus>;
  apply(policy: EgressPolicy): Promise<WorkerEgressStatus>;
}

/** The Worker's disk quota controller as used by the daemon (specs.md Phase 15.6). */
export interface WorkerStorage {
  status(): WorkerStorageStatus;
  check(): Promise<WorkerStorageStatus>;
}

/** How often each Workspace's disk usage is sampled for the Control Plane. */
export const DISK_USAGE_SAMPLE_INTERVAL_MS = 60_000;

export function currentArchitecture(nodeArchitecture: string): Architecture {
  if (nodeArchitecture === "x64") return "amd64";
  if (nodeArchitecture === "arm64") return "arm64";
  throw new Error(`Unsupported Worker architecture: ${nodeArchitecture}`);
}

export function buildWorkerHello(
  config: WorkerConfig,
  system: {
    hostname: string;
    architecture: Architecture;
    logicalCpuCount: number;
    memoryBytes: number;
  },
  capabilities: WorkerCapabilities,
  egress: WorkerEgressStatus,
  storage: WorkerStorageStatus,
  allocatedWorkspaces = 0,
  modelRelay: ModelRelayStatus = DISABLED_MODEL_ACCESS.status(),
): WorkerHelloMessage {
  return {
    version: WORKER_PROTOCOL_VERSION,
    type: "worker.hello",
    requestId: randomUUID(),
    payload: {
      workerId: config.WORKER_ID,
      hostname: system.hostname,
      architecture: system.architecture,
      runtimeImage: config.RUNTIME_IMAGE,
      runtimeVersion: config.RUNTIME_VERSION,
      capabilities,
      maxWorkspaces: config.WORKER_MAX_WORKSPACES,
      allocatedWorkspaces,
      systemResources: {
        logicalCpuCount: system.logicalCpuCount,
        memoryBytes: system.memoryBytes,
      },
      egress,
      storage,
      modelRelay,
    },
  };
}

export function buildWorkerHeartbeat(
  workerId: string,
  observedAt: Date,
  egress: WorkerEgressStatus,
  storage: WorkerStorageStatus,
  host: WorkerHostUsage,
  allocatedWorkspaces = 0,
  workspaceDisk: WorkspaceDiskUsage[] | null = null,
  modelRelay: ModelRelayStatus = DISABLED_MODEL_ACCESS.status(),
  workspaceUsage: WorkspaceUsage[] | null = null,
): WorkerHeartbeatMessage {
  return {
    version: WORKER_PROTOCOL_VERSION,
    type: "worker.heartbeat",
    requestId: randomUUID(),
    payload: {
      workerId,
      allocatedWorkspaces,
      egress,
      storage,
      modelRelay,
      host,
      ...(workspaceDisk === null ? {} : { workspaceDisk }),
      ...(workspaceUsage === null ? {} : { workspaceUsage }),
      observedAt: observedAt.toISOString(),
    },
  };
}

export class WorkerDaemon {
  #socket: WebSocket | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #egressTimer: NodeJS.Timeout | null = null;
  #diskTimer: NodeJS.Timeout | null = null;
  #usageTimer: NodeJS.Timeout | null = null;
  /** The latest usage sample, sent once with the next heartbeat. */
  #pendingDiskUsage: WorkspaceDiskUsage[] | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #reconnectDelayMs: number;
  #stopping = false;
  #commandQueue = Promise.resolve();

  constructor(
    readonly config: WorkerConfig,
    readonly runtime: WorkspaceRuntime,
    readonly capabilityProbe: RuntimeCapabilityProbe,
    readonly egress: WorkerEgress,
    readonly storage: WorkerStorage,
    readonly log: Pick<Logger, "info" | "warn"> = createJsonLogger("worker"),
    readonly modelAccess: WorkerModelAccess = DISABLED_MODEL_ACCESS,
    readonly usage: WorkerUsage = HOST_ONLY_USAGE(),
  ) {
    this.#reconnectDelayMs = config.WORKER_RECONNECT_INITIAL_MS;
  }

  start(): void {
    if (this.#socket !== null || this.#reconnectTimer !== null) return;
    this.#stopping = false;
    // Egress verification does not depend on the Control Plane being reachable.
    this.#egressTimer ??= setInterval(() => {
      void this.checkEgress().then(() => this.checkStorage());
    }, this.config.WORKER_HEARTBEAT_INTERVAL_MS);
    this.#diskTimer ??= setInterval(() => {
      void this.sampleDiskUsage();
    }, DISK_USAGE_SAMPLE_INTERVAL_MS);
    // Container usage is sampled on the heartbeat cadence without delaying the heartbeat.
    this.#usageTimer ??= setInterval(() => {
      void this.usage.refresh();
    }, this.config.WORKER_HEARTBEAT_INTERVAL_MS);
    this.#connect();
  }

  /**
   * Re-checks that disk quotas are enforced. When they are not, every running Workspace
   * is stopped: fail closed, data preserved (specs.md Phase 15.6).
   */
  async checkStorage(): Promise<WorkerStorageStatus> {
    const status = await this.storage.check();
    if (!status.enforced) {
      await this.#stopRunning("disk quotas are not enforced");
    }
    return status;
  }

  async sampleDiskUsage(): Promise<void> {
    try {
      this.#pendingDiskUsage = await this.runtime.diskUsage();
    } catch (error) {
      this.log.warn({ workerId: this.config.WORKER_ID, err: error }, "disk usage sampling failed");
    }
  }

  async #stopRunning(reason: string): Promise<void> {
    try {
      const stopped = await this.runtime.stopRunningWorkspaces();
      if (stopped.length > 0) {
        this.log.warn(
          { workerId: this.config.WORKER_ID, workspaceIds: stopped, reason },
          "stopped running Workspaces to fail closed",
        );
      }
    } catch (error) {
      this.log.warn(
        { workerId: this.config.WORKER_ID, err: error, reason },
        "could not stop running Workspaces",
      );
    }
  }

  /**
   * Verifies the egress rules (repairing drift). When they cannot be enforced, every
   * running Workspace is stopped: fail closed, data preserved (specs.md Phase 14.11 Q3).
   */
  async checkEgress(): Promise<WorkerEgressStatus> {
    const status = await this.egress.ensure();
    if (!status.enforced) {
      await this.#stopRunning("egress rules are not enforced");
    }
    return status;
  }

  stop(): void {
    this.#stopping = true;
    if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    if (this.#egressTimer !== null) clearInterval(this.#egressTimer);
    if (this.#diskTimer !== null) clearInterval(this.#diskTimer);
    if (this.#usageTimer !== null) clearInterval(this.#usageTimer);
    this.#egressTimer = null;
    this.#diskTimer = null;
    this.#usageTimer = null;
    this.#heartbeatTimer = null;
    this.#reconnectTimer = null;
    this.#socket?.close(1000, "Worker shutting down");
    this.#socket = null;
  }

  #connect(): void {
    const socket = new WebSocket(this.config.CONTROL_PLANE_URL, {
      headers: { authorization: `Bearer ${this.config.WORKER_TOKEN}` },
      perMessageDeflate: false,
      maxPayload: 8 * 1024 * 1024,
    });
    this.#socket = socket;

    socket.on("open", () => {
      this.#reconnectDelayMs = this.config.WORKER_RECONNECT_INITIAL_MS;
      this.log.info({ workerId: this.config.WORKER_ID }, "control channel connected");
      void this.#beginReporting(socket);
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1008, "Text protocol messages required");
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(data.toString());
      } catch {
        socket.close(1008, "Invalid protocol message");
        return;
      }
      const parsed = ControlToWorkerMessageSchema.safeParse(decoded);
      if (!parsed.success) {
        socket.close(1008, "Invalid protocol message");
        return;
      }
      this.#commandQueue = this.#commandQueue
        .then(() => this.#handleCommand(parsed.data))
        .catch(() => undefined);
    });

    socket.on("error", (error) => {
      this.log.warn({ workerId: this.config.WORKER_ID, err: error }, "control channel error");
    });

    socket.on("close", () => {
      if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
      if (this.#socket === socket) this.#socket = null;
      if (!this.#stopping) this.#scheduleReconnect();
    });
  }

  #send(message: WorkerToControlMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(message));
  }

  async #beginReporting(socket: WebSocket): Promise<void> {
    try {
      const architecture = currentArchitecture(process.arch);
      const [allocatedWorkspaces, capabilities] = await Promise.all([
        this.runtime.allocatedWorkspaces(),
        this.capabilityProbe.probe(architecture),
      ]);
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      this.#send(
        buildWorkerHello(
          this.config,
          {
            hostname: hostname(),
            architecture,
            logicalCpuCount: cpus().length,
            memoryBytes: totalmem(),
          },
          capabilities,
          this.egress.status(),
          this.storage.status(),
          allocatedWorkspaces,
          this.modelAccess.status(),
        ),
      );
      this.#heartbeatTimer = setInterval(() => {
        void this.#sendHeartbeat(socket);
      }, this.config.WORKER_HEARTBEAT_INTERVAL_MS);
    } catch (error) {
      this.log.warn(
        { workerId: this.config.WORKER_ID, err: error },
        "could not verify the configured Runtime image",
      );
      socket.close(1011, "Configured Runtime image unavailable or unverified");
    }
  }

  async #sendHeartbeat(socket: WebSocket): Promise<void> {
    try {
      const allocatedWorkspaces = await this.runtime.allocatedWorkspaces();
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      const workspaceDisk = this.#pendingDiskUsage;
      this.#pendingDiskUsage = null;
      this.#send(
        buildWorkerHeartbeat(
          this.config.WORKER_ID,
          new Date(),
          this.egress.status(),
          this.storage.status(),
          this.usage.host(),
          allocatedWorkspaces,
          workspaceDisk,
          this.modelAccess.status(),
          this.usage.workspaces(),
        ),
      );
    } catch (error) {
      this.log.warn(
        { workerId: this.config.WORKER_ID, err: error },
        "lost access to the local Docker runtime",
      );
      socket.close(1011, "Local Docker runtime unavailable");
    }
  }

  async #handleCommand(message: ControlToWorkerMessage): Promise<void> {
    try {
      if (message.type === "worker.reconcile") {
        const report = await this.runtime.reconcile(
          message.payload.assignments,
        );
        await this.modelAccess.refresh();
        this.#send({
          version: WORKER_PROTOCOL_VERSION,
          type: "response.ok",
          requestId: message.requestId,
          payload: {
            requestType: message.type,
            reconciliation: { ...report, modelKeys: this.modelAccess.holdings() },
          },
        });
        return;
      }
      if (message.type === "workspace.model_key.set" || message.type === "workspace.model_key.clear") {
        const { workspaceId } = message.payload;
        let keyAlias: string | null = null;
        if (message.type === "workspace.model_key.set") {
          await this.modelAccess.setKey(workspaceId, message.payload.keyAlias, message.payload.secret);
          keyAlias = message.payload.keyAlias;
        } else {
          keyAlias = await this.modelAccess.clearKey(workspaceId, message.payload.keyAlias);
        }
        this.#send({
          version: WORKER_PROTOCOL_VERSION,
          type: "response.ok",
          requestId: message.requestId,
          payload: { requestType: message.type, modelKey: { workspaceId, keyAlias } },
        });
        return;
      }
      if (message.type === "worker.egress.apply") {
        const egress = await this.egress.apply(message.payload);
        this.#send({
          version: WORKER_PROTOCOL_VERSION,
          type: "response.ok",
          requestId: message.requestId,
          payload: { requestType: message.type, egress },
        });
        return;
      }
      if (message.type === "workspace.storage.set") {
        const result = await this.runtime.setDiskLimit(
          message.payload.workspaceId,
          message.payload.diskLimitBytes,
        );
        this.#send({
          version: WORKER_PROTOCOL_VERSION,
          type: "response.ok",
          requestId: message.requestId,
          payload: {
            requestType: message.type,
            storage: { workspaceId: message.payload.workspaceId, ...result },
          },
        });
        return;
      }
      let workspace: WorkspaceRuntimeObservation;
      let modelConfig: ModelConfigResult | undefined;
      switch (message.type) {
        case "workspace.ensure":
          workspace = await this.runtime.ensure(
            message.payload.workspaceId,
            message.payload.runtimeImage,
            message.payload.resources,
            message.payload.storage,
          );
          modelConfig = await this.#configureModelProvider(
            message.payload.workspaceId,
            message.payload.modelGateway,
          );
          break;
        case "workspace.start":
          workspace = await this.runtime.start(message.payload.workspaceId);
          await this.modelAccess.refresh();
          break;
        case "workspace.stop":
          workspace = await this.runtime.stop(message.payload.workspaceId);
          await this.modelAccess.refresh();
          break;
        case "workspace.delete":
          workspace = await this.runtime.delete(message.payload.workspaceId);
          this.modelAccess.forget(message.payload.workspaceId);
          await this.modelAccess.refresh();
          break;
        case "workspace.inspect":
          workspace = await this.runtime.inspect(message.payload.workspaceId);
          break;
      }
      this.#send({
        version: WORKER_PROTOCOL_VERSION,
        type: "response.ok",
        requestId: message.requestId,
        payload: {
          requestType: message.type,
          workspace,
          ...(modelConfig === undefined ? {} : { modelConfig }),
        },
      });
    } catch (error) {
      const runtimeError =
        error instanceof WorkspaceRuntimeError || error instanceof ModelAccessError
          ? error
          : error instanceof EgressApplyError
            ? { code: "EGRESS_APPLY_FAILED", message: "Egress rules could not be applied", retryable: true }
            : new WorkspaceRuntimeError(
              "RUNTIME_ENGINE_ERROR",
              "Workspace Runtime operation failed",
              true,
            );
      this.#send({
        version: WORKER_PROTOCOL_VERSION,
        type: "response.error",
        requestId: message.requestId,
        payload: {
          requestType: message.type,
          code: runtimeError.code,
          message: runtimeError.message,
          retryable: runtimeError.retryable,
        },
      });
    }
  }

  /** Model access is not an isolation boundary: a failure here never fails the ensure. */
  async #configureModelProvider(
    workspaceId: string,
    config: ModelGatewayConfig | null,
  ): Promise<ModelConfigResult> {
    try {
      return await this.runtime.configureModelProvider(workspaceId, config, this.modelAccess.relayPort());
    } catch (error) {
      this.log.warn({ workspaceId, err: error }, "could not write the platform model provider");
      return "write_failed";
    }
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(
      this.#reconnectDelayMs * 2,
      this.config.WORKER_RECONNECT_MAX_MS,
    );
    this.log.warn(
      { workerId: this.config.WORKER_ID, delayMs: delay },
      "control channel reconnecting",
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }
}
