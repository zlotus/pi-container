import { describe, expect, it } from "vitest";

import { retryAfterText } from "./api.js";
import { authLockSubject } from "./components/AuthLocksPanel.js";
import { describeAuditEvent } from "./components/AuditEventRow.js";
import { diskUsageLevel, formatBytes, lockScopeLabel, parseGibInput } from "./labels.js";

const GIB = 1024 ** 3;

describe("disk usage labels (Phase 15)", () => {
  it("formats binary sizes compactly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(20 * GIB)).toBe("20 GiB");
    expect(formatBytes(1.25 * GIB)).toBe("1.3 GiB");
    expect(formatBytes(1024 * GIB)).toBe("1 TiB");
    expect(formatBytes(null)).toBe("—");
  });

  it("warns from 90 % and reports full at the limit", () => {
    expect(diskUsageLevel(null, 20 * GIB)).toBe("unknown");
    expect(diskUsageLevel(17 * GIB, 20 * GIB)).toBe("ok");
    expect(diskUsageLevel(18 * GIB, 20 * GIB)).toBe("warning");
    expect(diskUsageLevel(20 * GIB, 20 * GIB)).toBe("full");
    expect(diskUsageLevel(25 * GIB, 20 * GIB)).toBe("full");
  });

  it("parses administrator GiB input strictly", () => {
    expect(parseGibInput(" 20 ")).toBe(20 * GIB);
    expect(parseGibInput("1.5")).toBe(1.5 * GIB);
    for (const invalid of ["", "0", "-1", "20G", "1e3", "abc"]) {
      expect(parseGibInput(invalid)).toBeNull();
    }
  });
});

describe("login lock labels (Phase 15)", () => {
  it("turns Retry-After into minutes", () => {
    expect(retryAfterText("900")).toBe("请在 15 分钟后重试");
    expect(retryAfterText("5")).toBe("请在 1 分钟后重试");
    expect(retryAfterText(null)).toBeNull();
    expect(retryAfterText("soon")).toBeNull();
  });

  it("names the locked account and address", () => {
    expect(
      authLockSubject({
        id: "l",
        scope: "login_ip",
        ipAddress: "198.51.100.7",
        user: { id: "u", email: "a@example.test" },
        failures: 5,
        lockedUntil: "2026-10-06T08:15:00.000Z",
      }),
    ).toBe("a@example.test · 198.51.100.7");
    expect(lockScopeLabel("login")).toBe("账户（全部来源）");
  });

  it("describes lock and disk-limit audit events", () => {
    const event = (eventType: string, details: Record<string, unknown>) => ({
      id: "1",
      eventType,
      actorUserId: null,
      ownerUserId: null,
      workspaceId: null,
      workerId: null,
      details,
      createdAt: "2026-10-06T08:00:00.000Z",
    });
    expect(
      describeAuditEvent(event("auth.login_locked", { scope: "ip", ipAddress: "198.51.100.7" }), [], [], true),
    ).toMatchObject({ label: "登录已临时锁定", detail: "来源地址 · 198.51.100.7", severity: "danger" });
    expect(
      describeAuditEvent(
        event("workspace.storage_limit_changed", { previousLimitBytes: 20 * GIB, limitBytes: 50 * GIB }),
        [],
        [],
        true,
      ),
    ).toMatchObject({ label: "Workspace 磁盘上限已调整", detail: "20 GiB → 50 GiB" });
  });
});
