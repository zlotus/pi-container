import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseMountInfo,
  StorageController,
  type StorageFilesystem,
  type StorageQuotaError,
} from "./controller.js";
import type { QuotaLimit, QuotaTool } from "./quota.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const POLICY = {
  projectIdMin: 1_000_000,
  dataInodeLimit: 2_000_000,
  piLimitBytes: 2 * 1024 ** 3,
  piInodeLimit: 200_000,
};

/** Simulates XFS: statfs on a tagged directory reports its project's limit. */
class FakeXfs implements QuotaTool, StorageFilesystem {
  mountOptions = "rw,relatime,attr2,inode64,logbufs=8,logbsize=32k,prjquota";
  fsType = "xfs";
  mounted = true;
  denyLimits = false;
  readonly projects = new Map<string, { projectId: number; inherit: boolean }>();
  readonly limits = new Map<number, QuotaLimit>();
  readonly calls: string[] = [];

  constructor(readonly root: string) {}

  async readMountInfo(): Promise<string> {
    const lines = ["22 1 259:3 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p3 rw"];
    if (this.mounted) {
      lines.push(`99 22 7:0 / ${this.root} rw,relatime shared:9 - ${this.fsType} /dev/loop0 ${this.mountOptions}`);
    }
    return `${lines.join("\n")}\n`;
  }

  async statfs(path: string) {
    const project = this.projects.get(path);
    const limit = project === undefined ? undefined : this.limits.get(project.projectId);
    if (limit === undefined) {
      return { bsize: 4096, blocks: 1_000_000, bfree: 500_000, bavail: 400_000, files: 9_999, ffree: 9_000 };
    }
    return {
      bsize: 4096,
      blocks: Math.floor(limit.bytes / 4096),
      bfree: Math.floor(limit.bytes / 4096) - 10,
      bavail: Math.floor(limit.bytes / 4096) - 10,
      files: limit.inodes,
      ffree: limit.inodes - 3,
    };
  }

  async setProject(_mount: string, directory: string, projectId: number): Promise<void> {
    this.calls.push(`project ${directory} ${projectId}`);
    this.projects.set(directory, { projectId, inherit: true });
  }

  async setLimit(_mount: string, projectId: number, limit: QuotaLimit): Promise<void> {
    this.calls.push(`limit ${projectId} ${limit.bytes} ${limit.inodes}`);
    if (this.denyLimits) throw new Error("Operation not permitted");
    this.limits.set(projectId, limit);
  }

  async readProject(directory: string) {
    return this.projects.get(directory) ?? { projectId: 0, inherit: false };
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-storage-"));
  roots.push(root);
  const xfs = new FakeXfs(root);
  const log = { info: vi.fn(), warn: vi.fn() };
  const controller = new StorageController({
    managedRoot: root,
    quota: xfs,
    filesystem: xfs,
    policy: POLICY,
    log,
  });
  const directories = {
    workspace: join(root, "ws", "workspace"),
    home: join(root, "ws", "home"),
    tmp: join(root, "ws", "tmp"),
    pi: join(root, "ws", "pi"),
  };
  return { root, xfs, log, controller, directories };
}

describe("parseMountInfo", () => {
  it("reads mount point, type and super options, decoding escapes", () => {
    expect(
      parseMountInfo(
        "36 35 98:0 /mnt1 /mnt/with\\040space rw,noatime master:1 - xfs /dev/root rw,prjquota\n",
      ),
    ).toEqual([{ mountPoint: "/mnt/with space", fsType: "xfs", superOptions: ["rw", "prjquota"] }]);
  });
});

describe("StorageController", () => {
  it("enforces only on an XFS mount of the managed root with enforced project quotas", async () => {
    const cases: Array<[string, (xfs: FakeXfs) => void]> = [
      ["not a mount point", (xfs) => { xfs.mounted = false; }],
      ["ext4", (xfs) => { xfs.fsType = "ext4"; }],
      ["no project quota", (xfs) => { xfs.mountOptions = "rw,relatime,noquota"; }],
      ["accounting only", (xfs) => { xfs.mountOptions = "rw,relatime,prjquota,pqnoenforce"; }],
      ["limits cannot be set", (xfs) => { xfs.denyLimits = true; }],
    ];
    for (const [, mutate] of cases) {
      const { xfs, controller, log } = await setup();
      mutate(xfs);
      await expect(controller.check()).resolves.toMatchObject({ enforced: false });
      expect(controller.isEnforced()).toBe(false);
      expect(log.warn).toHaveBeenCalledOnce();
    }
    const { controller, xfs, root } = await setup();
    await expect(controller.check()).resolves.toEqual({
      enforced: true,
      fsType: "xfs",
      totalBytes: 4096 * 1_000_000,
      freeBytes: 4096 * 400_000,
    });
    // The capability probe uses the reserved first ID of the range.
    expect(xfs.calls).toEqual([
      `project ${join(root, "quota-probe")} 1000000`,
      `limit 1000000 ${64 * 1024 ** 2} 64`,
    ]);
    await controller.check();
    expect(xfs.calls).toHaveLength(2);
  });

  it("stops enforcing when the mount disappears and probes again when it returns", async () => {
    const { xfs, controller } = await setup();
    await controller.check();
    xfs.mounted = false;
    await expect(controller.check()).resolves.toMatchObject({ enforced: false });
    xfs.mounted = true;
    await expect(controller.check()).resolves.toMatchObject({ enforced: true });
    expect(xfs.calls.filter((call) => call.startsWith("limit 1000000"))).toHaveLength(2);
  });

  it("refuses Workspace changes until quotas are enforced", async () => {
    const { controller, directories } = await setup();
    await expect(
      controller.prepareWorkspace(directories, { dataProjectId: 1, piProjectId: 2 }, 1024 ** 3),
    ).rejects.toMatchObject<Partial<StorageQuotaError>>({ code: "STORAGE_QUOTA_UNENFORCED" });
  });

  it("tags all four directories, sets both limits and reads them back", async () => {
    const { xfs, controller, directories } = await setup();
    await controller.check();
    xfs.calls.length = 0;
    const quota = { dataProjectId: 1_000_001, piProjectId: 1_000_002 };
    await controller.prepareWorkspace(directories, quota, 20 * 1024 ** 3);
    expect(xfs.calls).toEqual([
      `project ${directories.workspace} 1000001`,
      `project ${directories.home} 1000001`,
      `project ${directories.tmp} 1000001`,
      `project ${directories.pi} 1000002`,
      `limit 1000001 ${20 * 1024 ** 3} 2000000`,
      `limit 1000002 ${2 * 1024 ** 3} 200000`,
    ]);

    // Already-tagged directories are not walked again; a lost tag is repaired.
    xfs.calls.length = 0;
    xfs.projects.set(directories.home, { projectId: 1_000_001, inherit: false });
    await controller.prepareWorkspace(directories, quota, 20 * 1024 ** 3);
    expect(xfs.calls.filter((call) => call.startsWith("project"))).toEqual([
      `project ${directories.home} 1000001`,
    ]);

    await expect(controller.usage(directories.workspace)).resolves.toEqual({
      usedBytes: 10 * 4096,
      limitBytes: 20 * 1024 ** 3,
      usedInodes: 3,
      limitInodes: 2_000_000,
    });
  });

  it("fails when a limit does not show up in statfs", async () => {
    const { xfs, controller, directories } = await setup();
    await controller.check();
    const quota = { dataProjectId: 1_000_001, piProjectId: 1_000_002 };
    const original = xfs.setLimit.bind(xfs);
    xfs.setLimit = async (mount, projectId, limit) => {
      await original(mount, projectId, projectId === 1_000_001 ? { ...limit, bytes: limit.bytes / 2 } : limit);
    };
    await expect(
      controller.prepareWorkspace(directories, quota, 20 * 1024 ** 3),
    ).rejects.toMatchObject<Partial<StorageQuotaError>>({
      code: "STORAGE_QUOTA_APPLY_FAILED",
      retryable: true,
    });
  });

  it("changes the data limit in place and clears limits on release", async () => {
    const { xfs, controller, directories } = await setup();
    await controller.check();
    const quota = { dataProjectId: 1_000_001, piProjectId: 1_000_002 };
    await controller.prepareWorkspace(directories, quota, 20 * 1024 ** 3);
    await expect(controller.setDataLimit(directories, quota, 5 * 1024 ** 3)).resolves.toMatchObject({
      limitBytes: 5 * 1024 ** 3,
    });
    await controller.releaseWorkspace(quota);
    expect(xfs.limits.get(1_000_001)).toEqual({ bytes: 0, inodes: 0 });
    expect(xfs.limits.get(1_000_002)).toEqual({ bytes: 0, inodes: 0 });
  });
});
