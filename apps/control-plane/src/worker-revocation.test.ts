import { describe, expect, it, vi } from "vitest";

import { SessionConnectionRegistry } from "./session-connections.js";
import { enforceWorkerRevocations } from "./worker-revocation.js";

describe("enforceWorkerRevocations", () => {
  it("closes the control channel and Gateway connections of revoked Workers only", async () => {
    const sessionConnections = new SessionConnectionRegistry();
    const revokedConnection = vi.fn();
    const healthyConnection = vi.fn();
    sessionConnections.register(
      { userId: "user-a", sessionId: "session-a", workspaceId: "ws-revoked" },
      revokedConnection,
    );
    sessionConnections.register(
      { userId: "user-a", sessionId: "session-a", workspaceId: "ws-healthy" },
      healthyConnection,
    );
    const connected = new Set(["worker-revoked", "worker-healthy"]);
    const disconnect = vi.fn((workerId: string) => connected.delete(workerId));

    await enforceWorkerRevocations({
      store: {
        listRevokedWorkerAssignments: async () => [
          { workerId: "worker-revoked", workspaceIds: ["ws-revoked"] },
          { workerId: "worker-gone", workspaceIds: [] },
        ],
      },
      channel: { isConnected: (workerId) => connected.has(workerId), disconnect },
      sessionConnections,
    });

    expect(disconnect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledWith("worker-revoked", 1008, "Worker revoked");
    expect(revokedConnection).toHaveBeenCalledOnce();
    expect(healthyConnection).not.toHaveBeenCalled();
    expect(connected.has("worker-healthy")).toBe(true);
  });

  it("still closes Gateway connections after the channel was already closed", async () => {
    const sessionConnections = new SessionConnectionRegistry();
    const connection = vi.fn();
    sessionConnections.register(
      { userId: "user-a", sessionId: "session-a", workspaceId: "ws-1" },
      connection,
    );
    const disconnect = vi.fn(() => true);

    await enforceWorkerRevocations({
      store: {
        listRevokedWorkerAssignments: async () => [{ workerId: "worker-a", workspaceIds: ["ws-1"] }],
      },
      channel: { isConnected: () => false, disconnect },
      sessionConnections,
    });

    expect(disconnect).not.toHaveBeenCalled();
    expect(connection).toHaveBeenCalledOnce();
  });
});
