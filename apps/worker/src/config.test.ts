import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.js";

describe("worker configuration", () => {
  it("requires a long token and WebSocket control-plane URL", () => {
    expect(() =>
      loadWorkerConfig({
        CONTROL_PLANE_URL: "https://control.internal/worker",
        WORKER_ID: "worker-01",
        WORKER_TOKEN: "short",
        WORKER_GATEWAY_TOKEN: "gateway0123456789abcdef0123456789abcdef",
        WORKSPACE_BASE_URL: "https://agent.example.internal",
        WORKER_MAX_WORKSPACES: "4",
      }),
    ).toThrow();
  });

  it("accepts a bounded worker identity", () => {
    const config = loadWorkerConfig({
      CONTROL_PLANE_URL: "wss://control.internal/worker",
      WORKER_ID: "worker-arm64-01",
      WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
      WORKER_GATEWAY_TOKEN: "gateway0123456789abcdef0123456789abcdef",
      WORKSPACE_BASE_URL: "https://agent.example.internal",
      WORKER_MAX_WORKSPACES: "4",
    });

    expect(config.WORKER_ID).toBe("worker-arm64-01");
    expect(config.WORKER_HEARTBEAT_INTERVAL_MS).toBe(10_000);
    expect(config.RUNTIME_IMAGE).toBe("agent-runtime:phase7-toolchain");
    expect(config.RUNTIME_VERSION).toBe("phase-7");
    expect(config.RUNTIME_CAPABILITY_PROBE_TIMEOUT_MS).toBe(120_000);
  });

  it("requires reconnect bounds to be internally consistent", () => {
    expect(() =>
      loadWorkerConfig({
        CONTROL_PLANE_URL: "wss://control.internal/api/workers/connect",
        WORKER_ID: "worker-01",
        WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
        WORKER_GATEWAY_TOKEN: "gateway0123456789abcdef0123456789abcdef",
        WORKSPACE_BASE_URL: "https://agent.example.internal",
        WORKER_MAX_WORKSPACES: "4",
        WORKER_RECONNECT_INITIAL_MS: "5000",
        WORKER_RECONNECT_MAX_MS: "1000",
      }),
    ).toThrow();
  });

  it("rejects reuse of the control credential for the data plane", () => {
    const shared = "shared0123456789abcdef0123456789abcdef";
    expect(() =>
      loadWorkerConfig({
        CONTROL_PLANE_URL: "wss://control.internal/api/workers/connect",
        WORKER_ID: "worker-01",
        WORKER_TOKEN: shared,
        WORKER_GATEWAY_TOKEN: shared,
        WORKER_MAX_WORKSPACES: "4",
        WORKSPACE_BASE_URL: "https://agent.example.internal",
      }),
    ).toThrow("must be different");
  });
});
