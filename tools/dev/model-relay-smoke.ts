/**
 * DEV ONLY: end-to-end smoke test of platform model access (specs.md Phase 16.15).
 *
 * Real Pi 0.85.1 in a throwaway Runtime container -> the real Worker ModelRelay on this host
 * -> the LiteLLM gateway -> the real upstream. The container gets exactly the provider entry
 * the Worker writes (placeholder apiKey); the virtual key stays in this process. Afterwards
 * the container's environment and Pi state are searched for the key.
 *
 * Usage (from the repository root, gateway running, master key in the 0600 env file):
 *   pnpm --filter @agent-runtime/worker exec tsx ../../tools/dev/model-relay-smoke.ts \
 *     ~/.config/agent-runtime/litellm.env [--url http://127.0.0.1:4400] [--model deepseek-v4-flash ...]
 * Real upstream calls cost a few cents. Not a Workspace: no egress table, no quotas.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

import { ModelGatewayConfigSchema } from "../../packages/protocol/src/index.js";

import { renderPlatformProvider } from "../../apps/worker/src/model-relay/pi-config.js";
import { ModelRelay } from "../../apps/worker/src/model-relay/relay.js";

const args = process.argv.slice(2);
const envFile = (args[0] ?? "").replace(/^~/, homedir());
const gatewayUrl = args.includes("--url") ? args[args.indexOf("--url") + 1] ?? "" : "http://127.0.0.1:4400";
const requested = args.flatMap((value, index) => (args[index - 1] === "--model" ? [value] : []));
const image = process.env.RUNTIME_IMAGE ?? "agent-runtime:phase7-toolchain";
const catalogPath = new URL("../../deploy/model-gateway/catalog.example.json", import.meta.url);

const execFileAsync = promisify(execFile);

/** The relay serves from this process: anything that waits on Pi must not block the loop. */
async function dockerAsync(...command: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", command, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

function docker(...command: string[]): string {
  return execFileSync("docker", command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function masterKey(): string {
  const info = statSync(envFile);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`${envFile} must have mode 0600`);
  const line = readFileSync(envFile, "utf8").split("\n").find((entry) => entry.startsWith("LITELLM_MASTER_KEY="));
  if (line === undefined) throw new Error("LITELLM_MASTER_KEY not found");
  return line.slice("LITELLM_MASTER_KEY=".length).trim();
}

async function admin(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${gatewayUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${masterKey()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return json;
}

const results: boolean[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push(ok);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail === "" ? "" : ` — ${detail.slice(0, 300)}`}`);
}

const catalog = ModelGatewayConfigSchema.parse(JSON.parse(readFileSync(catalogPath, "utf8")));
const models = requested.length > 0 ? requested : ["deepseek-v4-flash", "deepseek-v4-pro"];
const workspaceId = randomUUID();
const userId = `smoke-${randomBytes(4).toString("hex")}`;
const keyAlias = `arw-${workspaceId}-1`;
const network = `ar-relay-smoke-${randomBytes(3).toString("hex")}`;
const container = `${network}-pi`;
let relay: ModelRelay | null = null;

try {
  docker("network", "create", "--driver", "bridge", network);
  docker(
    "run", "-d", "--name", container, "--network", network, "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--user", "1000:1000",
    "-e", "PI_CODING_AGENT_DIR=/tmp/pi", "-e", "HOME=/tmp/home",
    "--entrypoint", "sleep", image, "infinity",
  );
  const inspect = JSON.parse(docker("inspect", container)) as Array<{
    NetworkSettings: { Networks: Record<string, { IPAddress: string; Gateway: string }> };
  }>;
  const endpoint = inspect[0]?.NetworkSettings.Networks[network];
  if (endpoint === undefined) throw new Error("container has no address");

  await admin("/user/new", { user_id: userId, user_role: "internal_user_viewer" });
  const generated = (await admin("/key/generate", {
    user_id: userId,
    key_alias: keyAlias,
    key_type: "llm_api",
    models: catalog.models.map((model) => model.id),
    metadata: { platform_workspace_id: workspaceId },
  })) as { key: string };
  const virtualKey = generated.key;

  relay = new ModelRelay({
    port: 0,
    host: endpoint.Gateway,
    upstream: new URL(gatewayUrl),
    keys: { get: (id) => (id === workspaceId ? virtualKey : undefined) },
    endpoints: async () => [{ workspaceId, gatewayAddress: endpoint.Gateway, containerAddress: endpoint.IPAddress }],
    maxBodyBytes: 32 * 1024 * 1024,
    log: { info: () => undefined, warn: () => undefined },
  });
  await relay.start();
  const port = relay.address()?.port ?? 0;
  const provider = renderPlatformProvider(catalog, `http://${endpoint.Gateway}:${port}`);
  const modelsJson = JSON.stringify({ providers: { [catalog.providerId]: provider } }, null, 2);
  docker("exec", container, "sh", "-c", `mkdir -p /tmp/pi /tmp/home /tmp/work && cat > /tmp/pi/models.json <<'EOF'\n${modelsJson}\nEOF`);
  console.log(`relay http://${endpoint.Gateway}:${port} for container ${endpoint.IPAddress}`);

  for (const model of models) {
    const marker = `RELAY-${randomBytes(4).toString("hex")}`;
    const prompt =
      `Use the bash tool to run exactly: echo ${marker} > /tmp/work/out.txt && cat /tmp/work/out.txt ` +
      "Then reply with only the text the command printed.";
    let output = "";
    try {
      output = await dockerAsync(
        "exec", "-w", "/tmp/work", "-e", "PI_OFFLINE=1", "-e", "PI_SKIP_VERSION_CHECK=1", container,
        "timeout", "180", "pi", "-p", "--no-session",
        "--model", `${catalog.providerId}/${model}`, "--thinking", "high", prompt,
      );
    } catch (error) {
      output = String((error as { stderr?: string }).stderr ?? error);
    }
    const file = docker("exec", container, "sh", "-c", "cat /tmp/work/out.txt 2>/dev/null || true");
    check(`${model}: Pi ran the bash tool through the relay`, file.includes(marker), file);
    check(`${model}: the final answer (after the tool turn) contains the marker`, output.includes(marker), output);
    docker("exec", container, "rm", "-f", "/tmp/work/out.txt");
  }

  const exposed = docker("exec", container, "sh", "-c", "env; cat /tmp/pi/*.json 2>/dev/null; ls -la /tmp/pi");
  check("virtual key is absent from the container environment and Pi state", !exposed.includes(virtualKey));
  check("models.json carries only the placeholder key", exposed.includes("agent-runtime-relay"));
} finally {
  await relay?.stop().catch(() => undefined);
  try { docker("rm", "-f", container); } catch { /* already gone */ }
  try { docker("network", "rm", network); } catch { /* already gone */ }
  await admin("/key/delete", { key_aliases: [keyAlias] }).catch(() => undefined);
  await admin("/user/delete", { user_ids: [userId] }).catch(() => undefined);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length && results.length > 0 ? 0 : 1);
