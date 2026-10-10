import { describe, expect, it } from "vitest";

import { formatCores, resourceUsageLevel } from "./labels.js";
import { hostResourcesText } from "./pages/AdminWorkersPage.js";

const GIB = 1024 ** 3;

describe("observed usage labels (Phase 17.7)", () => {
  it("formats cores and grades usage against the limit", () => {
    expect(formatCores(0.345)).toBe("0.35");
    expect(formatCores(2)).toBe("2");
    expect(formatCores(null)).toBe("—");
    expect(resourceUsageLevel(null, 2)).toBe("unknown");
    expect(resourceUsageLevel(1.79, 2)).toBe("ok");
    expect(resourceUsageLevel(1.8, 2)).toBe("warning");
    expect(resourceUsageLevel(3.9 * GIB, 4 * GIB)).toBe("warning");
  });

  it("shows host capacity until the Worker reports usage", () => {
    const systemResources = { logicalCpuCount: 8, memoryBytes: 16 * GIB };
    expect(hostResourcesText({ systemResources, usage: null })).toEqual({
      summary: "8 vCPU · 16 GiB",
      detail: null,
    });
    const text = hostResourcesText({
      systemResources,
      usage: {
        hostCpuUtilization: 0.254,
        hostMemoryTotalBytes: 16 * GIB,
        hostMemoryAvailableBytes: 7.5 * GIB,
        load1: 1.5,
        workspaceCpuCores: 1.25,
        workspaceMemoryBytes: 2 * GIB,
        runningWorkspaces: 2,
        sampledAt: "2026-10-10T08:00:00.000Z",
      },
    });
    expect(text.summary).toBe("CPU 25% · 可用内存 7.5 GiB / 16 GiB");
    expect(text.detail).toContain("2 个运行中的 Workspace 合计 CPU 1.25 核、内存 2 GiB");
  });
});
