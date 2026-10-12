# Observability Runbook

Phase 17（`specs.md` 第 64 节 Phase 17）的运维说明：Control Plane 在独立端口上暴露 Prometheus 指标（Bearer
token 认证），Worker 经心跳上报容器与主机的实际用量，Portal 显示实际用量；开发环境提供 Prometheus + Grafana、
示例告警规则与面板。指标只用于观测：它的任何故障都不改变 Workspace 状态、调度、出口或配额决策。

## 1. 组成

| 组件 | 位置 | 作用 |
|---|---|---|
| 指标监听 | Control Plane，`METRICS_HOST:METRICS_PORT`（建议 `127.0.0.1:9464`） | 只接受 `GET /metrics` + Bearer token；不在 Portal API（3000）与 Workspace Gateway（3001）上 |
| Worker 用量采样 | Worker，每次心跳（默认 10 s） | Docker Engine API one-shot stats（CPU、内存、PID、网络）、OOM 事件流、主机 CPU/内存；随心跳上报，Worker 不新增端口 |
| 实时用量 | Control Plane 内存（不持久化） | Portal 与指标共用；样本超过 `WORKER_OFFLINE_AFTER_MS`（默认 35 s）即视为过期 |
| Prometheus 3.13.4 / Grafana 13.2.3（pin digest） | `deploy/observability/compose.yml`（DEV ONLY） | 抓取、告警规则、面板；只监听 `127.0.0.1:9090` / `127.0.0.1:3300` |
| 告警规则 | `deploy/observability/rules/agent-runtime.rules.yml`（单元测试 `agent-runtime.rules.test.yml`） | 19 条示例规则，见第 5 节 |
| 面板 | `deploy/observability/grafana/dashboards/`（由 `build-dashboards.py` 生成） | 平台总览、Workspace 资源、模型网关 |
| LiteLLM 指标 | LiteLLM `/metrics`（`config.yaml` 中 `callbacks: ["prometheus"]`） | 按用户 token 与花费、按模型延迟与失败 |

指标中只有 UUID、Worker ID 与枚举标签：没有 email、用户名、Workspace 名称、路径、IP、request ID 或任何凭据。
能访问 Prometheus/Grafana 的人可以看到每个 Workspace 的资源用量与每个用户的模型用量，Grafana 只发给运维人员。

## 2. 配置

### 2.1 Control Plane 指标端点

```bash
tools/dev/init-metrics-token.sh              # 生成 ~/.config/agent-runtime/metrics.token（0600，不打印内容）
```

`.env`：

```bash
METRICS_HOST=127.0.0.1
METRICS_PORT=9464
METRICS_TOKEN_FILE=/home/<user>/.config/agent-runtime/metrics.token
```

启动时校验（任一不满足则 Control Plane 拒绝启动）：token 文件是普通文件、不是符号链接、权限不含 group/other
位、内容为 32～512 个可打印 ASCII 字符；`METRICS_HOST` 不能是 `0.0.0.0` / `::`；端口不能与 Portal API、
Workspace Gateway 冲突。未设置 `METRICS_PORT` 时不启动指标监听。

验证：

```bash
curl -si 127.0.0.1:9464/metrics | head -1                                        # 401
curl -s -H "Authorization: Bearer $(cat ~/.config/agent-runtime/metrics.token)" \
  127.0.0.1:9464/metrics | grep '^agent_runtime_worker_up'
```

**token 轮换**：生成新文件（`rm` 旧文件后重新执行脚本），重启 Control Plane，再重启 Prometheus 容器（它在每次
抓取时读取 `credentials_file`，重启只是为了尽快生效）。

### 2.2 LiteLLM 指标专用 key

LiteLLM 的 `/metrics` 默认要求认证；Workspace 用的 `llm_api` key 与 `read_only` key 都读不了它。Prometheus 使用
一把**只允许 `/metrics` 路由、没有任何模型**的专用 key（Phase 17.11 spike：该 key 调用推理、管理、`/user/info`、
`/model/info`、`/v1/models` 均为 403）：

```bash
tools/dev/create-litellm-metrics-key.sh ~/.config/agent-runtime/litellm.env
# -> ~/.config/agent-runtime/litellm-metrics.token（0600，不打印 key）
```

脚本用 master key 调用 `/key/generate`（`key_alias=prometheus-metrics`、`allowed_routes=["/metrics"]`、
`models=["no-default-models"]`）。轮换：在网关中删除 alias `prometheus-metrics`（`/key/delete`，`key_aliases`），
删除本地文件后重新执行。Prometheus 端用 `labeldrop` 去掉 LiteLLM 的 `client_ip`、`user_agent`、`user_email`、
`hashed_api_key` 标签。

`deploy/model-gateway/config.yaml` 增加 `callbacks: ["prometheus"]` 后需要重建网关容器（**在主 checkout 中**）：

```bash
LITELLM_ENV_FILE=~/.config/agent-runtime/litellm.env \
  docker compose -f deploy/model-gateway/compose.yml up -d --force-recreate
```

### 2.3 Prometheus 与 Grafana（开发）

```bash
install -m 600 deploy/observability/grafana.env.example ~/.config/agent-runtime/grafana.env   # 改密码
METRICS_TOKEN_FILE=$HOME/.config/agent-runtime/metrics.token \
LITELLM_METRICS_TOKEN_FILE=$HOME/.config/agent-runtime/litellm-metrics.token \
GRAFANA_ENV_FILE=$HOME/.config/agent-runtime/grafana.env \
  docker compose -f deploy/observability/compose.yml up -d
```

- **只从主 checkout 启动**：配置以 bind mount 挂载，Docker 记录的是创建时的绝对路径（worktree 删除后容器无法启动）。
- 两个服务使用 host network 并只监听 `127.0.0.1`：Control Plane 指标端口在 loopback 上，桥接网络中的容器访问不到。
  它们是运维组件，`hostNetwork=false` 是对 Workspace 容器的要求。Grafana 用 3300（3000 是 Control Plane）。
- Prometheus 以 `OBSERVABILITY_UID:OBSERVABILITY_GID`（默认 `1000:1000`）运行以读取 `0600` token 文件；一次性
  服务 `prometheus-volume-owner` 把数据卷交给该用户。数据保留 30 天或 10 GB（先到者）。
- Prometheus 未开启 admin API、lifecycle API、remote write；Grafana 关闭匿名访问、注册、遥测、更新检查与插件预装。
- 访问：Prometheus `http://127.0.0.1:9090`（Targets、Alerts）；Grafana `http://127.0.0.1:3300`，文件夹 “Agent Runtime”。
  远程查看用 `ssh -L 3300:127.0.0.1:3300 -L 9090:127.0.0.1:9090 <host>`，不要把端口改成对外监听。

### 2.4 跨主机部署时的出口保护

Workspace 不能访问指标端点、Prometheus 与 Grafana：

- 部署在 Worker 宿主机上：Phase 14 的 `fib daddr type local` 丢弃发往宿主机任何地址的包。
- 部署在其他主机、地址为 RFC1918：默认拒绝。
- 公网地址：必须加入 `PLATFORM_EGRESS_PROTECTED`；`METRICS_HOST` 为非 loopback 地址时 Control Plane 会自动加入。
  白名单永远不能放行 protected 地址。

## 3. 指标

完整清单见 `specs.md` 17.4。常用查询：

| 问题 | PromQL |
|---|---|
| 哪些 Worker 离线 | `agent_runtime_worker_up == 0 and on(worker_id) agent_runtime_worker_enabled == 1` |
| Workspace CPU（核） | `rate(agent_runtime_workspace_cpu_seconds_total[2m])` |
| Workspace 内存占上限 | `agent_runtime_workspace_memory_bytes / agent_runtime_workspace_memory_limit_bytes` |
| 磁盘占上限 | `agent_runtime_workspace_disk_used_bytes / agent_runtime_workspace_disk_limit_bytes` |
| 某用户的 Workspace | `agent_runtime_workspace_info{user_id="<uuid>"}` |
| Gateway 平台侧 5xx | `sum(rate(agent_runtime_gateway_http_requests_total{source="platform",status_class="5xx"}[5m]))` |
| 命令超时 | `increase(agent_runtime_worker_commands_total{result="timeout"}[1h])` |

口径说明：

- 内存 = `usage − inactive_file`，与 `docker stats` 相同。CPU 为两次采样间的核数；`docker stats` 的 CPU% ÷ 100 即核数。
- Worker 上报的计数器（CPU 秒、网络字节、OOM、中继请求）在 Worker 或容器重启后从 0 开始；用 `rate()`/`increase()`。
- OOM 计数来自 Docker 事件流，事件流断开重连期间的事件会丢失，是下限。
- Gateway 耗时是到写出响应头的时间，SSE 与长下载的总时长不计入。`source="platform"` 表示 Gateway 自己的响应
  （未授权、Workspace 不可用、Worker 不可达）。

## 4. Portal 显示

- Workspace 卡片（运行中）：“CPU x / 2 核”“内存 x / 4 GiB”，≥ 90% 告警色；OOM 次数大于 0 时提示。页面可见且有运行中
  Workspace 时每 15 秒刷新。
- Admin Workspaces：“CPU / 内存”列。Admin Workers：“主机资源”列显示 CPU 使用率与可用内存，悬停或下方小字显示容量、
  运行中 Workspace 的合计 CPU 与内存、负载。“Workspace 容量”列仍是 assignment 数（调度语义）。
- Worker 离线或样本过期时不显示实际用量（显示静态容量）。

## 5. 告警与处置

规则阈值为默认建议值，可按部署调整；修改后运行 `promtool test rules`（第 6 节）。告警通知投递（Alertmanager、邮件、
企业 IM）不在 Phase 17 范围内，接入时在 `prometheus.yml` 增加 `alerting` 配置即可。

### AgentRuntimeControlPlaneDown

Prometheus 2 分钟抓取不到 Control Plane。检查进程是否运行、`METRICS_PORT` 是否监听（`ss -ltn | grep 9464`）、
Prometheus 使用的 token 文件是否与 Control Plane 一致（Prometheus Targets 页显示 401 即 token 不一致）。

### AgentRuntimeMetricsCollectorFailing

scrape 时的数据库快照失败（2 秒语句超时或数据库不可用）。平台状态类指标缺失，进程内计数照常。检查 `/ready` 与
PostgreSQL；长事务或锁会导致超时。

### AgentRuntimeWorkerOffline

已启用且曾经在线的 Worker 超过离线判定时间（默认 35 s）没有心跳，其 Workspace 为 `WORKER_OFFLINE`。检查 Worker
进程与日志、Worker 与 Control Plane 之间的网络（开发环境经 Tailscale）。长期不用的 Worker 应吊销（`enabled=false`）
或删除，否则会持续告警。

### AgentRuntimeWorkerEgressUnenforced

出口规则无法确认，Worker 不会启动 Workspace 并已停止运行中的 Workspace。见 `docs/egress-runbook.md`（`CAP_NET_ADMIN`、
`nft list table inet agent_runtime`）。

### AgentRuntimeWorkerStorageUnenforced

XFS project quota 无法确认。见 `docs/storage-runbook.md`（挂载、`prjquota`、`CAP_SYS_ADMIN`）。

### AgentRuntimeDefaultRuntimeImageMissing

可调度的在线 Worker 没有提供平台默认 Runtime 镜像（`DEFAULT_RUNTIME_IMAGE`）：镜像未构建、`RUNTIME_IMAGES` 中漏写，或 tag
被重新指向其他内容而与 pin 的 digest 不符。新 Workspace 不会分配到该 Worker，已有 Workspace 不受影响。Admin Workers 的
“详情”列出该 Worker 提供的镜像；Worker 日志中有 “not offered” 的原因。处理见 `docs/runtime-upgrade-runbook.md`。

### AgentRuntimeWorkerModelRelayDown

启用了模型网关的 Worker 中继没有监听（端口被占用等），其 Workspace 无法使用平台模型。见
`docs/model-gateway-runbook.md` 第 5 节。

### AgentRuntimeWorkerFilesystemLow

`WORKER_MANAGED_ROOT` 文件系统剩余不足 10%（warning）或 5%（critical，`AgentRuntimeWorkerFilesystemCritical`）。
Workspace 上限之和可以超过容量（不预留空间）。扩容文件系统（`xfs_growfs`），或与用户沟通清理；平台不会自动删除数据。

### AgentRuntimeWorkspaceDiskNearLimit

某 Workspace 的数据（或 Pi 状态，`AgentRuntimeWorkspacePiStateNearLimit`）超过上限的 90%。用户可在 Terminal 中清理；
admin 可在 Admin Workspaces 调整上限（即时生效）。

### AgentRuntimeWorkspaceMemoryNearLimit

容器内存持续 15 分钟超过上限的 90%，进程随时可能被 OOM 终止。通常是大型构建、浏览器或常驻服务；需要时与用户沟通。

### AgentRuntimeWorkspaceOOMKilled

最近 15 分钟容器内有进程因内存超限被终止。超过内存上限的部分先进入 swap（Workspace 的 `MemorySwap` 默认为内存上限的 2 倍，即 8 GiB），总量超过它才会 OOM；在此之前内存会停在上限并触发 `AgentRuntimeWorkspaceMemoryNearLimit`。Portal 卡片会提示用户。若频繁出现，考虑调整 `WORKSPACE_MEMORY_BYTES`。

### AgentRuntimeWorkspacesInError

有 Workspace 持续 15 分钟处于 `ERROR`。常见原因：出口或配额曾经未生效（fail-closed 停止）、启动失败。查 Audit 与
Worker 日志后由用户重新启动。

### AgentRuntimeWorkspacesStuckTransitional

有 Workspace 持续 15 分钟处于过渡状态（含 Runtime 切换中的 `UPGRADING`）。检查对应 Worker 是否在线、命令是否超时（下一条）。
`UPGRADING` 长时间不结束通常意味着 Control Plane 在命令期间重启：Worker 重连后的 reconcile 会把它收敛为 `STOPPED` 或
“切换未完成”的 `ERROR`。

### AgentRuntimeGatewayErrorRate

Gateway 自身返回的 5xx 占比超过 5%（10 分钟内至少 20 个请求）。通常是 Worker Gateway 不可达或 Worker 离线；检查
Worker 状态与 `WORKER_GATEWAY_TOKENS_JSON`。pi-web 自己的 5xx（`source="upstream"`）不计入。

### AgentRuntimeWorkerCommandTimeouts

最近 10 分钟有 Worker 命令超过 `WORKER_COMMAND_TIMEOUT_MS`（默认 15 s）未响应。检查 Worker 是否卡住（Docker 慢、
磁盘 I/O）、Worker 日志中的命令处理时间。

### AgentRuntimeLoginLockoutSurge

15 分钟内超过 10 次登录锁定，可能存在暴力破解。查看 Admin Users 的“登录锁定”与 Audit `auth.login_locked`；见
`docs/authentication-runbook.md`。

### AgentRuntimeModelKeyRevocationStuck

有虚拟 key 等待网关删除超过 15 分钟（网关不可达或拒绝）。Worker 侧已经停止使用该 key，但在网关确认前它在网关侧可能
仍然有效。恢复网关后后台循环会完成吊销；见 `docs/model-gateway-runbook.md`。

### AgentRuntimeModelGatewayUnreachable

Control Plane 的管理调用或 Prometheus 抓取连续 10 分钟无法访问 LiteLLM。新凭据无法签发、吊销积压；检查网关容器与
数据库。

## 6. 验证与变更

```bash
docker run --rm -v "$PWD/deploy/observability:/w:ro" -w /w/rules --entrypoint promtool \
  prom/prometheus:v3.13.4@sha256:87861b8cf91579109319ebc300f3f1060e6da9c05d6ae8ad15a20c879e84e32e \
  test rules agent-runtime.rules.test.yml
python3 deploy/observability/grafana/build-dashboards.py     # 修改面板后重新生成 JSON
pnpm --filter @agent-runtime/control-plane test src/metrics   # 面板与规则只引用存在的指标
```

升级 Prometheus/Grafana：核对 changelog，拉取新版本记录 digest，同步修改 compose、CI 与 `specs.md` 17.1。

## 7. 排查清单

- Prometheus Targets：control-plane 为 401 → token 不一致；connection refused → `METRICS_PORT` 未设置或 Control Plane 未运行。
- litellm 为 401 → 专用 key 被删除或文件错误；404 → 网关未启用 `prometheus` callback。
- Portal 不显示实际用量：Worker 是否为协议 v5（日志 `control channel connected`）、Worker 日志是否有采样失败（`debug`）、
  `docker stats` 是否正常。
- 面板无数据：Grafana 数据源 UID 为 `agent-runtime-prometheus`；在 Prometheus 中直接查询对应指标确认。
