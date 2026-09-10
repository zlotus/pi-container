import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.js";

describe("worker configuration", () => {
  it("requires a long token and WebSocket control-plane URL", () => {
    expect(() =>
      loadWorkerConfig({
        CONTROL_PLANE_URL: "https://control.internal/worker",
        WORKER_ID: "worker-01",
        WORKER_TOKEN: "short",
      }),
    ).toThrow();
  });

  it("accepts a bounded worker identity", () => {
    const config = loadWorkerConfig({
      CONTROL_PLANE_URL: "wss://control.internal/worker",
      WORKER_ID: "worker-arm64-01",
      WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
    });

    expect(config.WORKER_ID).toBe("worker-arm64-01");
  });
});
