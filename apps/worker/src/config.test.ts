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

describe("model relay configuration (Phase 16.10)", () => {
  const BASE = {
    CONTROL_PLANE_URL: "wss://control.internal/worker",
    WORKER_ID: "worker-01",
    WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
    WORKER_GATEWAY_TOKEN: "gateway0123456789abcdef0123456789abcdef",
    WORKSPACE_BASE_URL: "https://agent.example.internal",
    WORKER_MAX_WORKSPACES: "4",
  };

  it("is off without a gateway URL and defaults to port 3101 with 32 MiB bodies", () => {
    expect(loadWorkerConfig(BASE).WORKER_MODEL_GATEWAY_URL).toBeUndefined();
    const config = loadWorkerConfig({ ...BASE, WORKER_MODEL_GATEWAY_URL: "http://127.0.0.1:4400" });
    expect(config.WORKER_MODEL_RELAY_PORT).toBe(3101);
    expect(config.WORKER_MODEL_RELAY_MAX_BODY_BYTES).toBe(32 * 1024 ** 2);
  });

  it.each([
    { WORKER_MODEL_GATEWAY_URL: "ftp://gateway.internal" },
    { WORKER_MODEL_GATEWAY_URL: "http://user:secret@gateway.internal" },
    { WORKER_MODEL_GATEWAY_URL: "http://gateway.internal/?key=sk-x" },
    { WORKER_MODEL_GATEWAY_URL: "http://gateway.internal", WORKER_MODEL_RELAY_PORT: "3100" },
    { WORKER_MODEL_GATEWAY_URL: "http://gateway.internal", WORKER_MODEL_RELAY_MAX_BODY_BYTES: "1" },
  ])("rejects %o", (override) => {
    expect(() => loadWorkerConfig({ ...BASE, ...override })).toThrow();
  });
});
