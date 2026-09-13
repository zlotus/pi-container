import type { ControlToWorkerMessage } from "@agent-runtime/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerChannel } from "./worker-channel.js";
import type { WorkerChannelError } from "./worker-channel.js";

const REQUEST_ID = "0d17d4a0-c25a-43fd-a2eb-3d9ca7c5976c";
const WORKSPACE_ID = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const WORKSPACE_OBSERVATION = {
  workspaceId: WORKSPACE_ID,
  state: "RUNNING" as const,
  runtimeImage: "agent-runtime:test",
  observedAt: "2026-09-10T08:00:00.000Z",
};

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly closes: Array<{
    code: number | undefined;
    reason: string | undefined;
  }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }
}

function inspectCommand(): ControlToWorkerMessage {
  return {
    version: 1,
    type: "workspace.inspect",
    requestId: REQUEST_ID,
    payload: { workspaceId: WORKSPACE_ID },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("worker command correlation", () => {
  it("resolves one correlated response and ignores its duplicate", async () => {
    const channel = new WorkerChannel(1_000);
    const socket = new FakeSocket();
    channel.register("worker-01", socket);
    const result = channel.dispatch("worker-01", inspectCommand());
    const response = {
      version: 1 as const,
      type: "response.ok" as const,
      requestId: REQUEST_ID,
      payload: {
        requestType: "workspace.inspect" as const,
        workspace: WORKSPACE_OBSERVATION,
      },
    };

    expect(channel.acceptResponse("worker-01", response)).toBe(true);
    await expect(result).resolves.toEqual(response);
    expect(channel.acceptResponse("worker-01", response)).toBe(false);
  });

  it("times out without implicitly replaying a command", async () => {
    vi.useFakeTimers();
    const channel = new WorkerChannel(100);
    const socket = new FakeSocket();
    channel.register("worker-01", socket);
    const result = channel.dispatch("worker-01", inspectCommand());
    const rejection = expect(result).rejects.toMatchObject<
      Partial<WorkerChannelError>
    >({
      code: "WORKER_COMMAND_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(socket.sent).toHaveLength(1);
  });

  it("ignores another Worker's response without disturbing the pending command", async () => {
    const channel = new WorkerChannel(1_000);
    const socket = new FakeSocket();
    channel.register("worker-01", socket);
    const result = channel.dispatch("worker-01", inspectCommand());
    const response = {
      version: 1 as const,
      type: "response.ok" as const,
      requestId: REQUEST_ID,
      payload: {
        requestType: "workspace.inspect" as const,
        workspace: WORKSPACE_OBSERVATION,
      },
    };

    expect(channel.acceptResponse("worker-02", response)).toBe(false);
    expect(channel.acceptResponse("worker-01", response)).toBe(true);
    await expect(result).resolves.toEqual(response);
  });

  it("rejects a correlated response with the wrong request type", async () => {
    const channel = new WorkerChannel(1_000);
    const socket = new FakeSocket();
    channel.register("worker-01", socket);
    const result = channel.dispatch("worker-01", inspectCommand());

    expect(
      channel.acceptResponse("worker-01", {
        version: 1,
        type: "response.ok",
        requestId: REQUEST_ID,
        payload: {
          requestType: "workspace.start",
          workspace: WORKSPACE_OBSERVATION,
        },
      }),
    ).toBe(false);
    await expect(result).rejects.toMatchObject<Partial<WorkerChannelError>>({
      code: "WORKER_RESPONSE_MISMATCH",
    });
  });

  it("rejects a duplicate pending request id without sending it", async () => {
    const channel = new WorkerChannel(1_000);
    const socket = new FakeSocket();
    channel.register("worker-01", socket);
    const first = channel.dispatch("worker-01", inspectCommand());
    const duplicate = channel.dispatch("worker-01", inspectCommand());

    await expect(duplicate).rejects.toMatchObject<Partial<WorkerChannelError>>({
      code: "DUPLICATE_WORKER_REQUEST_ID",
    });
    expect(socket.sent).toHaveLength(1);
    const firstRejection = expect(first).rejects.toMatchObject<
      Partial<WorkerChannelError>
    >({
      code: "WORKER_CONNECTION_CLOSED",
    });
    channel.unregister("worker-01", socket);
    await firstRejection;
  });
});
