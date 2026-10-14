import { describe, expect, it } from "vitest";

import { describeAuditEvent } from "./components/AuditEventRow.js";
import { runtimeLabel, TRANSITIONAL_WORKSPACE_STATES, workspaceStateLabel } from "./labels.js";
import { runtimeChangeable } from "./pages/AdminWorkspacesPage.js";
import { idleNote, runtimeActions } from "./pages/WorkspacesPage.js";
import { idlePolicyText } from "./pages/AdminWorkersPage.js";
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

describe("idle stop notes (Phase 18.5)", () => {
  it("explains an idle stop and warns while running under the policy", () => {
    expect(idleNote({ state: "STOPPED", lastStopReason: "idle" }, null)).toContain("因长时间空闲已自动停止");
    expect(idleNote({ state: "STOPPED", lastStopReason: null }, 24)).toBeNull();
    expect(idleNote({ state: "RUNNING", lastStopReason: null }, 24)).toBe(
      "无连接、无访问且无计算活动 24 小时后将自动停止",
    );
    expect(idleNote({ state: "RUNNING", lastStopReason: null }, null)).toBeNull();
  });

  it("shows how long a running Workspace has been idle and when it stops", () => {
    const now = new Date(2026, 9, 14, 15, 30);
    const running = (idle: { connected: boolean; idleSince: Date; stopAt: Date }) => ({
      state: "RUNNING",
      lastStopReason: null,
      idle: { connected: idle.connected, idleSince: idle.idleSince.toISOString(), stopAt: idle.stopAt.toISOString() },
    });
    expect(
      idleNote(running({ connected: true, idleSince: now, stopAt: new Date(2026, 9, 14, 16, 30) }), 1, now),
    ).toContain("当前有连接，不会被回收");
    expect(
      idleNote(running({ connected: false, idleSince: new Date(2026, 9, 14, 15, 7), stopAt: new Date(2026, 9, 14, 16, 7) }), 1, now),
    ).toBe("已空闲 23 分钟，约 16:07 自动停止；任何访问或计算活动都会重新计时");
    expect(
      idleNote(running({ connected: false, idleSince: new Date(2026, 9, 13, 13, 0), stopAt: new Date(2026, 9, 14, 13, 0) }), 24, now),
    ).toBe("已空闲 26 小时 30 分钟，将在下一次检查（5 分钟内）自动停止");
  });

  it("states the admin policy", () => {
    expect(idlePolicyText({ idle: { enabled: false, stopAfterHours: null, cpuThresholdCores: null }, defaultRuntimeImage: "a" }))
      .toBe("空闲回收：未启用。");
    expect(idlePolicyText({ idle: { enabled: true, stopAfterHours: 24, cpuThresholdCores: 0.05 }, defaultRuntimeImage: "a" }))
      .toContain("0.05 核持续 24 小时");
  });
});
