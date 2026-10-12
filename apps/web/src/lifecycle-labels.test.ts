import { describe, expect, it } from "vitest";

import { describeAuditEvent } from "./components/AuditEventRow.js";

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
