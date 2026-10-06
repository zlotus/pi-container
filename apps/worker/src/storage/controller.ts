import { mkdir, readFile, realpath, statfs } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "@agent-runtime/logging";
import type { WorkerStorageStatus } from "@agent-runtime/protocol";

import { type QuotaLimit, type QuotaTool, assertSafeQuotaPath } from "./quota.js";

/** The project IDs and data limit of one Workspace, as kept in its managed metadata. */
export interface WorkspaceQuota {
  dataProjectId: number;
  piProjectId: number;
}

/** Host directories of one Workspace: three share the data project, `pi` has its own. */
export interface WorkspaceQuotaDirectories {
  workspace: string;
  home: string;
  tmp: string;
  pi: string;
}

export interface ProjectUsage {
  usedBytes: number;
  limitBytes: number;
  usedInodes: number;
  limitInodes: number;
}

export class StorageQuotaError extends Error {
  constructor(
    readonly code:
      | "STORAGE_QUOTA_UNENFORCED"
      | "STORAGE_QUOTA_APPLY_FAILED",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface StorageFilesystem {
  /** `/proc/self/mountinfo` contents. */
  readMountInfo(): Promise<string>;
  statfs(path: string): Promise<{
    bsize: number;
    blocks: number;
    bfree: number;
    bavail: number;
    files: number;
    ffree: number;
  }>;
}

const nodeFilesystem: StorageFilesystem = {
  readMountInfo: () => readFile("/proc/self/mountinfo", "utf8"),
  statfs: (path) => statfs(path),
};

export interface StoragePolicy {
  /** First ID of the platform's project range; the ID itself is the capability probe's. */
  projectIdMin: number;
  dataInodeLimit: number;
  piLimitBytes: number;
  piInodeLimit: number;
}

/** A mount point as listed in mountinfo; octal escapes such as `\040` are decoded. */
export interface MountEntry {
  mountPoint: string;
  fsType: string;
  superOptions: string[];
}

function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseMountInfo(contents: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of contents.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    const mountPoint = before[4];
    const fsType = after[0];
    if (mountPoint === undefined || fsType === undefined) continue;
    entries.push({
      mountPoint: unescapeMountField(mountPoint),
      fsType,
      superOptions: (after[2] ?? "").split(","),
    });
  }
  return entries;
}

const PROBE_LIMIT: QuotaLimit = { bytes: 64 * 1024 * 1024, inodes: 64 };

/**
 * Knows whether the managed root enforces XFS project quotas and applies per-Workspace
 * projects and limits (specs.md Phase 15.3, 15.6). Reads (`statfs`, mountinfo, lsattr)
 * need no privilege; setting limits needs CAP_SYS_ADMIN.
 */
export class StorageController {
  readonly #managedRoot: string;
  readonly #quota: QuotaTool;
  readonly #filesystem: StorageFilesystem;
  readonly #policy: StoragePolicy;
  readonly #log: Pick<Logger, "info" | "warn"> | undefined;
  #status: WorkerStorageStatus = {
    enforced: false,
    fsType: null,
    totalBytes: null,
    freeBytes: null,
  };
  #mountPoint: string | null = null;
  #probed = false;
  #checked = false;

  constructor(input: {
    managedRoot: string;
    quota: QuotaTool;
    policy: StoragePolicy;
    filesystem?: StorageFilesystem;
    log?: Pick<Logger, "info" | "warn">;
  }) {
    assertSafeQuotaPath(input.managedRoot);
    this.#managedRoot = input.managedRoot;
    this.#quota = input.quota;
    this.#policy = input.policy;
    this.#filesystem = input.filesystem ?? nodeFilesystem;
    this.#log = input.log;
  }

  get policy(): StoragePolicy {
    return this.#policy;
  }

  status(): WorkerStorageStatus {
    return { ...this.#status };
  }

  isEnforced(): boolean {
    return this.#status.enforced;
  }

  /**
   * Re-reads whether quotas are enforced. The managed root must itself be an XFS mount
   * with enforced project quotas, and this process must be able to set a limit (checked
   * once with the reserved probe project, again after any failure).
   */
  async check(): Promise<WorkerStorageStatus> {
    const previous = this.#status.enforced;
    let next: WorkerStorageStatus;
    let reason: string | null = null;
    try {
      const root = await realpath(this.#managedRoot);
      const mounts = parseMountInfo(await this.#filesystem.readMountInfo());
      const mount = mounts.filter((entry) => entry.mountPoint === root).at(-1);
      const stats = await this.#filesystem.statfs(root);
      next = {
        enforced: false,
        fsType: mount?.fsType.slice(0, 32).replace(/[^a-z0-9_.-]/g, "") || null,
        totalBytes: stats.blocks * stats.bsize,
        freeBytes: stats.bavail * stats.bsize,
      };
      if (mount === undefined) {
        reason = "the managed root is not a mount point";
      } else if (mount.fsType !== "xfs") {
        reason = "the managed root is not an XFS filesystem";
      } else if (
        !mount.superOptions.includes("prjquota") ||
        mount.superOptions.includes("pqnoenforce")
      ) {
        reason = "project quotas are not enforced on the managed root";
      } else {
        this.#mountPoint = root;
        if (!this.#probed) await this.#probe(root);
        this.#probed = true;
        next.enforced = true;
      }
    } catch (error) {
      this.#probed = false;
      reason = error instanceof Error ? error.message : "quota check failed";
      next = { ...this.#status, enforced: false };
    }
    if (!next.enforced) this.#probed = false;
    this.#status = next;
    if (!this.#checked || previous !== next.enforced) {
      this.#checked = true;
      if (next.enforced) {
        this.#log?.info({ fsType: next.fsType }, "disk quotas are enforced");
      } else {
        this.#log?.warn({ reason }, "disk quotas are not enforced; Workspaces will not start");
      }
    }
    return this.status();
  }

  async #probe(root: string): Promise<void> {
    const directory = join(root, "quota-probe");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const projectId = this.#policy.projectIdMin;
    await this.#quota.setProject(root, directory, projectId);
    await this.#quota.setLimit(root, projectId, PROBE_LIMIT);
    const usage = await this.usage(directory);
    if (usage.limitBytes !== PROBE_LIMIT.bytes || usage.limitInodes !== PROBE_LIMIT.inodes) {
      throw new Error("a project limit did not take effect");
    }
  }

  #requireMount(): string {
    if (!this.#status.enforced || this.#mountPoint === null) {
      throw new StorageQuotaError(
        "STORAGE_QUOTA_UNENFORCED",
        "Disk quotas are not enforced on this Worker",
      );
    }
    return this.#mountPoint;
  }

  /**
   * Makes sure every Workspace directory carries its project and both projects carry the
   * requested limits, then reads them back through `statfs`. Re-tags directories whose
   * project or inherit flag was lost (for example after a restore).
   */
  async prepareWorkspace(
    directories: WorkspaceQuotaDirectories,
    quota: WorkspaceQuota,
    dataLimitBytes: number,
  ): Promise<void> {
    const mount = this.#requireMount();
    try {
      const assignments: Array<[string, number]> = [
        [directories.workspace, quota.dataProjectId],
        [directories.home, quota.dataProjectId],
        [directories.tmp, quota.dataProjectId],
        [directories.pi, quota.piProjectId],
      ];
      for (const [directory, projectId] of assignments) {
        const current = await this.#quota.readProject(directory);
        if (current.projectId !== projectId || !current.inherit) {
          await this.#quota.setProject(mount, directory, projectId);
        }
      }
      await this.#applyLimits(mount, directories, quota, dataLimitBytes);
    } catch (error) {
      if (error instanceof StorageQuotaError) throw error;
      throw new StorageQuotaError(
        "STORAGE_QUOTA_APPLY_FAILED",
        "Workspace disk quota could not be applied",
        true,
      );
    }
  }

  /** Changes the data limit in place; takes effect for the running container at once. */
  async setDataLimit(
    directories: WorkspaceQuotaDirectories,
    quota: WorkspaceQuota,
    dataLimitBytes: number,
  ): Promise<ProjectUsage> {
    const mount = this.#requireMount();
    try {
      await this.#applyLimits(mount, directories, quota, dataLimitBytes);
      return await this.usage(directories.workspace);
    } catch (error) {
      if (error instanceof StorageQuotaError) throw error;
      throw new StorageQuotaError(
        "STORAGE_QUOTA_APPLY_FAILED",
        "Workspace disk quota could not be applied",
        true,
      );
    }
  }

  async #applyLimits(
    mount: string,
    directories: WorkspaceQuotaDirectories,
    quota: WorkspaceQuota,
    dataLimitBytes: number,
  ): Promise<void> {
    await this.#quota.setLimit(mount, quota.dataProjectId, {
      bytes: dataLimitBytes,
      inodes: this.#policy.dataInodeLimit,
    });
    await this.#quota.setLimit(mount, quota.piProjectId, {
      bytes: this.#policy.piLimitBytes,
      inodes: this.#policy.piInodeLimit,
    });
    const [data, pi] = await Promise.all([
      this.usage(directories.workspace),
      this.usage(directories.pi),
    ]);
    // XFS keeps limits in filesystem blocks, so allow one block of rounding.
    const close = (actual: number, expected: number) => Math.abs(actual - expected) < 64 * 1024;
    if (
      !close(data.limitBytes, dataLimitBytes) ||
      data.limitInodes !== this.#policy.dataInodeLimit ||
      !close(pi.limitBytes, this.#policy.piLimitBytes) ||
      pi.limitInodes !== this.#policy.piInodeLimit
    ) {
      throw new StorageQuotaError(
        "STORAGE_QUOTA_APPLY_FAILED",
        "Workspace disk quota did not take effect",
        true,
      );
    }
  }

  /** Removes the limits of a deleted Workspace's projects so the IDs can be reused. */
  async releaseWorkspace(quota: WorkspaceQuota): Promise<void> {
    const mount = this.#requireMount();
    for (const projectId of [quota.dataProjectId, quota.piProjectId]) {
      await this.#quota.setLimit(mount, projectId, { bytes: 0, inodes: 0 });
    }
  }

  /** What `statfs` reports for a directory tagged with a project and the inherit flag. */
  async usage(directory: string): Promise<ProjectUsage> {
    const stats = await this.#filesystem.statfs(directory);
    return {
      usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
      limitBytes: stats.blocks * stats.bsize,
      usedInodes: stats.files - stats.ffree,
      limitInodes: stats.files,
    };
  }
}
