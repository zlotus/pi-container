import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelGatewayConfig } from "@agent-runtime/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MODEL_KEY_FILE, ModelKeyStore } from "./keys.js";
import { renderPlatformProvider, writePlatformProvider } from "./pi-config.js";

const WORKSPACE = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const CONFIG: ModelGatewayConfig = {
  providerId: "platform",
  defaultModel: "deepseek-v4-flash",
  models: [
    {
      id: "deepseek-v4-flash",
      api: "openai-completions",
      reasoning: true,
      compat: { thinkingFormat: "deepseek" },
    },
    { id: "mimo-v2.5-pro", api: "openai-completions" },
  ],
};
const ORIGIN = "http://172.22.0.1:3101";

let root = "";
let pi = "";
const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-runtime-pi-config-"));
  pi = join(root, "pi");
  await mkdir(pi);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = (overrides: Partial<Parameters<typeof writePlatformProvider>[0]> = {}) =>
  writePlatformProvider({
    piDirectory: pi,
    config: CONFIG,
    relayOrigin: ORIGIN,
    previousProviderId: null,
    uid,
    gid,
    ...overrides,
  });

const readModels = async () => JSON.parse(await readFile(join(pi, "models.json"), "utf8"));

describe("platform provider in models.json (Phase 16.5)", () => {
  it("renders the relay base URL and a placeholder key, never a real credential", () => {
    const provider = renderPlatformProvider(CONFIG, ORIGIN);
    expect(provider).toMatchObject({
      baseUrl: "http://172.22.0.1:3101/v1",
      api: "openai-completions",
      apiKey: "agent-runtime-relay",
    });
    const anthropic = renderPlatformProvider(
      { providerId: "platform", defaultModel: "c", models: [{ id: "c", api: "anthropic-messages" }] },
      ORIGIN,
    );
    expect(anthropic.baseUrl).toBe(ORIGIN);
  });

  it("creates models.json and default settings for a new Workspace", async () => {
    await expect(write()).resolves.toEqual({ result: "applied", providerId: "platform" });
    const models = await readModels();
    expect(models.providers.platform.models.map((model: { id: string }) => model.id)).toEqual([
      "deepseek-v4-flash",
      "mimo-v2.5-pro",
    ]);
    expect((await stat(join(pi, "models.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(pi, "settings.json"), "utf8"))).toEqual({
      defaultProvider: "platform",
      defaultModel: "deepseek-v4-flash",
    });
    expect((await readdir(pi)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces only the platform entry and keeps the user's own providers and settings", async () => {
    const user = {
      providers: {
        ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "x" }] },
        platform: { baseUrl: "http://evil", apiKey: "edited-by-user" },
      },
      other: { kept: true },
    };
    await writeFile(join(pi, "models.json"), JSON.stringify(user));
    await writeFile(join(pi, "settings.json"), '{"defaultProvider":"deepseek","defaultModel":"deepseek-v4-flash"}');

    await expect(write()).resolves.toMatchObject({ result: "applied" });
    const models = await readModels();
    expect(models.providers.ollama).toEqual(user.providers.ollama);
    expect(models.other).toEqual({ kept: true });
    expect(models.providers.platform.baseUrl).toBe("http://172.22.0.1:3101/v1");
    expect(models.providers.platform.apiKey).toBe("agent-runtime-relay");
    expect(JSON.parse(await readFile(join(pi, "settings.json"), "utf8")).defaultProvider).toBe("deepseek");
  });

  it("removes the entry when the gateway or the relay is disabled, and a renamed provider", async () => {
    await write();
    await expect(write({ config: null, previousProviderId: "platform" })).resolves.toEqual({
      result: "removed",
      providerId: null,
    });
    expect((await readModels()).providers.platform).toBeUndefined();

    await write();
    await expect(write({ relayOrigin: null, previousProviderId: "platform" })).resolves.toMatchObject({
      result: "removed",
    });
    expect((await readModels()).providers.platform).toBeUndefined();

    await write();
    await write({ config: { ...CONFIG, providerId: "company" }, previousProviderId: "platform" });
    const providers = (await readModels()).providers;
    expect(providers.platform).toBeUndefined();
    expect(providers.company).toBeDefined();
  });

  it("does not create a file just to remove nothing", async () => {
    await expect(write({ config: null })).resolves.toEqual({ result: "removed", providerId: null });
    await expect(lstat(join(pi, "models.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never follows a symbolic link or rewrites an invalid user file", async () => {
    const outside = join(root, "outside.json");
    await writeFile(outside, '{"providers":{}}');
    await symlink(outside, join(pi, "models.json"));
    await expect(write()).resolves.toMatchObject({ result: "user_config_invalid" });
    expect(await readFile(outside, "utf8")).toBe('{"providers":{}}');
    expect((await lstat(join(pi, "models.json"))).isSymbolicLink()).toBe(true);

    for (const content of ["{not json", "[]", '{"providers":[]}']) {
      await rm(join(pi, "models.json"));
      await writeFile(join(pi, "models.json"), content);
      await expect(write(), content).resolves.toMatchObject({ result: "user_config_invalid" });
      expect(await readFile(join(pi, "models.json"), "utf8")).toBe(content);
    }

    await rm(join(pi, "models.json"));
    await mkdir(join(pi, "models.json"));
    await expect(write()).resolves.toMatchObject({ result: "user_config_invalid" });
  });

  it("leaves a settings.json symbolic link alone", async () => {
    const outside = join(root, "settings-target.json");
    await symlink(outside, join(pi, "settings.json"));
    await expect(write()).resolves.toMatchObject({ result: "applied" });
    await expect(lstat(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("model key store (Phase 16.6)", () => {
  const alias = `arw-${WORKSPACE}-1`;

  it("persists keys privately and reloads only files that belong to their Workspace", async () => {
    const workspaces = join(root, "workspaces");
    const metadata = join(workspaces, WORKSPACE, "metadata");
    await mkdir(metadata, { recursive: true });
    const store = new ModelKeyStore();
    await store.set(WORKSPACE, metadata, alias, "sk-virtual-key-1234");
    expect(store.get(WORKSPACE)).toBe("sk-virtual-key-1234");
    expect((await stat(join(metadata, MODEL_KEY_FILE))).mode & 0o777).toBe(0o600);

    const reloaded = new ModelKeyStore();
    await expect(reloaded.load(workspaces)).resolves.toEqual({ loaded: 1, ignored: 0 });
    expect(reloaded.holdings()).toEqual([{ workspaceId: WORKSPACE, keyAlias: alias }]);

    // A key file copied into another Workspace's directory is not served there.
    const other = "a1b2c3d4-aa9a-4bc6-8eee-528b4e0c7c60";
    await mkdir(join(workspaces, other, "metadata"), { recursive: true });
    await writeFile(
      join(workspaces, other, "metadata", MODEL_KEY_FILE),
      await readFile(join(metadata, MODEL_KEY_FILE), "utf8"),
    );
    const third = new ModelKeyStore();
    await expect(third.load(workspaces)).resolves.toEqual({ loaded: 1, ignored: 1 });
    expect(third.get(other)).toBeUndefined();

    // Clearing an older alias keeps the current key in memory and on disk.
    await expect(reloaded.clear(WORKSPACE, metadata, `arw-${WORKSPACE}-0`)).resolves.toBe(alias);
    expect(reloaded.get(WORKSPACE)).toBe("sk-virtual-key-1234");
    await expect(reloaded.clear(WORKSPACE, metadata, alias)).resolves.toBeNull();
    expect(reloaded.get(WORKSPACE)).toBeUndefined();
    await expect(lstat(join(metadata, MODEL_KEY_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(reloaded.clear(WORKSPACE, metadata, alias)).resolves.toBeNull();
  });
});
