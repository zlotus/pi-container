import { link, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StorageController } from "./controller.js";
import { ExecXfsQuotaTool } from "./quota.js";

// Real-kernel quota test (specs.md Phase 15.10). Needs an XFS filesystem mounted with
// `prjquota` at TEST_XFS_ROOT and a process allowed to set quotas (root in CI). Run with
// `pnpm test:quota`; see docs/storage-runbook.md for a local loop-device setup.
const xfsRoot = process.env.TEST_XFS_ROOT;
const describeWithXfs = xfsRoot === undefined ? describe.skip : describe;

const MIB = 1024 ** 2;
// XFS reports an exhausted project quota as ENOSPC ("No space left on device"),
// unlike user/group quotas (EDQUOT); accept either so the test states the limit.
const QUOTA_EXHAUSTED = ["ENOSPC", "EDQUOT"];

async function writeBytes(path: string, bytes: number): Promise<void> {
  await writeFile(path, Buffer.alloc(bytes, 1));
}

async function errorCode(task: Promise<unknown>): Promise<string | undefined> {
  try {
    await task;
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
}

describeWithXfs("XFS project quotas on a real kernel", () => {
  const root = xfsRoot ?? "/nonexistent";
  const base = join(root, "quota-test");
  const directories = {
    workspace: join(base, "workspace"),
    home: join(base, "home"),
    tmp: join(base, "tmp"),
    pi: join(base, "pi"),
  };
  const outside = join(root, "quota-test-outside");
  const quota = { dataProjectId: 4_000_001, piProjectId: 4_000_002 };
  const tool = new ExecXfsQuotaTool();
  const controller = new StorageController({
    managedRoot: root,
    quota: tool,
    policy: {
      projectIdMin: 4_000_000,
      dataInodeLimit: 100,
      piLimitBytes: 8 * MIB,
      piInodeLimit: 100,
    },
  });

  beforeAll(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
    await mkdir(outside);
    // A link the Workspace controls must not drag the target into its project.
    await symlink(outside, join(directories.workspace, "escape"));
  });

  afterAll(async () => {
    if (controller.isEnforced()) await controller.releaseWorkspace(quota);
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("detects enforced quotas only at the mount point itself", async () => {
    await expect(controller.check()).resolves.toMatchObject({ enforced: true, fsType: "xfs" });
    await mkdir(join(root, "not-a-mount"), { recursive: true });
    const nested = new StorageController({
      managedRoot: join(root, "not-a-mount"),
      quota: tool,
      policy: controller.policy,
    });
    await expect(nested.check()).resolves.toMatchObject({ enforced: false });
  });

  it("limits the data directories together and the Pi state separately", async () => {
    await controller.prepareWorkspace(directories, quota, 16 * MIB);
    await expect(controller.usage(directories.workspace)).resolves.toMatchObject({
      limitBytes: 16 * MIB,
      limitInodes: 100,
    });
    expect((await tool.readProject(outside)).projectId).toBe(0);
    expect((await lstat(join(directories.workspace, "escape"))).isSymbolicLink()).toBe(true);

    await writeBytes(join(directories.home, "a"), 6 * MIB);
    await writeBytes(join(directories.tmp, "b"), 6 * MIB);
    expect(QUOTA_EXHAUSTED).toContain(await errorCode(writeBytes(join(directories.workspace, "c"), 6 * MIB)));
    // A full data project leaves the Pi state writable.
    await writeBytes(join(directories.pi, "session.jsonl"), 1 * MIB);
    expect(await readFile(join(directories.pi, "session.jsonl"))).toHaveLength(MIB);
    expect(QUOTA_EXHAUSTED).toContain(await errorCode(writeBytes(join(directories.pi, "big"), 9 * MIB)));
    // Free the projects for the next tests.
    for (const path of [
      join(directories.home, "a"),
      join(directories.tmp, "b"),
      join(directories.workspace, "c"),
      join(directories.pi, "big"),
    ]) {
      await rm(path, { force: true });
    }
  });

  it("passes the project to new directories and refuses moves across projects", async () => {
    const nested = join(directories.workspace, "nested", "deeper");
    await mkdir(nested, { recursive: true });
    expect(await tool.readProject(nested)).toEqual({ projectId: quota.dataProjectId, inherit: true });
    await writeFile(join(directories.workspace, "small"), "x");
    expect(await errorCode(rename(join(directories.workspace, "small"), join(directories.pi, "small")))).toBe(
      "EXDEV",
    );
    expect(await errorCode(link(join(directories.workspace, "small"), join(directories.pi, "hard")))).toBe(
      "EXDEV",
    );
  });

  it("limits inodes", async () => {
    const many = join(directories.workspace, "many");
    await mkdir(many);
    let failure: string | undefined;
    for (let index = 0; index < 150 && failure === undefined; index += 1) {
      failure = await errorCode(writeFile(join(many, String(index)), ""));
    }
    expect(QUOTA_EXHAUSTED).toContain(failure);
    await rm(many, { recursive: true, force: true });
  });

  it("raises a limit in place and releases it", async () => {
    await controller.setDataLimit(directories, quota, 64 * MIB);
    await writeBytes(join(directories.workspace, "c"), 6 * MIB);
    await controller.releaseWorkspace(quota);
    const released = await controller.usage(directories.workspace);
    expect(released.limitBytes).not.toBe(64 * MIB);
  });
});
