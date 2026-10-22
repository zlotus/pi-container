# 00 功能总览

平台给每个用户提供隔离的“工作电脑”（Workspace）：一个长期存在的 Linux 容器，里面运行 pi-web（Web 界面）与 Pi（编码 Agent），
文件与会话持久保存。平台负责多用户、隔离、调度、资源限制、安全访问与运维；聊天、终端、文件等交互由 pi-web 提供。

```text
浏览器 ─HTTPS─▶ nginx ─▶ Control Plane（登录、权限、调度、Gateway）─▶ Worker ─▶ Workspace 容器（pi-web + Pi）
                                  │                                   │
                              PostgreSQL                        受管根（XFS）
                              LiteLLM（模型网关）◀── 模型中继 ──────┘
```

## 功能清单

“默认”指生产模板（`deploy/env/*.example`）中的取值。配置项详见 [90](90-reference.md)，操作详见 [10](10-operations.md)。

| 功能 | 作用 | 默认 | 在哪里配置 / 操作 |
|---|---|---|---|
| **Workspace** | 每用户多个；持久的 `/workspace`、`/home/agent`、`/agent/pi`（Pi 状态与会话）；停止不丢数据 | — | Portal「Workspace」 |
| **打开 Workspace** | 新标签页，`https://<id>.agent.<域>`，两级 Gateway 认证；浏览器断开不影响运行中的任务 | — | Portal「打开」 |
| **本地账户** | 用户名/口令登录；管理员创建、禁用、改角色、重置口令、撤销会话 | 开 | Portal「用户」；`agent-runtime-ctl user:create` |
| **企业登录** | OIDC（首选）或 OAuth2 + UserInfo；可按域名自动创建用户（角色固定为 user）；Local Admin 始终可用 | 关 | `control-plane.env` 的 `AUTH_OIDC_*` / `AUTH_OAUTH2_*` |
| **登录防护** | 按账户+地址、地址、账户三维计数临时锁定；管理网络不受账户锁影响（break-glass） | 开（5/20/50 次） | `AUTH_LOCKOUT_*`、`AUTH_TRUSTED_NETWORKS`；`agent-runtime-ctl auth:unlock` |
| **多 Worker 调度** | 新 Workspace 按负载分配到 Worker，之后固定（sticky）；可暂停某台 Worker 的新分配 | — | Portal「Worker」→ 暂停调度 |
| **资源限制** | 每个 Workspace CPU、内存、进程数上限 | 2 核 / 4 GiB / 512 | `WORKSPACE_CPU_COUNT` 等（Control Plane 与 Worker 两处） |
| **磁盘配额** | 每个 Workspace 数据上限（XFS 项目配额），Pi 状态单独 2 GiB；写满只影响它自己 | 20 GiB | `WORKSPACE_DISK_LIMIT_BYTES`；Portal「全部 Workspace」可逐个调整 |
| **网络出口控制** | 允许公网，拒绝内网（RFC1918、Worker 主机、平台地址）；内网按白名单放行 | 开 | Portal「网络出口」；`PLATFORM_EGRESS_PROTECTED` |
| **平台模型** | 用户无需自填 API Key；平台为每个 Workspace 签发虚拟 key，经 Worker 中继访问 LiteLLM，按用户计量与限额 | 开（DeepSeek、MiMo） | `MODEL_GATEWAY_*`；`/etc/agent-runtime/model-gateway/` |
| **Runtime 镜像版本** | Worker 同时提供多个按 digest 固定的镜像；Workspace 停止后可升级到默认镜像或回滚 | 默认 `agent-runtime:2026.10-pi1.1` | `RUNTIME_IMAGES`（Worker）、`DEFAULT_RUNTIME_IMAGE` |
| **空闲回收** | 无连接、无访问且 CPU 低于阈值持续 N 小时的 Workspace 自动**停止**（不删除）；卡片显示预计停止时间 | 开，8 小时 | `IDLE_STOP_AFTER_HOURS`（留空关闭）、`IDLE_CPU_THRESHOLD_CORES` |
| **Worker 吊销** | 禁用一台 Worker：立即断开、其 Workspace 离线、模型 key 吊销；重新启用时轮换凭据 | — | `agent-runtime-ctl worker:disable / enable / delete` |
| **审计** | 登录、用户管理、Workspace 生命周期、Worker、出口、模型 key 等事件；筛选、分页、导出 CSV | 开 | Portal「审计」（普通用户看到自己的「活动」） |
| **指标与告警** | Prometheus 指标（独立端口、Bearer token），19 条示例告警，3 个 Grafana 面板 | 指标开，Prometheus 需自建 | `METRICS_*`；`deploy/observability/` |
| **结构化日志** | JSON 到 journald，不记录 Cookie、token、口令、query string | 开 | `LOG_LEVEL` |
| **用量显示** | Portal 显示 Workspace 与 Worker 的 CPU、内存、磁盘实际用量 | 开 | — |
| **版本显示** | Portal「Worker」显示平台版本、每台 Worker 版本与镜像 | — | `agent-runtime-ctl version` |

## 平台不做的事

- 不备份数据（由企业备份工具做，见 [21](21-backup-restore.md)）；不跨 Worker 迁移或恢复 Workspace。
- 不是 VM 级隔离：Workspace 是 Docker 容器（非特权、只读根、无 capability、独立网络、资源与配额限制），面向可信企业内部用户之间的隔离。
- 不做计费（只计量）、复杂权限模型、Kubernetes、Control Plane 多实例高可用。

## 组成与位置速查

| 组件 | 主机 | 形态 | 位置 |
|---|---|---|---|
| Control Plane（含 Workspace Gateway） | Control Plane | systemd `agent-runtime-control-plane` | `/opt/agent-runtime/current/app/control-plane` |
| Portal（静态网页） | Control Plane | nginx 提供 | `/opt/agent-runtime/current/portal` |
| nginx、PostgreSQL、LiteLLM | Control Plane | compose 项目 `ar-platform` | `/etc/agent-runtime/compose.yml`；数据 `/var/lib/agent-runtime-postgres` |
| Worker（含 Worker Gateway、模型中继） | 每台 Worker | systemd `agent-runtime-worker` | `/opt/agent-runtime/current/app/worker` |
| 出口规则 | 每台 Worker | systemd `agent-runtime-egress`（开机早于 Docker） | nftables 表 `inet agent_runtime` |
| Workspace 数据 | 每台 Worker | 独立 XFS | `/var/lib/agent-runtime/workspaces/<id>/` |
| 配置与密钥 | 每台主机 | 文件 | `/etc/agent-runtime/` |
