import { describe, expect, it, vi } from "vitest";

import { SessionConnectionRegistry } from "./session-connections.js";

describe("SessionConnectionRegistry", () => {
  it("disconnects only the revoked session", () => {
    const registry = new SessionConnectionRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.register({ userId: "user-a", sessionId: "session-a" }, first);
    registry.register({ userId: "user-a", sessionId: "session-b" }, second);

    registry.closeSession("session-a");

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("disconnects every connection for a disabled user", () => {
    const registry = new SessionConnectionRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();
    registry.register({ userId: "user-a", sessionId: "session-a" }, first);
    registry.register({ userId: "user-a", sessionId: "session-b" }, second);
    registry.register({ userId: "user-b", sessionId: "session-c" }, other);

    registry.closeUser("user-a");

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it("does not retain a connection after its unregister callback runs", () => {
    const registry = new SessionConnectionRegistry();
    const disconnect = vi.fn();
    const unregister = registry.register(
      { userId: "user-a", sessionId: "session-a" },
      disconnect,
    );

    unregister();
    unregister();
    registry.closeUser("user-a");

    expect(disconnect).not.toHaveBeenCalled();
  });
});
