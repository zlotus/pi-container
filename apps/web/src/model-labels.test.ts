import { describe, expect, it } from "vitest";

import { formatUsd, modelAccessLabel, parseUsdInput } from "./labels.js";

describe("platform model labels (Phase 16)", () => {
  it("describes model access with a reason only when it is unavailable", () => {
    expect(modelAccessLabel({ status: "available", reason: null })).toEqual({ text: "可用", tone: "ok", detail: null });
    expect(modelAccessLabel({ status: "pending", reason: null }).text).toBe("启动后可用");
    expect(modelAccessLabel({ status: "disabled", reason: null }).text).toBe("未启用");
    expect(modelAccessLabel({ status: "unavailable", reason: "USER_CONFIG_INVALID" })).toMatchObject({
      tone: "warn",
      detail: expect.stringContaining("models.json"),
    });
    expect(modelAccessLabel({ status: "unavailable", reason: "SOMETHING_NEW" }).detail).toBe("SOMETHING_NEW");
  });

  it("formats and parses USD budgets", () => {
    expect(formatUsd(null)).toBe("不限");
    expect(formatUsd(0.4)).toBe("$0.40");
    expect(formatUsd(250.4)).toBe("$250");
    expect(parseUsdInput("")).toBe("default");
    expect(parseUsdInput(" 12.5 ")).toBe(12.5);
    expect(parseUsdInput("0")).toBe(0);
    for (const invalid of ["-1", "1.234", "abc", "1e3", "1000001"]) {
      expect(parseUsdInput(invalid), invalid).toBeNull();
    }
  });
});

describe("platform model page texts (Phase 16)", () => {
  it("summarizes the user's usage only when platform models are enabled", async () => {
    const { modelUsageSummary } = await import("./pages/WorkspacesPage.js");
    expect(modelUsageSummary(null)).toBeNull();
    expect(modelUsageSummary({ enabled: false })).toBeNull();
    expect(modelUsageSummary({ enabled: true, available: false, usage: null })).toBe("平台模型用量暂时无法获取。");
    expect(modelUsageSummary({ enabled: true, available: true, usage: null })).toBe("本周期尚未使用平台模型。");
    expect(
      modelUsageSummary({ enabled: true, available: true, usage: { spendUsd: 1.5, maxBudgetUsd: null, budgetResetAt: null } }),
    ).toBe("本周期平台模型花费 $1.50 / 预算 不限。");
  });

  it("describes a Worker's model relay", async () => {
    const { modelRelayText } = await import("./pages/AdminWorkersPage.js");
    expect(modelRelayText({ modelRelay: { enabled: false, port: null, listening: false } })).toBe("未启用");
    expect(modelRelayText({ modelRelay: { enabled: true, port: 3101, listening: true } })).toBe("已监听端口 3101");
    expect(modelRelayText({ modelRelay: { enabled: true, port: 3101, listening: false } })).toContain("未监听");
  });
});
