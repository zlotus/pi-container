import { describe, expect, it } from "vitest";

import { describeAuditEvent } from "./components/AuditEventRow.js";
import { runtimeLabel, TRANSITIONAL_WORKSPACE_STATES, workspaceStateLabel } from "./labels.js";
import { runtimeChangeable } from "./pages/AdminWorkspacesPage.js";
import { runtimeActions } from "./pages/WorkspacesPage.js";
import type { WorkspaceRuntime } from "./types.js";

const event = (eventType: string, details: Record<string, unknown>) => ({
  id: "1",
  eventType,
  actorUserId: null,
  ownerUserId: null,
  workspaceId: null,
  workerId: "worker-c",
  details,
  createdAt: "2026-10-12T08:00:00.000Z",
});

describe("Worker revocation audit labels (Phase 18.6)", () => {
  it("describes disable, enable and delete", () => {
    expect(
      describeAuditEvent(
        event("worker.disabled", { source: "cli", fromStatus: "ONLINE", workspaces: 2, modelKeys: 1 }),
        [],
        [],
        true,
      ),
    ).toMatchObject({
      label: "Worker 已禁用",
      detail: "2 个 Workspace 已离线 · 1 个模型凭据吊销中",
      severity: "warning",
    });
    expect(describeAuditEvent(event("worker.enabled", { source: "cli" }), [], [], true)).toMatchObject({
      label: "Worker 已重新启用",
      severity: "success",
    });
    expect(
      describeAuditEvent(event("worker.deleted", { source: "cli", status: "DISABLED" }), [], [], true),
    ).toMatchObject({ label: "Worker 已删除", severity: "warning" });
  });
});

describe("Runtime version display and actions (Phase 18.8)", () => {
  const runtime = (overrides: Partial<WorkspaceRuntime> = {}): WorkspaceRuntime => ({
    image: "agent-runtime:phase7-toolchain",
    runtimeVersion: "phase-7",
    piWebVersion: null,
    piVersion: null,
    previousImage: null,
    upgradeAvailable: false,
    rollbackAvailable: false,
    changeIncomplete: false,
    ...overrides,
  });

  it("labels a Runtime by version and pi-web / Pi versions", () => {
    expect(runtimeLabel(runtime())).toBe("phase-7");
    expect(runtimeLabel(runtime({ runtimeVersion: "phase-18", piWebVersion: "0.12.0", piVersion: "1.1.0" }))).toBe(
      "phase-18（pi-web 0.12.0 · Pi 1.1.0）",
    );
    expect(runtimeLabel(runtime({ runtimeVersion: null }))).toBe("agent-runtime:phase7-toolchain");
  });

  it("offers upgrade, rollback or retry only when the API allows them", () => {
    expect(runtimeActions({ runtime: null })).toEqual([]);
    expect(runtimeActions({ runtime: runtime() })).toEqual([]);
    expect(runtimeActions({ runtime: runtime({ upgradeAvailable: true, rollbackAvailable: true }) })).toEqual([
      "upgrade",
      "rollback",
    ]);
    expect(
      runtimeActions({ runtime: runtime({ changeIncomplete: true, upgradeAvailable: true, rollbackAvailable: true }) }),
    ).toEqual(["retry", "rollback"]);
  });

  it("lets an admin switch only stopped Workspaces whose Worker offers another image", () => {
    const offered = [
      { image: "a:1", runtimeVersion: "v1" },
      { image: "a:2", runtimeVersion: "v2" },
    ];
    expect(runtimeChangeable({ state: "STOPPED", runtime: runtime(), offeredImages: offered })).toBe(true);
    expect(runtimeChangeable({ state: "RUNNING", runtime: runtime(), offeredImages: offered })).toBe(false);
    expect(runtimeChangeable({ state: "STOPPED", runtime: runtime(), offeredImages: offered.slice(0, 1) })).toBe(false);
    expect(
      runtimeChangeable({ state: "ERROR", runtime: runtime({ changeIncomplete: true }), offeredImages: offered }),
    ).toBe(true);
  });

  it("names the UPGRADING state and polls while it lasts", () => {
    expect(workspaceStateLabel("UPGRADING")).toBe("Runtime 切换中");
    expect(TRANSITIONAL_WORKSPACE_STATES).toContain("UPGRADING");
  });
});
