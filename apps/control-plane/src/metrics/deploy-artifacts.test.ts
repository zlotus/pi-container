import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The provisioned dashboards and alert rules only reference metrics that exist (specs.md
 * Phase 17.9). Rule behaviour itself is covered by `promtool test rules` in CI.
 */

const REPOSITORY = join(import.meta.dirname, "../../../..");
const OBSERVABILITY = join(REPOSITORY, "deploy/observability");
const DATASOURCE_UID = "agent-runtime-prometheus";

/** Metric names defined by the Control Plane: instruments and scrape-time series. */
function platformMetricNames(): Set<string> {
  const names = new Set<string>();
  for (const file of ["platform-metrics.ts", "collector.ts"]) {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    for (const match of source.matchAll(/"(agent_runtime_[a-z0-9_]+)"/g)) names.add(match[1] ?? "");
  }
  return names;
}

/** LiteLLM 1.104.1 metrics the dashboards use (verified in the image, Phase 17.11 spike). */
const LITELLM_METRICS = new Set([
  "litellm_input_tokens_metric_total",
  "litellm_output_tokens_metric_total",
  "litellm_spend_metric_total",
  "litellm_requests_metric_total",
  "litellm_proxy_failed_requests_metric_total",
  "litellm_llm_api_latency_metric_bucket",
  "litellm_llm_api_time_to_first_token_metric_bucket",
]);

function referenced(text: string): string[] {
  return [...new Set([...text.matchAll(/\b((?:agent_runtime|litellm)_[a-z0-9_]+)/g)].map((match) => match[1] ?? ""))];
}

function known(name: string, platform: Set<string>): boolean {
  if (name.startsWith("litellm_")) return LITELLM_METRICS.has(name);
  return platform.has(name) || platform.has(name.replace(/_(bucket|sum|count)$/, ""));
}

interface Dashboard {
  uid: string;
  panels: Array<{
    id: number;
    datasource?: { uid: string };
    targets: Array<{ expr: string; datasource: { uid: string } }>;
  }>;
}

describe("observability deployment artifacts (Phase 17.9)", () => {
  const platform = platformMetricNames();

  it("defines the specified metric families", () => {
    for (const name of [
      "agent_runtime_workspaces",
      "agent_runtime_worker_up",
      "agent_runtime_worker_last_heartbeat_timestamp_seconds",
      "agent_runtime_gateway_http_requests_total",
      "agent_runtime_worker_commands_total",
      "agent_runtime_workspace_cpu_seconds_total",
      "agent_runtime_workspace_memory_bytes",
      "agent_runtime_workspace_disk_used_bytes",
      "agent_runtime_auth_rate_limited_total",
      "agent_runtime_model_key_revocation_oldest_pending_seconds",
    ]) {
      expect(platform.has(name), name).toBe(true);
    }
  });

  it("provisions dashboards that parse and only query existing metrics", () => {
    const directory = join(OBSERVABILITY, "grafana/dashboards");
    const files = readdirSync(directory).filter((file) => file.endsWith(".json"));
    expect(files.sort()).toEqual(["model-gateway.json", "platform-overview.json", "workspace-resources.json"]);
    const uids = new Set<string>();
    for (const file of files) {
      const dashboard = JSON.parse(readFileSync(join(directory, file), "utf8")) as Dashboard;
      expect(uids.has(dashboard.uid)).toBe(false);
      uids.add(dashboard.uid);
      const ids = dashboard.panels.map((panel) => panel.id);
      expect(new Set(ids).size, file).toBe(ids.length);
      for (const panel of dashboard.panels) {
        expect(panel.datasource?.uid, file).toBe(DATASOURCE_UID);
        for (const target of panel.targets) {
          expect(target.datasource.uid).toBe(DATASOURCE_UID);
          const names = referenced(target.expr);
          expect(names.length, target.expr).toBeGreaterThan(0);
          for (const name of names) expect(known(name, platform), `${file}: ${name}`).toBe(true);
        }
      }
    }
  });

  it("alerts only on existing metrics and links every alert to its runbook section", () => {
    const rules = readFileSync(join(OBSERVABILITY, "rules/agent-runtime.rules.yml"), "utf8");
    for (const name of referenced(rules)) expect(known(name, platform), name).toBe(true);
    const runbook = readFileSync(join(REPOSITORY, "docs/observability-runbook.md"), "utf8");
    const anchors = new Set(
      [...runbook.matchAll(/^#{2,4} (AgentRuntime[A-Za-z]+)/gm)].map((match) => (match[1] ?? "").toLowerCase()),
    );
    const alerts = [...rules.matchAll(/- alert: (\w+)/g)].map((match) => match[1] ?? "");
    expect(alerts).toHaveLength(20);
    for (const anchor of [...rules.matchAll(/runbook: "docs\/observability-runbook\.md#([a-z]+)"/g)]) {
      expect(anchors.has(anchor[1] ?? ""), anchor[1]).toBe(true);
    }
    const tests = readFileSync(join(OBSERVABILITY, "rules/agent-runtime.rules.test.yml"), "utf8");
    for (const alert of alerts) expect(tests, alert).toContain(`alertname: ${alert}`);
  });
});
