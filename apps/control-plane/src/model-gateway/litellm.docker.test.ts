/**
 * Real model gateway integration test (specs.md Phase 16.12): the pinned LiteLLM image with
 * its own PostgreSQL and a mock upstream in this process. No real upstream key is needed.
 * Runs only with TEST_MODEL_GATEWAY=1 (`pnpm test:model-gateway`); CI runs it in the
 * runtime-toolchain workflow (16.14 Q8).
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LiteLlmAdminClient } from "./admin-client.js";

const enabled = process.env.TEST_MODEL_GATEWAY === "1";
const IMAGE =
  "ghcr.io/berriai/litellm-database:1.104.1@sha256:e187eea4b0bbc94c57b93d7dffcd3ce403f17375398a54539a4369cbf8a0e160";
const POSTGRES_IMAGE = "postgres:17.6-alpine";
const UPSTREAM_KEY = "sk-mock-upstream-key-held-by-the-gateway";
const MASTER_KEY = `sk-${randomBytes(16).toString("hex")}`;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Recorded {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** A DeepSeek-like upstream: streams reasoning plus a tool call first, then an answer. */
function mockUpstream(recorded: Recorded[]): Server {
  return createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      const body = JSON.parse(raw === "" ? "{}" : raw) as Record<string, unknown>;
      recorded.push({ path: request.url ?? "", headers: request.headers, body });
      const messages = (body.messages as Array<{ role: string }> | undefined) ?? [];
      const toolTurn = !messages.some((message) => message.role === "tool");
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk({ role: "assistant", reasoning_content: "thinking about it" }));
      if (toolTurn) {
        response.write(
          chunk({
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_marker", arguments: "{}" } }],
          }),
        );
        response.write(chunk({}, "tool_calls"));
      } else {
        response.write(chunk({ content: "MARKER-OK" }));
        response.write(chunk({}, "stop"));
      }
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        })}\n\ndata: [DONE]\n\n`,
      );
      response.end();
    });
  });
}

describe.skipIf(!enabled)("pinned LiteLLM gateway", { timeout: 180_000 }, () => {
  const suffix = randomBytes(3).toString("hex");
  const network = `ar-gateway-test-${suffix}`;
  const postgres = `${network}-pg`;
  const gateway = `${network}-litellm`;
  const recorded: Recorded[] = [];
  let upstream: Server;
  let configDirectory = "";
  let origin = "";
  let admin: LiteLlmAdminClient;

  async function chat(key: string, body: Record<string, unknown>) {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  }

  beforeAll(async () => {
    upstream = mockUpstream(recorded);
    await new Promise<void>((resolve) => upstream.listen(0, "0.0.0.0", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    configDirectory = mkdtempSync(join(tmpdir(), "agent-runtime-litellm-"));
    writeFileSync(
      join(configDirectory, "config.yaml"),
      [
        "model_list:",
        "  - model_name: deepseek-mock",
        "    litellm_params:",
        "      model: litellm_proxy/deepseek-v4-flash",
        `      api_base: http://host.docker.internal:${upstreamPort}/v1`,
        `      api_key: ${UPSTREAM_KEY}`,
        "    model_info:",
        "      input_cost_per_token: 0.001",
        "      output_cost_per_token: 0.002",
        "  - model_name: other-mock",
        "    litellm_params:",
        "      model: litellm_proxy/other",
        `      api_base: http://host.docker.internal:${upstreamPort}/v1`,
        `      api_key: ${UPSTREAM_KEY}`,
        "litellm_settings:",
        "  drop_params: false",
        "general_settings:",
        "  master_key: os.environ/LITELLM_MASTER_KEY",
        "  database_url: os.environ/DATABASE_URL",
        "  store_model_in_db: false",
        "  store_prompts_in_spend_logs: false",
        "  allow_client_side_credentials: false",
        "",
      ].join("\n"),
    );
    docker("network", "create", network);
    docker(
      "run", "-d", "--name", postgres, "--network", network,
      "-e", "POSTGRES_USER=litellm", "-e", "POSTGRES_PASSWORD=test-only", "-e", "POSTGRES_DB=litellm",
      POSTGRES_IMAGE,
    );
    docker(
      "run", "-d", "--name", gateway, "--network", network,
      "--add-host", "host.docker.internal:host-gateway",
      "-e", `LITELLM_MASTER_KEY=${MASTER_KEY}`,
      "-e", `DATABASE_URL=postgresql://litellm:test-only@${postgres}:5432/litellm`,
      "-e", "DISABLE_ADMIN_UI=True", "-e", "LITELLM_LOCAL_MODEL_COST_MAP=True",
      "-v", `${configDirectory}/config.yaml:/etc/litellm/config.yaml:ro`,
      "-p", "127.0.0.1::4000",
      IMAGE, "--config", "/etc/litellm/config.yaml", "--port", "4000", "--num_workers", "1",
    );
    const port = docker("port", gateway, "4000/tcp").split(":").at(-1);
    origin = `http://127.0.0.1:${port}`;
    admin = new LiteLlmAdminClient({ adminUrl: origin, masterKey: MASTER_KEY });
    const deadline = Date.now() + 150_000;
    for (;;) {
      try {
        const response = await fetch(`${origin}/health/readiness`);
        if (response.ok && (await admin.listModels()).length > 0) break;
      } catch {
        // still starting (Prisma migrations)
      }
      if (Date.now() > deadline) throw new Error("LiteLLM did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }, 170_000);

  afterAll(() => {
    for (const name of [gateway, postgres]) {
      try { docker("rm", "-f", name); } catch { /* not started */ }
    }
    try { docker("network", "rm", network); } catch { /* not created */ }
    upstream?.close();
    if (configDirectory !== "") rmSync(configDirectory, { recursive: true, force: true });
  });

  it("issues inference-only virtual keys through the platform admin client", async () => {
    await expect(admin.listModels()).resolves.toEqual(["deepseek-mock", "other-mock"]);
    const userId = randomUUID();
    await admin.ensureUser(userId, { maxBudgetUsd: null, budgetDuration: "30d" });
    await admin.ensureUser(userId, { maxBudgetUsd: 50, budgetDuration: "30d" });
    const keyAlias = `arw-${randomUUID()}-1`;
    const key = await admin.generateKey({
      userId,
      workspaceId: randomUUID(),
      keyAlias,
      models: ["deepseek-mock"],
      rpmLimit: 60,
      tpmLimit: null,
    });
    for (const [method, path] of [
      ["POST", "/key/generate"],
      ["GET", "/key/list"],
      ["GET", "/user/list"],
      ["POST", "/user/new"],
      ["GET", "/spend/logs"],
      ["POST", "/model/new"],
    ] as const) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect([401, 403], path).toContain(response.status);
    }
    expect((await chat(key, { model: "other-mock", messages: [{ role: "user", content: "x" }] })).status).toBe(403);

    // Pi's DeepSeek request shape: thinking, reasoning_effort, tools, streamed usage.
    recorded.length = 0;
    const tools = [{ type: "function", function: { name: "read_marker", parameters: { type: "object", properties: {} } } }];
    const first = await chat(key, {
      model: "deepseek-mock",
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      max_tokens: 1024,
      tools,
      messages: [{ role: "user", content: "call read_marker" }],
    });
    expect(first.status).toBe(200);
    expect(first.text).toContain("thinking about it");
    expect(first.text).toContain("read_marker");
    const second = await chat(key, {
      model: "deepseek-mock",
      stream: true,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      tools,
      messages: [
        { role: "user", content: "call read_marker" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "thinking about it",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_marker", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "MARKER-OK" },
      ],
    });
    expect(second.status).toBe(200);
    expect(second.text).toContain("MARKER-OK");

    expect(recorded).toHaveLength(2);
    const [firstUpstream, secondUpstream] = recorded;
    expect(firstUpstream?.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(JSON.stringify(recorded)).not.toContain(key);
    expect(firstUpstream?.body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high", stream: true });
    expect(firstUpstream?.body.tools).toBeDefined();
    const replayed = (secondUpstream?.body.messages as Array<Record<string, unknown>> | undefined)?.find(
      (message) => message.role === "assistant",
    );
    expect(replayed?.reasoning_content).toBe("thinking about it");

    // Client-side credentials or base URLs never redirect the request.
    const override = await chat(key, {
      model: "deepseek-mock",
      api_base: "http://127.0.0.1:9/v1",
      api_key: "sk-client",
      messages: [{ role: "user", content: "x" }],
    });
    expect([400, 401, 403]).toContain(override.status);
    expect(recorded).toHaveLength(2);

    await expect.poll(async () => (await admin.userUsage(userId))?.spendUsd ?? 0, { timeout: 30_000, interval: 2_000 })
      .toBeGreaterThan(0);
    await expect(admin.userUsage(userId)).resolves.toMatchObject({ maxBudgetUsd: 50 });

    await admin.deleteKey(keyAlias);
    await admin.deleteKey(keyAlias);
    expect((await chat(key, { model: "deepseek-mock", messages: [{ role: "user", content: "x" }] })).status).toBe(401);
  });

  it("enforces the user budget", async () => {
    const userId = randomUUID();
    await admin.ensureUser(userId, { maxBudgetUsd: 0.0001, budgetDuration: "30d" });
    const key = await admin.generateKey({
      userId,
      workspaceId: randomUUID(),
      keyAlias: `arw-${randomUUID()}-1`,
      models: ["deepseek-mock"],
      rpmLimit: 60,
      tpmLimit: null,
    });
    const request = { model: "deepseek-mock", stream: true, messages: [{ role: "user", content: "x" }, { role: "tool", tool_call_id: "c", content: "y" }] };
    expect((await chat(key, request)).status).toBe(200);
    await expect.poll(async () => (await chat(key, request)).status, { timeout: 40_000, interval: 3_000 }).toBe(422);
  });
});
