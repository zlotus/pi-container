import { randomUUID } from "node:crypto";
import { cpus, hostname, totalmem } from "node:os";

import {
  ControlToWorkerMessageSchema,
  type Architecture,
  type ControlToWorkerMessage,
  type WorkerCapabilities,
  type WorkerReconcileAssignment,
  type WorkerReconciliationReport,
  type WorkerToControlMessage,
  type WorkspaceResources,
} from "@agent-runtime/protocol";
import WebSocket from "ws";

import type { WorkerConfig } from "./config.js";
import type { RuntimeCapabilityProbe } from "./capabilities.js";
import {
  WorkspaceRuntimeError,
  type WorkspaceRuntimeObservation,
} from "./runtime.js";

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
  ): Promise<WorkspaceRuntimeObservation>;
  start(workspaceId: string): Promise<WorkspaceRuntimeObservation>;
  stop(workspaceId: string): Promise<WorkspaceRuntimeObservation>;
  delete(workspaceId: string): Promise<WorkspaceRuntimeObservation>;
  inspect(workspaceId: string): Promise<WorkspaceRuntimeObservation>;
  reconcile(
    assignments: readonly WorkerReconcileAssignment[],
  ): Promise<WorkerReconciliationReport>;
  allocatedWorkspaces(): Promise<number>;
}

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
  allocatedWorkspaces = 0,
): WorkerHelloMessage {
  return {
    version: 1,
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
    },
  };
}

export function buildWorkerHeartbeat(
  workerId: string,
  observedAt: Date,
  allocatedWorkspaces = 0,
): WorkerHeartbeatMessage {
  return {
    version: 1,
    type: "worker.heartbeat",
    requestId: randomUUID(),
    payload: {
      workerId,
      allocatedWorkspaces,
      observedAt: observedAt.toISOString(),
    },
  };
}

export class WorkerDaemon {
  #socket: WebSocket | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #reconnectDelayMs: number;
  #stopping = false;
  #commandQueue = Promise.resolve();

  constructor(
    readonly config: WorkerConfig,
    readonly runtime: WorkspaceRuntime,
    readonly capabilityProbe: RuntimeCapabilityProbe,
    readonly log: Pick<Console, "info" | "warn"> = console,
  ) {
    this.#reconnectDelayMs = config.WORKER_RECONNECT_INITIAL_MS;
  }

  start(): void {
    if (this.#socket !== null || this.#reconnectTimer !== null) return;
    this.#stopping = false;
    this.#connect();
  }

  stop(): void {
    this.#stopping = true;
    if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
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
      this.log.info(`Worker ${this.config.WORKER_ID} control channel connected`);
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

    socket.on("error", () => {
      this.log.warn(`Worker ${this.config.WORKER_ID} control channel error`);
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
          allocatedWorkspaces,
        ),
      );
      this.#heartbeatTimer = setInterval(() => {
        void this.#sendHeartbeat(socket);
      }, this.config.WORKER_HEARTBEAT_INTERVAL_MS);
    } catch (error) {
      this.log.warn(
        `Worker ${this.config.WORKER_ID} could not verify the configured Runtime image`,
        error,
      );
      socket.close(1011, "Configured Runtime image unavailable or unverified");
    }
  }

  async #sendHeartbeat(socket: WebSocket): Promise<void> {
    try {
      const allocatedWorkspaces = await this.runtime.allocatedWorkspaces();
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      this.#send(
        buildWorkerHeartbeat(
          this.config.WORKER_ID,
          new Date(),
          allocatedWorkspaces,
        ),
      );
    } catch {
      this.log.warn(
        `Worker ${this.config.WORKER_ID} lost access to the local Docker runtime`,
      );
      socket.close(1011, "Local Docker runtime unavailable");
    }
  }

  async #handleCommand(message: ControlToWorkerMessage): Promise<void> {
    try {
      if (message.type === "worker.reconcile") {
        const reconciliation = await this.runtime.reconcile(
          message.payload.assignments,
        );
        this.#send({
          version: 1,
          type: "response.ok",
          requestId: message.requestId,
          payload: { requestType: message.type, reconciliation },
        });
        return;
      }
      let workspace: WorkspaceRuntimeObservation;
      switch (message.type) {
        case "workspace.ensure":
          workspace = await this.runtime.ensure(
            message.payload.workspaceId,
            message.payload.runtimeImage,
            message.payload.resources,
          );
          break;
        case "workspace.start":
          workspace = await this.runtime.start(message.payload.workspaceId);
          break;
        case "workspace.stop":
          workspace = await this.runtime.stop(message.payload.workspaceId);
          break;
        case "workspace.delete":
          workspace = await this.runtime.delete(message.payload.workspaceId);
          break;
        case "workspace.inspect":
          workspace = await this.runtime.inspect(message.payload.workspaceId);
          break;
      }
      this.#send({
        version: 1,
        type: "response.ok",
        requestId: message.requestId,
        payload: { requestType: message.type, workspace },
      });
    } catch (error) {
      const runtimeError =
        error instanceof WorkspaceRuntimeError
          ? error
          : new WorkspaceRuntimeError(
              "RUNTIME_ENGINE_ERROR",
              "Workspace Runtime operation failed",
              true,
            );
      this.#send({
        version: 1,
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

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(
      this.#reconnectDelayMs * 2,
      this.config.WORKER_RECONNECT_MAX_MS,
    );
    this.log.warn(
      `Worker ${this.config.WORKER_ID} reconnecting in ${delay}ms`,
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }
}
