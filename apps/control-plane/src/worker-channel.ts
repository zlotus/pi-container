import {
  ControlToWorkerMessageSchema,
  type ControlToWorkerMessage,
  type WorkerToControlMessage,
} from "@agent-runtime/protocol";

interface ChannelSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type WorkerResponse = Extract<
  WorkerToControlMessage,
  { type: "response.ok" | "response.error" }
>;

interface PendingCommand {
  workerId: string;
  requestType: ControlToWorkerMessage["type"];
  timer: NodeJS.Timeout;
  resolve: (message: WorkerResponse) => void;
  reject: (error: Error) => void;
}

export class WorkerChannelError extends Error {
  constructor(
    readonly code:
      | "WORKER_NOT_CONNECTED"
      | "WORKER_COMMAND_TIMEOUT"
      | "WORKER_CONNECTION_CLOSED"
      | "DUPLICATE_WORKER_REQUEST_ID"
      | "WORKER_RESPONSE_MISMATCH",
    message: string,
  ) {
    super(message);
  }
}

export class WorkerChannel {
  readonly #connections = new Map<string, ChannelSocket>();
  readonly #pending = new Map<string, PendingCommand>();

  constructor(readonly commandTimeoutMs: number) {}

  isConnected(workerId: string): boolean {
    return this.#connections.get(workerId)?.readyState === 1;
  }

  register(workerId: string, socket: ChannelSocket): void {
    const existing = this.#connections.get(workerId);
    if (existing !== undefined && existing !== socket) {
      existing.close(4000, "Worker connection superseded");
    }
    this.#connections.set(workerId, socket);
  }

  unregister(workerId: string, socket: ChannelSocket): void {
    if (this.#connections.get(workerId) !== socket) return;
    this.#connections.delete(workerId);
    for (const [requestId, pending] of this.#pending) {
      if (pending.workerId !== workerId) continue;
      clearTimeout(pending.timer);
      pending.reject(
        new WorkerChannelError(
          "WORKER_CONNECTION_CLOSED",
          `Worker ${workerId} disconnected before responding`,
        ),
      );
      this.#pending.delete(requestId);
    }
  }

  dispatch(
    workerId: string,
    message: ControlToWorkerMessage,
  ): Promise<WorkerResponse> {
    const parsed = ControlToWorkerMessageSchema.parse(message);
    const socket = this.#connections.get(workerId);
    if (socket === undefined || socket.readyState !== 1) {
      return Promise.reject(
        new WorkerChannelError(
          "WORKER_NOT_CONNECTED",
          `Worker ${workerId} is not connected`,
        ),
      );
    }
    if (this.#pending.has(parsed.requestId)) {
      return Promise.reject(
        new WorkerChannelError(
          "DUPLICATE_WORKER_REQUEST_ID",
          `Request ${parsed.requestId} is already pending`,
        ),
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(parsed.requestId);
        reject(
          new WorkerChannelError(
            "WORKER_COMMAND_TIMEOUT",
            `Worker ${workerId} did not respond before the command timeout`,
          ),
        );
      }, this.commandTimeoutMs);
      this.#pending.set(parsed.requestId, {
        workerId,
        requestType: parsed.type,
        timer,
        resolve,
        reject,
      });
      try {
        socket.send(JSON.stringify(parsed));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(parsed.requestId);
        reject(
          new WorkerChannelError(
            "WORKER_CONNECTION_CLOSED",
            `Worker ${workerId} disconnected before the command was sent`,
          ),
        );
      }
    });
  }

  acceptResponse(workerId: string, message: WorkerResponse): boolean {
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) return false;
    if (pending.workerId !== workerId) return false;
    if (pending.requestType !== message.payload.requestType) {
      clearTimeout(pending.timer);
      this.#pending.delete(message.requestId);
      pending.reject(
        new WorkerChannelError(
          "WORKER_RESPONSE_MISMATCH",
          "Worker response does not match the correlated command",
        ),
      );
      return false;
    }

    clearTimeout(pending.timer);
    this.#pending.delete(message.requestId);
    pending.resolve(message);
    return true;
  }
}
