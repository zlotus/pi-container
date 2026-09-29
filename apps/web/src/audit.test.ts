import { describe, expect, it } from "vitest";

import { auditEventsCsv, auditQueryString, EMPTY_AUDIT_FILTER } from "./audit.js";
import { describeAuditEvent } from "./components/AuditEventRow.js";
import type { AuditEvent } from "./types.js";

describe("audit query string", () => {
  it("sends only the filters that are set, plus the cursor", () => {
    expect(auditQueryString(EMPTY_AUDIT_FILTER, null)).toBe("limit=50");
    const params = new URLSearchParams(auditQueryString(
      { ...EMPTY_AUDIT_FILTER, category: "auth", workerId: "worker-a" },
      "120",
      10,
    ));
    expect(Object.fromEntries(params)).toEqual({
      limit: "10",
      before: "120",
      category: "auth",
      workerId: "worker-a",
    });
  });

  it("turns inclusive local dates into an exclusive UTC range", () => {
    const params = new URLSearchParams(auditQueryString(
      { ...EMPTY_AUDIT_FILTER, fromDate: "2026-09-01", toDate: "2026-09-30" },
      null,
    ));
    expect(params.get("from")).toBe(new Date(2026, 8, 1).toISOString());
    expect(params.get("to")).toBe(new Date(2026, 9, 1).toISOString());
    expect(new URLSearchParams(auditQueryString(
      { ...EMPTY_AUDIT_FILTER, fromDate: "not-a-date" },
      null,
    )).has("from")).toBe(false);
  });
});

describe("audit CSV export", () => {
  const event: AuditEvent = {
    id: "7",
    eventType: "auth.login_failed",
    actorUserId: null,
    ownerUserId: null,
    workspaceId: null,
    workerId: null,
    details: { protocol: "LOCAL", category: "=HYPERLINK(\"http://evil\")" },
    createdAt: "2026-09-29T08:00:00.000Z",
  };

  it("escapes quotes and neutralizes spreadsheet formulas", () => {
    const csv = auditEventsCsv([event], () => ({
      ...describeAuditEvent(event, [], [], true),
      subject: "=cmd|' /C calc'!A0",
      detail: "a,\"b\"",
    }));
    const [header, row] = csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
    expect(header?.startsWith("时间,级别,事件,对象")).toBe(true);
    expect(row).toContain("登录失败");
    expect(row).toContain(",'=cmd|' /C calc'!A0,");
    expect(row).toContain(',"a,""b""",');
    expect(csv.startsWith("\uFEFF")).toBe(true);
  });
});
