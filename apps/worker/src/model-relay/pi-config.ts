import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  MODEL_RELAY_PLACEHOLDER_API_KEY,
  modelApiBasePath,
  type ModelConfigResult,
  type ModelGatewayConfig,
} from "@agent-runtime/protocol";

/**
 * Writes the platform provider into the Workspace's Pi `models.json` (specs.md Phase 16.5).
 * `/agent/pi` is writable by the Agent, so nothing here follows a symbolic link: a file that
 * is not a regular JSON object file is left untouched and reported as `user_config_invalid`.
 * Only the platform provider entry changes; every other key is preserved.
 */
export interface PiProviderTarget {
  /** The Workspace's `pi/` directory, already verified to be a real managed directory. */
  piDirectory: string;
  /** null removes the platform provider (gateway disabled for this Workspace). */
  config: ModelGatewayConfig | null;
  /** `http://<bridge gateway>:<relay port>`; null when the relay is not enabled. */
  relayOrigin: string | null;
  /** The provider ID written last time (Workspace metadata), removed when it changes. */
  previousProviderId: string | null;
  uid: number;
  gid: number;
}

export interface PiProviderWrite {
  result: ModelConfigResult;
  /** The provider ID now present in models.json, to remember in the metadata. */
  providerId: string | null;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ReadResult = { state: "absent" } | { state: "invalid" } | { state: "ok"; value: JsonObject };

async function readJsonObject(path: string): Promise<ReadResult> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "invalid" };
  }
  try {
    if (!(await handle.stat()).isFile()) return { state: "invalid" };
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    return isObject(value) ? { state: "ok", value } : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  } finally {
    await handle.close();
  }
}

/** Atomic replace owned by the Workspace user; the rename replaces a link, never its target. */
async function writeOwnedFile(path: string, content: string, uid: number, gid: number): Promise<void> {
  const temporary = join(path, "..", `.agent-runtime-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    const stat = await handle.stat();
    if (stat.uid !== uid || stat.gid !== gid) await handle.chown(uid, gid);
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

export function renderPlatformProvider(config: ModelGatewayConfig, relayOrigin: string): JsonObject {
  const api = config.models[0]?.api ?? "openai-completions";
  return {
    baseUrl: `${relayOrigin}${modelApiBasePath(api)}`,
    api,
    apiKey: MODEL_RELAY_PLACEHOLDER_API_KEY,
    models: config.models.map((model) => ({ ...model })),
  };
}

export async function writePlatformProvider(target: PiProviderTarget): Promise<PiProviderWrite> {
  const modelsPath = join(target.piDirectory, "models.json");
  const current = await readJsonObject(modelsPath);
  const unchanged = { providerId: target.previousProviderId };
  if (current.state === "invalid") return { result: "user_config_invalid", ...unchanged };
  const enabled =
    target.config !== null && target.relayOrigin !== null
      ? { config: target.config, origin: target.relayOrigin }
      : null;
  const enabledId = enabled?.config.providerId ?? null;

  const document: JsonObject = current.state === "ok" ? { ...current.value } : {};
  if (document.providers !== undefined && !isObject(document.providers)) {
    return { result: "user_config_invalid", ...unchanged };
  }
  const providers = new Map(Object.entries((document.providers as JsonObject | undefined) ?? {}));
  const stale = target.previousProviderId !== null && target.previousProviderId !== enabledId
    ? target.previousProviderId
    : null;
  if (enabled === null && (stale === null || !providers.has(stale))) {
    return { result: "removed", providerId: null };
  }
  if (stale !== null) providers.delete(stale);
  if (enabled !== null) {
    providers.set(enabled.config.providerId, renderPlatformProvider(enabled.config, enabled.origin));
  }
  document.providers = Object.fromEntries(providers);
  try {
    await writeOwnedFile(modelsPath, JSON.stringify(document, null, 2), target.uid, target.gid);
  } catch {
    return { result: "write_failed", ...unchanged };
  }
  if (enabled === null) return { result: "removed", providerId: null };

  // A new Workspace starts on the platform default model; existing settings stay (Q6).
  const settingsPath = join(target.piDirectory, "settings.json");
  const exists = await lstat(settingsPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
  );
  if (!exists) {
    const settings = { defaultProvider: enabled.config.providerId, defaultModel: enabled.config.defaultModel };
    try {
      await writeOwnedFile(settingsPath, JSON.stringify(settings, null, 2), target.uid, target.gid);
    } catch {
      return { result: "write_failed", providerId: enabled.config.providerId };
    }
  }
  return { result: "applied", providerId: enabled.config.providerId };
}
