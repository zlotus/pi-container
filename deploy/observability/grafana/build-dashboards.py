#!/usr/bin/env python3
"""Generates the provisioned Grafana dashboards (specs.md Phase 17.9).

Edit the panel lists below and run `python3 deploy/observability/grafana/build-dashboards.py`;
the JSON files in dashboards/ are the generated output and are checked in.
"""
import json
from pathlib import Path

DATASOURCE = {"type": "prometheus", "uid": "agent-runtime-prometheus"}
OUT = Path(__file__).parent / "dashboards"


def target(expr, legend="", ref="A", instant=False):
    entry = {"datasource": DATASOURCE, "expr": expr, "legendFormat": legend, "refId": ref}
    if instant:
        entry.update({"instant": True, "range": False, "format": "table"})
    return entry


def panel(kind, title, targets, x, y, w=12, h=8, unit=None, description=None, extra=None):
    result = {
        "type": kind,
        "title": title,
        "datasource": DATASOURCE,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": targets,
        "fieldConfig": {"defaults": {}, "overrides": []},
        "options": {},
    }
    if unit is not None:
        result["fieldConfig"]["defaults"]["unit"] = unit
    if description is not None:
        result["description"] = description
    if extra is not None:
        result.update(extra)
    return result


def dashboard(uid, title, panels, variables=()):
    for index, item in enumerate(panels, start=1):
        item["id"] = index
    return {
        "uid": uid,
        "title": title,
        "tags": ["agent-runtime"],
        "timezone": "browser",
        "schemaVersion": 41,
        "version": 1,
        "editable": False,
        "refresh": "30s",
        "time": {"from": "now-6h", "to": "now"},
        "templating": {"list": list(variables)},
        "panels": panels,
    }


def variable(name, label, query):
    return {
        "name": name,
        "label": label,
        "type": "query",
        "datasource": DATASOURCE,
        "query": {"query": query, "refId": name},
        "definition": query,
        "includeAll": True,
        "multi": True,
        "allValue": ".*",
        "refresh": 2,
        "current": {"text": "All", "value": "$__all"},
    }


platform = dashboard(
    "agent-runtime-platform",
    "Agent Runtime · 平台总览",
    [
        panel("table", "Worker 状态", [
            target("agent_runtime_worker_up", "", "A", instant=True),
            target("agent_runtime_worker_egress_enforced", "", "B", instant=True),
            target("agent_runtime_worker_storage_enforced", "", "C", instant=True),
            target("agent_runtime_worker_schedulable", "", "D", instant=True),
            target("time() - agent_runtime_worker_last_heartbeat_timestamp_seconds", "", "E", instant=True),
        ], 0, 0, 12, 8, description="1 = 是。E 列为距上次心跳的秒数。",
            extra={"transformations": [{"id": "merge", "options": {}}]}),
        panel("timeseries", "Workspace 状态分布", [
            target("sum by (state) (agent_runtime_workspaces)", "{{state}}"),
        ], 12, 0, 12, 8),
        panel("timeseries", "Gateway 请求率", [
            target("sum by (source, status_class) (rate(agent_runtime_gateway_http_requests_total[5m]))", "{{source}} {{status_class}}"),
        ], 0, 8, 8, 8, unit="reqps"),
        panel("timeseries", "Gateway 平台侧 5xx 比例", [
            target('sum(rate(agent_runtime_gateway_http_requests_total{source="platform",status_class="5xx"}[5m])) / sum(rate(agent_runtime_gateway_http_requests_total[5m]))', "5xx"),
        ], 8, 8, 8, 8, unit="percentunit"),
        panel("timeseries", "Gateway 首包耗时", [
            target("histogram_quantile(0.5, sum by (le, source) (rate(agent_runtime_gateway_http_response_header_seconds_bucket[5m])))", "p50 {{source}}", "A"),
            target("histogram_quantile(0.95, sum by (le, source) (rate(agent_runtime_gateway_http_response_header_seconds_bucket[5m])))", "p95 {{source}}", "B"),
        ], 16, 8, 8, 8, unit="s"),
        panel("timeseries", "WebSocket 连接数", [
            target("agent_runtime_gateway_websocket_connections", "连接"),
        ], 0, 16, 8, 8),
        panel("timeseries", "Worker 命令", [
            target("sum by (command, result) (rate(agent_runtime_worker_commands_total[5m]))", "{{command}} {{result}}"),
        ], 8, 16, 8, 8, unit="ops"),
        panel("timeseries", "Worker 命令 p95 耗时", [
            target("histogram_quantile(0.95, sum by (le, command) (rate(agent_runtime_worker_command_duration_seconds_bucket[5m])))", "{{command}}"),
        ], 16, 16, 8, 8, unit="s"),
        panel("timeseries", "登录", [
            target("sum by (protocol, result) (rate(agent_runtime_auth_logins_total[5m]))", "{{protocol}} {{result}}", "A"),
            target("sum by (scope) (increase(agent_runtime_auth_lockouts_total[5m]))", "锁定 {{scope}}", "B"),
        ], 0, 24, 8, 8),
        panel("timeseries", "Portal API 请求", [
            target("sum by (status_class) (rate(agent_runtime_http_requests_total[5m]))", "{{status_class}}"),
        ], 8, 24, 8, 8, unit="reqps"),
        panel("alertlist", "活跃告警", [], 16, 24, 8, 8,
            extra={"options": {"showOptions": "current", "maxItems": 20, "sortOrder": 1, "stateFilter": {"firing": True, "pending": True}}}),
    ],
)

resources = dashboard(
    "agent-runtime-resources",
    "Agent Runtime · Workspace 资源",
    [
        panel("timeseries", "主机 CPU 使用率", [
            target('agent_runtime_worker_host_cpu_utilization_ratio{worker_id=~"$worker_id"}', "{{worker_id}}"),
        ], 0, 0, 8, 8, unit="percentunit"),
        panel("timeseries", "主机可用内存", [
            target('agent_runtime_worker_host_memory_bytes{kind="available",worker_id=~"$worker_id"}', "{{worker_id}}"),
        ], 8, 0, 8, 8, unit="bytes"),
        panel("bargauge", "数据盘剩余", [
            target('agent_runtime_worker_filesystem_bytes{kind="free",worker_id=~"$worker_id"} / ignoring(kind) agent_runtime_worker_filesystem_bytes{kind="total",worker_id=~"$worker_id"}', "{{worker_id}}"),
        ], 16, 0, 8, 8, unit="percentunit"),
        panel("timeseries", "Workspace CPU（核）", [
            target('topk(10, rate(agent_runtime_workspace_cpu_seconds_total{worker_id=~"$worker_id",workspace_id=~"$workspace_id"}[2m]))', "{{workspace_id}}"),
        ], 0, 8, 12, 8),
        panel("timeseries", "Workspace 内存", [
            target('topk(10, agent_runtime_workspace_memory_bytes{worker_id=~"$worker_id",workspace_id=~"$workspace_id"})', "{{workspace_id}}"),
        ], 12, 8, 12, 8, unit="bytes"),
        panel("bargauge", "Workspace 磁盘（data）占上限", [
            target('topk(15, agent_runtime_workspace_disk_used_bytes{project="data",worker_id=~"$worker_id",workspace_id=~"$workspace_id"} / agent_runtime_workspace_disk_limit_bytes{project="data"})', "{{workspace_id}}"),
        ], 0, 16, 12, 8, unit="percentunit"),
        panel("timeseries", "Workspace 网络", [
            target('topk(10, rate(agent_runtime_workspace_network_bytes_total{worker_id=~"$worker_id",workspace_id=~"$workspace_id"}[5m]))', "{{workspace_id}} {{direction}}"),
        ], 12, 16, 12, 8, unit="Bps"),
        panel("table", "OOM 与进程数", [
            target('increase(agent_runtime_workspace_oom_kills_total{worker_id=~"$worker_id",workspace_id=~"$workspace_id"}[24h])', "", "A", instant=True),
            target('agent_runtime_workspace_pids{worker_id=~"$worker_id",workspace_id=~"$workspace_id"}', "", "B", instant=True),
        ], 0, 24, 24, 8, extra={"transformations": [{"id": "merge", "options": {}}]}),
    ],
    [
        variable("worker_id", "Worker", "label_values(agent_runtime_worker_up, worker_id)"),
        variable("workspace_id", "Workspace", 'label_values(agent_runtime_workspace_info{worker_id=~"$worker_id"}, workspace_id)'),
    ],
)

model = dashboard(
    "agent-runtime-model-gateway",
    "Agent Runtime · 模型网关",
    [
        panel("timeseries", "按用户的 token（输入 + 输出）", [
            target("sum by (user) (rate(litellm_input_tokens_metric_total[5m]) + rate(litellm_output_tokens_metric_total[5m]))", "{{user}}"),
        ], 0, 0, 12, 8, description="user 为平台 User UUID；在 Portal 用户页按 UUID 查找。"),
        panel("timeseries", "按用户的花费（USD）", [
            target("sum by (user) (increase(litellm_spend_metric_total[1h]))", "{{user}}"),
        ], 12, 0, 12, 8, unit="currencyUSD"),
        panel("timeseries", "按模型请求与失败", [
            target("sum by (requested_model) (rate(litellm_requests_metric_total[5m]))", "{{requested_model}}", "A"),
            target("sum by (requested_model) (rate(litellm_proxy_failed_requests_metric_total[5m]))", "失败 {{requested_model}}", "B"),
        ], 0, 8, 12, 8, unit="reqps"),
        panel("timeseries", "上游延迟与首 token 时间（p95）", [
            target("histogram_quantile(0.95, sum by (le, model) (rate(litellm_llm_api_latency_metric_bucket[5m])))", "延迟 {{model}}", "A"),
            target("histogram_quantile(0.95, sum by (le, model) (rate(litellm_llm_api_time_to_first_token_metric_bucket[5m])))", "首 token {{model}}", "B"),
        ], 12, 8, 12, 8, unit="s"),
        panel("timeseries", "Worker 中继结果", [
            target("sum by (result) (rate(agent_runtime_model_relay_requests_total[5m]))", "{{result}}", "A"),
            target("sum(rate(agent_runtime_model_relay_rejected_connections_total[5m]))", "被拒连接", "B"),
        ], 0, 16, 12, 8, unit="reqps"),
        panel("timeseries", "凭据状态与吊销积压", [
            target("agent_runtime_model_keys", "{{status}}", "A"),
            target("agent_runtime_model_key_revocation_oldest_pending_seconds", "最老待吊销（秒）", "B"),
        ], 12, 16, 12, 8),
    ],
)

OUT.mkdir(exist_ok=True)
for name, content in (("platform-overview", platform), ("workspace-resources", resources), ("model-gateway", model)):
    (OUT / f"{name}.json").write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
