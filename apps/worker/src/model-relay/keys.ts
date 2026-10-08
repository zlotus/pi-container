import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  ModelKeyAliasSchema,
  ModelKeySecretSchema,
  modelKeyAliasWorkspaceId,
  WorkspaceIdSchema,
  type WorkerModelKeyHolding,
} from "@agent-runtime/protocol";
import { z } from "zod";

/** `metadata/model-key.json`: Worker-private, never mounted into a container (Phase 16.6). */
export const MODEL_KEY_FILE = "model-key.json";

const KeyFileSchema = z
  .object({ version: z.literal(1), keyAlias: ModelKeyAliasSchema, secret: ModelKeySecretSchema })
  .strict();

interface HeldKey {
  keyAlias: string;
  secret: string;
}

/**
 * The virtual keys of this Worker's Workspaces. The secret only ever lives here and in the
 * Workspace's private metadata file; the relay injects it into upstream requests.
 */
export class ModelKeyStore {
  readonly #keys = new Map<string, HeldKey>();

  get(workspaceId: string): string | undefined {
    return this.#keys.get(workspaceId)?.secret;
  }

  holdings(): WorkerModelKeyHolding[] {
    return [...this.#keys.entries()]
      .map(([workspaceId, key]) => ({ workspaceId, keyAlias: key.keyAlias }))
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  }

  /**
   * Loads every `<workspaces>/<id>/metadata/model-key.json`. A file that does not parse or
   * does not belong to its directory is ignored (and reported to the Control Plane as a
   * missing key, which makes it rotate).
   */
  async load(workspacesRoot: string): Promise<{ loaded: number; ignored: number }> {
    let entries: string[];
    try {
      entries = await readdir(workspacesRoot);
    } catch {
      return { loaded: 0, ignored: 0 };
    }
    let loaded = 0;
    let ignored = 0;
    for (const entry of entries) {
      if (!WorkspaceIdSchema.safeParse(entry).success) continue;
      const key = await readKeyFile(join(workspacesRoot, entry, "metadata"));
      if (key === "absent") continue;
      if (key === "invalid" || modelKeyAliasWorkspaceId(key.keyAlias) !== entry) {
        ignored += 1;
        continue;
      }
      this.#keys.set(entry, key);
      loaded += 1;
    }
    return { loaded, ignored };
  }

  /** Persists first, then serves: a key the Worker reports holding survives a restart. */
  async set(workspaceId: string, metadataDirectory: string, keyAlias: string, secret: string): Promise<void> {
    const content = JSON.stringify({ version: 1, keyAlias, secret });
    await writePrivateFile(join(metadataDirectory, MODEL_KEY_FILE), content);
    this.#keys.set(workspaceId, { keyAlias, secret });
  }

  /**
   * Stops serving the named key immediately, then removes its file (absent directories are
   * fine). A different (newer) key of the Workspace is kept. Returns the alias still held.
   */
  async clear(workspaceId: string, metadataDirectory: string | null, keyAlias: string): Promise<string | null> {
    const held = this.#keys.get(workspaceId);
    if (held !== undefined && held.keyAlias !== keyAlias) return held.keyAlias;
    this.#keys.delete(workspaceId);
    if (metadataDirectory !== null) {
      const onDisk = await readKeyFile(metadataDirectory);
      if (onDisk === "absent") return null;
      if (onDisk === "invalid" || onDisk.keyAlias === keyAlias) {
        await rm(join(metadataDirectory, MODEL_KEY_FILE), { force: true });
      }
    }
    return null;
  }

  /** Forgets a key whose Workspace directory is already gone (delete). */
  forget(workspaceId: string): void {
    this.#keys.delete(workspaceId);
  }
}

async function readKeyFile(directory: string): Promise<HeldKey | "absent" | "invalid"> {
  let handle;
  try {
    handle = await open(join(directory, MODEL_KEY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid";
  }
  try {
    if (!(await handle.stat()).isFile()) return "invalid";
    const parsed = KeyFileSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
    return parsed.success ? { keyAlias: parsed.data.keyAlias, secret: parsed.data.secret } : "invalid";
  } catch {
    return "invalid";
  } finally {
    await handle.close();
  }
}

/** Writes `path` atomically with mode 0600 without following a symbolic link anywhere. */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
