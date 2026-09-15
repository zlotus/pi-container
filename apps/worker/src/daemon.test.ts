import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { loadWorkerConfig } from "./config.js";
import {
  buildWorkerHeartbeat,
  buildWorkerHello,
  currentArchitecture,
  WorkerDaemon,
  type WorkspaceRuntime,
} from "./daemon.js";

const config = loadWorkerConfig({
  CONTROL_PLANE_URL: "wss://control.internal/api/workers/connect",
  WORKER_ID: "worker-01",
  WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
  WORKER_GATEWAY_TOKEN: "gateway0123456789abcdef0123456789abcdef",
  WORKSPACE_BASE_URL: "https://agent.example.internal",
  WORKER_MAX_WORKSPACES: "8",
});

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
    const runtime: WorkspaceRuntime = {
      ensure: vi.fn<WorkspaceRuntime["ensure"]>(),
      start: vi.fn<WorkspaceRuntime["start"]>(),
      stop: vi.fn<WorkspaceRuntime["stop"]>(),
      delete: vi.fn<WorkspaceRuntime["delete"]>(),
      inspect: vi.fn<WorkspaceRuntime["inspect"]>(),
      reconcile: vi.fn<WorkspaceRuntime["reconcile"]>(),
      allocatedWorkspaces: vi.fn().mockResolvedValue(0),
    };
    const rootCause = new Error("Docker image not found");
    const error = new Error("Capability probe failed", { cause: rootCause });
    const log = { info: vi.fn(), warn: vi.fn() };
    const daemon = new WorkerDaemon(
      { ...config, CONTROL_PLANE_URL: `ws://127.0.0.1:${address.port}` },
      runtime,
      { probe: vi.fn().mockRejectedValue(error) },
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
        "Worker worker-01 could not verify the configured Runtime image",
        error,
      );
      expect(message).not.toHaveBeenCalled();
    } finally {
      daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports probed Runtime capabilities and bounded host capacity", () => {
    const capabilities = {
      browser: true,
      office: true,
      ffmpeg: true,
      python: true,
      node: true,
      rust: true,
    };
    const message = buildWorkerHello(config, {
      hostname: "worker-01.internal",
      architecture: "arm64",
      logicalCpuCount: 8,
      memoryBytes: 16 * 1024 ** 3,
    }, capabilities);

    expect(message).toMatchObject({
      version: 1,
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
      },
    });
  });

  it("uses a fresh request id and timestamp for each heartbeat", () => {
    const first = buildWorkerHeartbeat(
      "worker-01",
      new Date("2026-09-10T08:00:00.000Z"),
    );
    const second = buildWorkerHeartbeat(
      "worker-01",
      new Date("2026-09-10T08:00:10.000Z"),
    );

    expect(first.requestId).not.toBe(second.requestId);
    expect(first.payload).toMatchObject({
      workerId: "worker-01",
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
