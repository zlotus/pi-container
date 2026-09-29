import { describe, expect, it } from "vitest";

import { auditSeverity } from "./components/AuditEventRow.js";
import {
  formatRelativeTime,
  STARTABLE_WORKSPACE_STATES,
  TRANSITIONAL_WORKSPACE_STATES,
  transitionValueLabel,
  workerStatusLabel,
  workspaceStateLabel,
} from "./labels.js";
import { hasTransitionalWorkspace, workspaceSummary } from "./pages/WorkspacesPage.js";

const now = Date.parse("2026-09-29T08:00:00.000Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

describe("Portal labels", () => {
  it("localizes platform enums and keeps unknown values visible", () => {
    expect(workspaceStateLabel("WORKER_OFFLINE")).toBe("Worker 离线");
    expect(workerStatusLabel("ONLINE")).toBe("在线");
    expect(transitionValueLabel("disabled")).toBe("已禁用");
    expect(workspaceStateLabel("FUTURE_STATE")).toBe("FUTURE_STATE");
  });

  it("formats relative time and carries rounding into the next unit", () => {
    expect(formatRelativeTime(ago(10), now)).toBe("刚刚");
    expect(formatRelativeTime(ago(5 * 60), now)).toBe("5分钟前");
    expect(formatRelativeTime(ago(23.8 * 3600), now)).toBe("昨天");
    expect(formatRelativeTime(ago(19 * 24 * 3600), now)).toBe("19天前");
    expect(formatRelativeTime("not-a-date", now)).toBe("—");
  });
});

describe("Workspace page helpers", () => {
  it("polls only while a Workspace is in a transitional state", () => {
    expect(hasTransitionalWorkspace([{ state: "RUNNING" }, { state: "STOPPED" }])).toBe(false);
    expect(hasTransitionalWorkspace([{ state: "RUNNING" }, { state: "STARTING" }])).toBe(true);
    expect(hasTransitionalWorkspace([{ state: "WORKER_OFFLINE" }])).toBe(false);
    // A new Workspace waits in CREATED until the user starts it; it must not be treated as settling.
    expect(hasTransitionalWorkspace([{ state: "CREATED" }])).toBe(false);
  });

  it("allows start exactly in the states the Control Plane accepts", () => {
    expect([...STARTABLE_WORKSPACE_STATES].sort()).toEqual(
      ["CREATED", "ERROR", "STOPPED", "WORKER_OFFLINE"],
    );
    for (const state of STARTABLE_WORKSPACE_STATES) {
      expect(TRANSITIONAL_WORKSPACE_STATES).not.toContain(state);
    }
  });

  it("summarizes total and running Workspaces", () => {
    expect(workspaceSummary([{ state: "RUNNING" }, { state: "STOPPED" }])).toBe(
      "共 2 个 Workspace，1 个运行中。",
    );
  });
});

describe("Audit severity", () => {
  it("highlights failures and risky management events", () => {
    expect(auditSeverity("auth.login_failed")).toBe("danger");
    expect(auditSeverity("worker.offline")).toBe("danger");
    expect(auditSeverity("user.disabled")).toBe("warning");
    expect(auditSeverity("workspace.running")).toBe("success");
    expect(auditSeverity("workspace.opened")).toBe("info");
    expect(auditSeverity("worker.scheduling_paused")).toBe("warning");
    expect(auditSeverity("worker.scheduling_resumed")).toBe("success");
  });
});
