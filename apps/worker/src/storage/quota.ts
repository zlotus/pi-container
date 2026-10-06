import { spawn } from "node:child_process";

/**
 * The only quota operations the Worker performs (specs.md Phase 15.3). Every call runs a
 * fixed program with a fixed argument vector built from validated integers and paths
 * the Worker derived itself: never a shell, never Control Plane or user input.
 */
export interface QuotaTool {
  /** Tags a directory tree with a project ID and marks directories to pass it on. */
  setProject(mountPoint: string, directory: string, projectId: number): Promise<void>;
  /** Sets the hard byte and inode limit of a project; zero removes the limit. */
  setLimit(mountPoint: string, projectId: number, limit: QuotaLimit): Promise<void>;
  /** Reads the project ID and inherit flag of one directory, without following links. */
  readProject(directory: string): Promise<{ projectId: number; inherit: boolean }>;
}

export interface QuotaLimit {
  bytes: number;
  inodes: number;
}

export class QuotaCommandError extends Error {
  constructor(
    message: string,
    readonly permissionDenied: boolean,
  ) {
    super(message);
  }
}

/**
 * Paths that reach `xfs_quota -c` are parsed by its own tokenizer, so only plain absolute
 * paths are allowed; the managed root and UUID directory names always satisfy this.
 */
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const MAX_PROJECT_ID = 2 ** 32 - 2;

export function assertSafeQuotaPath(path: string): void {
  if (!SAFE_PATH.test(path) || path.split("/").includes("..")) {
    throw new QuotaCommandError(`Refusing an unsafe quota path`, false);
  }
}

function assertProjectId(projectId: number): void {
  if (!Number.isSafeInteger(projectId) || projectId < 1 || projectId > MAX_PROJECT_ID) {
    throw new QuotaCommandError("Refusing an invalid project ID", false);
  }
}

function assertLimit(limit: QuotaLimit): void {
  if (
    !Number.isSafeInteger(limit.bytes) ||
    limit.bytes < 0 ||
    !Number.isSafeInteger(limit.inodes) ||
    limit.inodes < 0
  ) {
    throw new QuotaCommandError("Refusing an invalid quota limit", false);
  }
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const OUTPUT_LIMIT = 1024 * 1024;

export type CommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

/** Spawns without a shell and with a bounded output and runtime. */
export const spawnCommand: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

/** `xfs_quota` for changes and `lsattr` for reading project attributes. */
export class ExecXfsQuotaTool implements QuotaTool {
  constructor(
    readonly xfsQuotaPath = "/usr/sbin/xfs_quota",
    readonly lsattrPath = "/usr/bin/lsattr",
    readonly run: CommandRunner = spawnCommand,
    readonly timeoutMs = 600_000,
  ) {}

  async setProject(mountPoint: string, directory: string, projectId: number): Promise<void> {
    assertSafeQuotaPath(mountPoint);
    assertSafeQuotaPath(directory);
    assertProjectId(projectId);
    // `project -s` walks the tree without following symbolic links.
    await this.#xfsQuota(mountPoint, `project -s -p ${directory} ${projectId}`, "tag a project");
  }

  async setLimit(mountPoint: string, projectId: number, limit: QuotaLimit): Promise<void> {
    assertSafeQuotaPath(mountPoint);
    assertProjectId(projectId);
    assertLimit(limit);
    const kib = Math.floor(limit.bytes / 1024);
    await this.#xfsQuota(
      mountPoint,
      `limit -p bsoft=0 bhard=${kib}k isoft=0 ihard=${limit.inodes} ${projectId}`,
      "set a project limit",
    );
  }

  async readProject(directory: string): Promise<{ projectId: number; inherit: boolean }> {
    assertSafeQuotaPath(directory);
    const result = await this.run(this.lsattrPath, ["-pd", directory], 10_000);
    if (result.code !== 0) throw this.#error("read project attributes", result);
    const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(result.stdout.trim());
    if (match === null || match[3] !== directory) {
      throw new QuotaCommandError("Unexpected lsattr output", false);
    }
    return { projectId: Number(match[1]), inherit: (match[2] ?? "").includes("P") };
  }

  async #xfsQuota(mountPoint: string, command: string, action: string): Promise<void> {
    const result = await this.run(this.xfsQuotaPath, ["-x", "-c", command, mountPoint], this.timeoutMs);
    // xfs_quota reports some failures only on stderr while exiting 0.
    if (result.code !== 0 || /permission denied|operation not permitted|cannot|error/i.test(result.stderr)) {
      throw this.#error(action, result);
    }
  }

  #error(action: string, result: CommandResult): QuotaCommandError {
    const permissionDenied = /operation not permitted|permission denied/i.test(result.stderr);
    return new QuotaCommandError(
      `Could not ${action} (exit ${String(result.code)})`,
      permissionDenied,
    );
  }
}
