import { describe, expect, it, vi } from "vitest";

import { type CommandRunner, ExecXfsQuotaTool, QuotaCommandError } from "./quota.js";

function recorder(result = { code: 0, stdout: "", stderr: "" }) {
  const run = vi.fn<CommandRunner>().mockResolvedValue(result);
  return { run, tool: new ExecXfsQuotaTool("/usr/sbin/xfs_quota", "/usr/bin/lsattr", run) };
}

describe("ExecXfsQuotaTool", () => {
  it("runs fixed argument vectors built only from validated values", async () => {
    const { run, tool } = recorder();
    await tool.setProject("/srv/managed", "/srv/managed/workspaces/abc/workspace", 1_000_001);
    await tool.setLimit("/srv/managed", 1_000_001, { bytes: 20 * 1024 ** 3, inodes: 2_000_000 });
    expect(run.mock.calls.map(([file, args]) => [file, args])).toEqual([
      [
        "/usr/sbin/xfs_quota",
        ["-x", "-c", "project -s -p /srv/managed/workspaces/abc/workspace 1000001", "/srv/managed"],
      ],
      [
        "/usr/sbin/xfs_quota",
        [
          "-x",
          "-c",
          "limit -p bsoft=0 bhard=20971520k isoft=0 ihard=2000000 1000001",
          "/srv/managed",
        ],
      ],
    ]);
  });

  it("refuses paths and numbers that could change the xfs_quota command", async () => {
    const { run, tool } = recorder();
    for (const directory of [
      "relative/dir",
      "/srv/managed/a b",
      "/srv/managed/a;rm",
      "/srv/managed/../etc",
      "/srv/managed/$(id)",
      "/srv/managed/a\nb",
    ]) {
      await expect(tool.setProject("/srv/managed", directory, 1)).rejects.toBeInstanceOf(
        QuotaCommandError,
      );
    }
    for (const projectId of [0, -1, 1.5, 2 ** 32]) {
      await expect(tool.setProject("/srv/managed", "/srv/managed/a", projectId)).rejects.toBeInstanceOf(
        QuotaCommandError,
      );
    }
    for (const limit of [{ bytes: -1, inodes: 1 }, { bytes: 1.5, inodes: 1 }, { bytes: 1, inodes: Number.NaN }]) {
      await expect(tool.setLimit("/srv/managed", 1, limit)).rejects.toBeInstanceOf(QuotaCommandError);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("treats errors that xfs_quota only prints as failures", async () => {
    const { tool } = recorder({ code: 0, stdout: "", stderr: "xfs_quota: cannot set limits: Operation not permitted\n" });
    await expect(tool.setLimit("/srv/managed", 1, { bytes: 1024, inodes: 1 })).rejects.toMatchObject({
      permissionDenied: true,
    });
  });

  it("parses lsattr project output for exactly the requested directory", async () => {
    const { tool } = recorder({
      code: 0,
      stdout: " 1000001 --------------e-------P /srv/managed/workspaces/abc/home\n",
      stderr: "",
    });
    await expect(tool.readProject("/srv/managed/workspaces/abc/home")).resolves.toEqual({
      projectId: 1_000_001,
      inherit: true,
    });
    await expect(tool.readProject("/srv/managed/workspaces/abc/other")).rejects.toBeInstanceOf(
      QuotaCommandError,
    );
    const plain = recorder({ code: 0, stdout: "0 --------------e------- /srv/x\n", stderr: "" });
    await expect(plain.tool.readProject("/srv/x")).resolves.toEqual({ projectId: 0, inherit: false });
  });
});
