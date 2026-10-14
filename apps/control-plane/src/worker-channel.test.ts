import type { ControlToWorkerMessage } from "@agent-runtime/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlatformMetrics } from "./metrics/platform-metrics.js";
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
    version: 6,
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
      version: 6 as const,
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
      version: 6 as const,
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
        version: 6,
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

describe("worker channel disconnect (Phase 18.6)", () => {
  it("closes only the named Worker's connection", () => {
    const channel = new WorkerChannel(1_000);
    const revoked = new FakeSocket();
    const other = new FakeSocket();
    channel.register("worker-a", revoked);
    channel.register("worker-b", other);

    expect(channel.disconnect("worker-a", 1008, "Worker revoked")).toBe(true);
    expect(channel.disconnect("worker-missing", 1008, "Worker revoked")).toBe(false);

    expect(revoked.closes).toEqual([{ code: 1008, reason: "Worker revoked" }]);
    expect(other.closes).toEqual([]);
    expect(channel.isConnected("worker-a")).toBe(false);
    expect(channel.isConnected("worker-b")).toBe(true);
  });
});

describe("worker command metrics (Phase 17.4)", () => {
  function command(requestId: string): ControlToWorkerMessage {
    return { ...inspectCommand(), requestId };
  }

  async function count(metrics: PlatformMetrics, series: string): Promise<number> {
    const line = (await metrics.registry.metrics())
      .split("\n")
      .find((candidate) => candidate.startsWith(`${series} `));
    return line === undefined ? 0 : Number(line.slice(series.length + 1));
  }

  it("counts every command outcome, including timeouts", async () => {
    vi.useFakeTimers();
    const metrics = new PlatformMetrics();
    const channel = new WorkerChannel(1_000, metrics);
    const socket = new FakeSocket();

    await expect(channel.dispatch("worker-01", command(crypto.randomUUID()))).rejects.toMatchObject({
      code: "WORKER_NOT_CONNECTED",
    });
    channel.register("worker-01", socket);

    const okId = crypto.randomUUID();
    const ok = channel.dispatch("worker-01", command(okId));
    channel.acceptResponse("worker-01", {
      version: 6,
      type: "response.ok",
      requestId: okId,
      payload: { requestType: "workspace.inspect", workspace: WORKSPACE_OBSERVATION },
    });
    await ok;

    const errorId = crypto.randomUUID();
    const failed = channel.dispatch("worker-01", command(errorId));
    channel.acceptResponse("worker-01", {
      version: 6,
      type: "response.error",
      requestId: errorId,
      payload: { requestType: "workspace.inspect", code: "EGRESS_UNENFORCED", message: "x", retryable: false },
    });
    await failed;

    const mismatchId = crypto.randomUUID();
    const mismatched = channel.dispatch("worker-01", command(mismatchId));
    channel.acceptResponse("worker-01", {
      version: 6,
      type: "response.ok",
      requestId: mismatchId,
      payload: { requestType: "workspace.start", workspace: WORKSPACE_OBSERVATION },
    });
    await expect(mismatched).rejects.toMatchObject({ code: "WORKER_RESPONSE_MISMATCH" });

    const timedOut = channel.dispatch("worker-01", command(crypto.randomUUID()));
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ code: "WORKER_COMMAND_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1_000);
    await timeoutAssertion;

    const closed = channel.dispatch("worker-01", command(crypto.randomUUID()));
    channel.unregister("worker-01", socket);
    await expect(closed).rejects.toMatchObject({ code: "WORKER_CONNECTION_CLOSED" });

    const series = (result: string) =>
      `agent_runtime_worker_commands_total{command="workspace.inspect",result="${result}"}`;
    for (const result of ["ok", "error", "timeout", "not_connected", "connection_closed", "mismatch"]) {
      expect(await count(metrics, series(result)), result).toBe(1);
    }
    expect(
      await count(metrics, 'agent_runtime_worker_command_errors_total{command="workspace.inspect",code="EGRESS_UNENFORCED"}'),
    ).toBe(1);
    expect(
      await count(metrics, 'agent_runtime_worker_command_duration_seconds_bucket{le="15",command="workspace.inspect"}'),
    ).toBe(6);
  });
});
