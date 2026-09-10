import { randomUUID } from "node:crypto";
import { cpus, hostname, totalmem } from "node:os";

import {
  ControlToWorkerMessageSchema,
  type Architecture,
  type WorkerToControlMessage,
} from "@agent-runtime/protocol";
import WebSocket from "ws";

import type { WorkerConfig } from "./config.js";

type WorkerHelloMessage = Extract<
  WorkerToControlMessage,
  { type: "worker.hello" }
>;
type WorkerHeartbeatMessage = Extract<
  WorkerToControlMessage,
  { type: "worker.heartbeat" }
>;

const NO_PHASE_3_CAPABILITIES = {
  browser: false,
  office: false,
  ffmpeg: false,
  python: false,
  node: false,
  rust: false,
} as const;

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
      capabilities: NO_PHASE_3_CAPABILITIES,
      maxWorkspaces: config.WORKER_MAX_WORKSPACES,
      allocatedWorkspaces: 0,
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
): WorkerHeartbeatMessage {
  return {
    version: 1,
    type: "worker.heartbeat",
    requestId: randomUUID(),
    payload: {
      workerId,
      allocatedWorkspaces: 0,
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

  constructor(
    readonly config: WorkerConfig,
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
      maxPayload: 256 * 1024,
    });
    this.#socket = socket;

    socket.on("open", () => {
      this.#reconnectDelayMs = this.config.WORKER_RECONNECT_INITIAL_MS;
      this.log.info(`Worker ${this.config.WORKER_ID} control channel connected`);
      this.#send(
        buildWorkerHello(this.config, {
          hostname: hostname(),
          architecture: currentArchitecture(process.arch),
          logicalCpuCount: cpus().length,
          memoryBytes: totalmem(),
        }),
      );
      this.#heartbeatTimer = setInterval(() => {
        this.#send(buildWorkerHeartbeat(this.config.WORKER_ID, new Date()));
      }, this.config.WORKER_HEARTBEAT_INTERVAL_MS);
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
      this.#send({
        version: 1,
        type: "response.error",
        requestId: parsed.data.requestId,
        payload: {
          requestType: parsed.data.type,
          code: "WORKSPACE_RUNTIME_NOT_IMPLEMENTED",
          message: "Workspace runtime commands begin in Phase 3",
          retryable: false,
        },
      });
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
