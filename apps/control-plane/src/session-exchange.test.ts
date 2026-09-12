import { describe, expect, it } from "vitest";

import { WorkspaceSessionExchange } from "./session-exchange.js";

const WORKSPACE_A = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const WORKSPACE_B = "740df352-879b-4299-b5ab-a4d613a5ae56";

describe("Workspace session exchange", () => {
  it("is single-use, short-lived, and bound to one Workspace", () => {
    const exchange = new WorkspaceSessionExchange(60_000);
    const now = new Date("2026-09-12T08:00:00.000Z");
    const code = exchange.issue({
      rawSessionToken: "portal-session-token",
      userId: "user-a",
      workspaceId: WORKSPACE_A,
      now,
    });

    expect(exchange.consume(code, WORKSPACE_B, now)).toBeNull();
    expect(exchange.consume(code, WORKSPACE_A, now)).toBeNull();

    const second = exchange.issue({
      rawSessionToken: "portal-session-token",
      userId: "user-a",
      workspaceId: WORKSPACE_A,
      now,
    });
    expect(
      exchange.consume(second, WORKSPACE_A, new Date(now.getTime() + 60_000)),
    ).toBeNull();
  });

  it("returns the bound session exactly once", () => {
    const exchange = new WorkspaceSessionExchange(60_000);
    const now = new Date("2026-09-12T08:00:00.000Z");
    const code = exchange.issue({
      rawSessionToken: "portal-session-token",
      userId: "user-a",
      workspaceId: WORKSPACE_A,
      now,
    });

    expect(exchange.consume(code, WORKSPACE_A, now)).toMatchObject({
      rawSessionToken: "portal-session-token",
      userId: "user-a",
      workspaceId: WORKSPACE_A,
    });
    expect(exchange.consume(code, WORKSPACE_A, now)).toBeNull();
  });

  it("keeps only the newest outstanding code per session and Workspace", () => {
    const exchange = new WorkspaceSessionExchange(60_000);
    const now = new Date("2026-09-12T08:00:00.000Z");
    const input = {
      rawSessionToken: "portal-session-token",
      userId: "user-a",
      workspaceId: WORKSPACE_A,
      now,
    };
    const first = exchange.issue(input);
    const second = exchange.issue(input);

    expect(exchange.consume(first, WORKSPACE_A, now)).toBeNull();
    expect(exchange.consume(second, WORKSPACE_A, now)).not.toBeNull();
  });
});
