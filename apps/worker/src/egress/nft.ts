import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EGRESS_TABLE_FAMILY, EGRESS_TABLE_NAME } from "./ruleset.js";

/** The only netfilter operations the Worker performs, both on its own table. */
export interface NftClient {
  /** Submits one libnftables JSON transaction; it is applied atomically or not at all. */
  apply(transaction: unknown): Promise<void>;
  /** Lists the egress table as JSON, or null when the table does not exist. */
  listTable(): Promise<unknown>;
}

export class NftCommandError extends Error {
  constructor(
    message: string,
    readonly permissionDenied: boolean,
  ) {
    super(message);
  }
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const OUTPUT_LIMIT = 16 * 1024 * 1024;

/** Runs `nft` with a fixed argument vector: never a shell, never user-provided arguments. */
export class ExecNftClient implements NftClient {
  constructor(
    readonly nftPath: string,
    readonly timeoutMs = 10_000,
  ) {}

  async apply(transaction: unknown): Promise<void> {
    // nft before 1.1 rejects `-f -` from a pipe ("Not a regular file"), so the
    // transaction goes through a private temporary file instead.
    const directory = await mkdtemp(join(tmpdir(), "agent-runtime-nft-"));
    try {
      const path = join(directory, "transaction.json");
      await writeFile(path, JSON.stringify(transaction), { encoding: "utf8", mode: 0o600 });
      const result = await this.#run(["-j", "-f", path]);
      if (result.code !== 0) throw this.#error("apply the egress rules", result);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async listTable(): Promise<unknown> {
    const result = await this.#run(["-j", "list", "table", EGRESS_TABLE_FAMILY, EGRESS_TABLE_NAME]);
    if (result.code !== 0) {
      if (/No such file or directory/.test(result.stderr)) return null;
      throw this.#error("list the egress rules", result);
    }
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new NftCommandError("nft returned an unreadable listing", false);
    }
  }

  #error(operation: string, result: CommandResult): NftCommandError {
    const permissionDenied = /Operation not permitted|Permission denied|must be root/.test(
      result.stderr,
    );
    // stderr only ever contains rule text the Worker itself generated; keep it short.
    const detail = result.stderr.trim().split("\n")[0]?.slice(0, 200) ?? "";
    return new NftCommandError(
      `nft could not ${operation}${detail === "" ? "" : `: ${detail}`}`,
      permissionDenied,
    );
  }

  #run(args: readonly string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.nftPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.timeoutMs,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });
      child.on("error", (error) =>
        reject(new NftCommandError(`nft could not be executed: ${error.message}`, false)),
      );
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }
}
