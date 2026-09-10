import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.js";
import {
  buildWorkerHeartbeat,
  buildWorkerHello,
  currentArchitecture,
} from "./daemon.js";

const config = loadWorkerConfig({
  CONTROL_PLANE_URL: "wss://control.internal/api/workers/connect",
  WORKER_ID: "worker-01",
  WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
  WORKER_MAX_WORKSPACES: "8",
});

describe("worker daemon messages", () => {
  it("reports only Phase 2 capabilities and bounded host capacity", () => {
    const message = buildWorkerHello(config, {
      hostname: "worker-01.internal",
      architecture: "arm64",
      logicalCpuCount: 8,
      memoryBytes: 16 * 1024 ** 3,
    });

    expect(message).toMatchObject({
      version: 1,
      type: "worker.hello",
      payload: {
        workerId: "worker-01",
        capabilities: {
          browser: false,
          office: false,
          ffmpeg: false,
          python: false,
          node: false,
          rust: false,
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
