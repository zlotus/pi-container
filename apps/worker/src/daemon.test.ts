import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { loadWorkerConfig } from "./config.js";
import {
  buildWorkerHeartbeat,
  buildWorkerHello,
  currentArchitecture,
  type WorkerEgress,
  WorkerDaemon,
  type WorkspaceRuntime,
} from "./daemon.js";
import { EgressApplyError } from "./egress/controller.js";

const config = loadWorkerConfig({
  CONTROL_PLANE_URL: "wss://control.internal/api/workers/connect",
  WORKER_ID: "worker-01",
  WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
  WORKER_GATEWAY_TOKEN: "gateway0123456789abcdef0123456789abcdef",
  WORKSPACE_BASE_URL: "https://agent.example.internal",
  WORKER_MAX_WORKSPACES: "8",
});

function fakeRuntime(): WorkspaceRuntime {
  return {
    ensure: vi.fn<WorkspaceRuntime["ensure"]>(),
    start: vi.fn<WorkspaceRuntime["start"]>(),
    stop: vi.fn<WorkspaceRuntime["stop"]>(),
    delete: vi.fn<WorkspaceRuntime["delete"]>(),
    inspect: vi.fn<WorkspaceRuntime["inspect"]>(),
    reconcile: vi.fn<WorkspaceRuntime["reconcile"]>(),
    allocatedWorkspaces: vi.fn().mockResolvedValue(0),
    stopRunningWorkspaces: vi.fn().mockResolvedValue([]),
  };
}

function fakeEgress(enforced = true): WorkerEgress {
  return {
    status: vi.fn().mockReturnValue({ enforced, revision: null }),
    ensure: vi.fn().mockResolvedValue({ enforced, revision: null }),
    apply: vi.fn(),
  };
}

const capabilities = {
  browser: true,
  office: true,
  ffmpeg: true,
  python: true,
  node: true,
  rust: true,
};

async function listen(): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP test server address");
  }
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

describe("worker daemon messages", () => {
  it("logs the probe root cause and closes without sending hello", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP test server address");
    }
    let closed: { code: number; reason: string } | undefined;
    const message = vi.fn();
    server.on("connection", (socket) => {
      socket.on("message", message);
      socket.on("close", (code, reason) => {
        closed = { code, reason: reason.toString() };
      });
    });
    const runtime = fakeRuntime();
    const rootCause = new Error("Docker image not found");
    const error = new Error("Capability probe failed", { cause: rootCause });
    const log = { info: vi.fn(), warn: vi.fn() };
    const daemon = new WorkerDaemon(
      { ...config, CONTROL_PLANE_URL: `ws://127.0.0.1:${address.port}` },
      runtime,
      { probe: vi.fn().mockRejectedValue(error) },
      fakeEgress(),
      log,
    );
    try {
      daemon.start();
      await vi.waitFor(() => {
        expect(closed).toEqual({
          code: 1011,
          reason: "Configured Runtime image unavailable or unverified",
        });
      });
      expect(log.warn).toHaveBeenCalledWith(
        { workerId: "worker-01", err: error },
        "could not verify the configured Runtime image",
      );
      expect(message).not.toHaveBeenCalled();
    } finally {
      daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports probed Runtime capabilities, egress state and bounded host capacity", () => {
    const message = buildWorkerHello(config, {
      hostname: "worker-01.internal",
      architecture: "arm64",
      logicalCpuCount: 8,
      memoryBytes: 16 * 1024 ** 3,
    }, capabilities, { enforced: true, revision: 4 });

    expect(message).toMatchObject({
      version: 2,
      type: "worker.hello",
      payload: {
        workerId: "worker-01",
        capabilities: {
          browser: true,
          office: true,
          ffmpeg: true,
          python: true,
          node: true,
          rust: true,
        },
        maxWorkspaces: 8,
        allocatedWorkspaces: 0,
        egress: { enforced: true, revision: 4 },
      },
    });
  });

  it("uses a fresh request id and timestamp for each heartbeat", () => {
    const first = buildWorkerHeartbeat(
      "worker-01",
      new Date("2026-09-10T08:00:00.000Z"),
      { enforced: false, revision: null },
    );
    const second = buildWorkerHeartbeat(
      "worker-01",
      new Date("2026-09-10T08:00:10.000Z"),
      { enforced: true, revision: 1 },
    );

    expect(first.requestId).not.toBe(second.requestId);
    expect(first.payload).toMatchObject({
      workerId: "worker-01",
      egress: { enforced: false, revision: null },
      observedAt: "2026-09-10T08:00:00.000Z",
    });
  });

  it("maps only supported MVP architectures", () => {
    expect(currentArchitecture("x64")).toBe("amd64");
    expect(currentArchitecture("arm64")).toBe("arm64");
    expect(() => currentArchitecture("riscv64")).toThrow(
      "Unsupported Worker architecture",
    );
  });

});

describe("worker daemon egress", () => {
  it("stops running Workspaces when the egress rules cannot be enforced", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.stopRunningWorkspaces).mockResolvedValue([
      "8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a10",
    ]);
    const log = { info: vi.fn(), warn: vi.fn() };
    const daemon = new WorkerDaemon(
      config,
      runtime,
      { probe: vi.fn() },
      fakeEgress(false),
      log,
    );

    await expect(daemon.checkEgress()).resolves.toEqual({
      enforced: false,
      revision: null,
    });
    expect(runtime.stopRunningWorkspaces).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      {
        workerId: "worker-01",
        workspaceIds: ["8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a10"],
      },
      "stopped running Workspaces because egress rules are not enforced",
    );
  });

  it("leaves running Workspaces alone while the egress rules are enforced", async () => {
    const runtime = fakeRuntime();
    const daemon = new WorkerDaemon(
      config,
      runtime,
      { probe: vi.fn() },
      fakeEgress(true),
      { info: vi.fn(), warn: vi.fn() },
    );

    await daemon.checkEgress();
    expect(runtime.stopRunningWorkspaces).not.toHaveBeenCalled();
  });

  it("answers worker.egress.apply with the applied status or a typed error", async () => {
    const { server, url } = await listen();
    const egress = fakeEgress(true);
    vi.mocked(egress.apply)
      .mockResolvedValueOnce({ enforced: true, revision: 7 })
      .mockRejectedValueOnce(new EgressApplyError("nft could not apply"));
    const received: unknown[] = [];
    let workerSocket: WebSocket | undefined;
    server.on("connection", (socket) => {
      workerSocket = socket;
      socket.on("message", (data) => received.push(JSON.parse(data.toString())));
    });
    const daemon = new WorkerDaemon(
      { ...config, CONTROL_PLANE_URL: url },
      fakeRuntime(),
      { probe: vi.fn().mockResolvedValue(capabilities) },
      egress,
      { info: vi.fn(), warn: vi.fn() },
    );
    const policy = {
      revision: 7,
      allow: [{ network: "192.168.1.1/32", protocol: "tcp", portMin: 80, portMax: 80 }],
      denyExtra: [],
      protected: ["10.0.0.5/32"],
    };
    try {
      daemon.start();
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toMatchObject({
        type: "worker.hello",
        payload: { egress: { enforced: true, revision: null } },
      });
      for (const requestId of [
        "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d01",
        "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d02",
      ]) {
        workerSocket?.send(
          JSON.stringify({
            version: 2,
            type: "worker.egress.apply",
            requestId,
            payload: policy,
          }),
        );
      }
      await vi.waitFor(() => expect(received).toHaveLength(3));
      expect(egress.apply).toHaveBeenCalledWith(policy);
      expect(received[1]).toEqual({
        version: 2,
        type: "response.ok",
        requestId: "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d01",
        payload: {
          requestType: "worker.egress.apply",
          egress: { enforced: true, revision: 7 },
        },
      });
      expect(received[2]).toEqual({
        version: 2,
        type: "response.error",
        requestId: "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d02",
        payload: {
          requestType: "worker.egress.apply",
          code: "EGRESS_APPLY_FAILED",
          message: "Egress rules could not be applied",
          retryable: true,
        },
      });
    } finally {
      daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
