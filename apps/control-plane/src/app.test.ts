import { describe, expect, it, vi } from "vitest";

import { buildControlPlane } from "./app.js";

describe("control plane probes", () => {
  it("reports liveness without consulting PostgreSQL", async () => {
    const checkDatabase = vi.fn<() => Promise<void>>();
    const app = buildControlPlane({ checkDatabase });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "control-plane",
      status: "ok",
    });
    expect(checkDatabase).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports failed PostgreSQL readiness as unavailable", async () => {
    const app = buildControlPlane({
      checkDatabase: async () => {
        throw new Error("database unavailable");
      },
    });

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    await app.close();
  });
});
