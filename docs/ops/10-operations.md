# 10 日常运维

按对象分节；每节给出生产形态下的操作（Portal 或 `agent-runtime-ctl`），更深的原理与排障链接到开发文档。命令在 Control Plane 主机
上执行，除非注明“Worker 主机”。修改 `/etc/agent-runtime/*.env` 后都要重启对应服务（[20](20-upgrade.md) 第 3 节）。

## 1. 用户与登录

| 任务 | 操作 |
|---|---|
| 创建本地用户 | Portal「用户」→ 新建；或 `sudo LOCAL_USER_EMAIL=… LOCAL_USER_USERNAME=… LOCAL_USER_ROLE=user LOCAL_USER_PASSWORD=… agent-runtime-ctl user:create` |
| 禁用 / 启用、改角色、重置口令、撤销会话 | Portal「用户」（禁用会立即撤销该用户全部会话并断开其打开的 Workspace） |
| 账户被锁 | Portal「用户」解锁；或 `sudo agent-runtime-ctl auth:unlock login <用户名或邮箱>` / `ip <地址>` / `all` |
| 启用企业登录（OIDC / OAuth2） | 在 `control-plane.env` 设置 `AUTH_OIDC_*`（client secret 写入 `control-plane.secrets.env`），回调地址为 `https://portal.<域>/auth/oidc/callback`；详见 [authentication-runbook](../authentication-runbook.md) |
| Break-glass | IdP 故障时，本地管理员仍可登录；从 `AUTH_TRUSTED_NETWORKS` 中的管理网络登录不受账户维度锁定影响。至少保留一个本地管理员（平台禁止禁用或降级最后一个） |

## 2. Workspace

| 任务 | 操作 |
|---|---|
| 查看全部 Workspace（所有者、状态、Worker、最近访问、用量） | Portal「全部 Workspace」 |
| 调整某个 Workspace 的磁盘上限 | Portal「全部 Workspace」→ 磁盘上限（立即生效，最大 `WORKSPACE_DISK_LIMIT_MAX_BYTES`） |
| 新 Workspace 的默认资源 | `WORKSPACE_CPU_COUNT`、`WORKSPACE_MEMORY_BYTES`、`WORKSPACE_PIDS_LIMIT`、`WORKSPACE_DISK_LIMIT_BYTES`（Control Plane；Worker 的同名项须一致） |
| Workspace 写满 | 用户在 Terminal 删除文件，或管理员调高上限；只影响该 Workspace（[storage-runbook](../storage-runbook.md) 第 6 节） |
| 管理员不能做的事 | 打开、启动、停止、删除他人的 Workspace（只能切换 Runtime 镜像与调整磁盘上限） |

## 3. 空闲回收

- 默认 8 小时（生产模板）：Workspace 同时满足“无连接、无访问、CPU 5 分钟平均低于 `IDLE_CPU_THRESHOLD_CORES`（默认 0.05 核）”并持续
  `IDLE_STOP_AFTER_HOURS` 小时后被**停止**（不删除），记审计 `workspace.idle_stopped`，用户随时可再启动。
- 关闭：`IDLE_STOP_AFTER_HOURS=` 留空；调整：改为 1～720 的整数。修改后重启 Control Plane；重启后计时从零开始。
- Portal 卡片显示“已空闲 X，约 HH:MM 停止”或“当前有连接，不会被回收”。详见 [lifecycle-runbook](../lifecycle-runbook.md) 第 3 节。

## 4. Worker

| 任务 | 操作 |
|---|---|
| 新增 Worker | [04](04-worker-host.md)；之后把它的地址加入 `worker-allow.conf` 与 `PLATFORM_EGRESS_PROTECTED`（地址不在 RFC1918 时必需），重启 nginx 与 Control Plane |
| 暂停新分配（维护前） | Portal「Worker」→ 暂停调度（已有 Workspace 不受影响） |
| 维护 Worker 主机（重启、升级系统） | 暂停调度 → 通知用户 → 重启；运行中的 Workspace 在主机恢复后自动回到运行，期间显示离线 |
| 轮换凭据 | `sudo WORKER_ID=<id> agent-runtime-ctl worker:rotate`，把新 `WORKER_TOKEN` 写入该 Worker 的 `worker.env` 并重启它 |
| 吊销（主机不再可信） | `sudo WORKER_ID=<id> agent-runtime-ctl worker:disable`：数秒内断开、其 Workspace 离线、模型 key 吊销；主机上的容器不会被远程停止 |
| 重新启用 | `sudo WORKER_ID=<id> agent-runtime-ctl worker:enable`（同时轮换凭据，输出新 token） |
| 删除记录 | `sudo WORKER_ID=<id> agent-runtime-ctl worker:delete`（仅限已禁用且没有 Workspace），并从 `WORKER_GATEWAY_TOKENS_JSON` 中删除它 |
| 改 Worker Gateway 地址 | `sudo WORKER_ID=<id> WORKER_GATEWAY_BASE_URL=https://… agent-runtime-ctl worker:configure-gateway`（顺带打印的新 token 可忽略） |

详见 [lifecycle-runbook](../lifecycle-runbook.md) 第 2 节。

## 5. Runtime 镜像（Workspace 里的软件环境）

1. 在构建主机上构建新 tag：`deploy/production/scripts/build-runtime-image.sh <tag>`（[23](23-build-from-source.md) 第 3 节）。**同一 tag
   永不重建**。
2. 每台 Worker：`sudo agent-runtime-image load <归档>`，把输出的 `<tag>@sha256:<digest>` **追加**到 `worker.env` 的 `RUNTIME_IMAGES`（最多 4 个），
   重启 Worker。Portal「Worker」确认新镜像 capability 全为真。
3. 试用：管理员在「全部 Workspace」把一两个已停止的 Workspace 切到新镜像。
4. 切换默认：所有可调度 Worker 都提供后，改 `DEFAULT_RUNTIME_IMAGE` 并重启 Control Plane；用户的卡片出现“升级到 …”，停止后点击即可，
   可随时“回滚”。
5. 下线旧镜像：「Worker」页中旧镜像的 Workspace 数为 0 后，从 `RUNTIME_IMAGES` 删除并重启 Worker，再 `docker image rm`。

详见 [lifecycle-runbook](../lifecycle-runbook.md) 第 1 节（何时更新、回滚含义、pi-web 行为）。

## 6. 网络出口

- 默认：允许公网，拒绝 RFC1918、Worker 主机自身全部地址、平台保护地址与全部 IPv6。
- 放行内网服务（如内部 Git、包镜像）：Portal「网络出口」添加白名单（网段或主机:端口）；平台地址永远不能放行。
- 额外拒绝网段（例如云 metadata、CGNAT）：同一页面添加拒绝规则。
- 平台保护地址：`PLATFORM_EGRESS_PROTECTED`（Control Plane 主机地址、每台 Worker 的地址）。
- 规则由各 Worker 下发并随心跳修复；Portal「Worker」的“出口控制”为“未生效”时该 Worker 不启动任何 Workspace。详见
  [egress-runbook](../egress-runbook.md)。

## 7. 平台模型（模型网关）

| 任务 | 操作 |
|---|---|
| 上游 key | `/etc/agent-runtime/litellm.env`（root 0600），改后 `docker compose -p ar-platform -f /etc/agent-runtime/compose.yml restart litellm` |
| 增删模型、改单价 | `/etc/agent-runtime/model-gateway/config.yaml`（网关）与 `catalog.json`（写入 Workspace 的模型目录），两者 id 一一对应；重启 litellm 与 Control Plane。步骤见 [model-gateway-runbook](../model-gateway-runbook.md) 第 3 节 |
| 每用户预算、速率 | `MODEL_GATEWAY_USER_BUDGET_USD`、`MODEL_GATEWAY_BUDGET_DURATION`、`MODEL_GATEWAY_KEY_RPM`、`MODEL_GATEWAY_KEY_TPM` |
| 用量与 key 状态 | Portal「Worker」页的“模型网关”面板；用户卡片显示用量与预算 |
| 关闭平台模型 | `control-plane.env` 中三个 `MODEL_GATEWAY_*` 与 secrets 中的 master key 留空，`worker.env` 去掉 `WORKER_MODEL_GATEWAY_URL` |

虚拟 key 不进入容器：Workspace 只能访问本机 Worker 的中继端口，中继注入 key 后经 8444 访问网关。禁用用户、删除 Workspace、吊销 Worker
都会吊销对应 key。

## 8. 监控与告警

- Control Plane 指标：`http://127.0.0.1:<METRICS_PORT>/metrics`，Bearer token 为 `/etc/agent-runtime/metrics.token`（只在本机 loopback）。
  `curl -s -H "Authorization: Bearer $(sudo cat /etc/agent-runtime/metrics.token)" 127.0.0.1:9464/metrics | grep agent_runtime_worker_up`
- Prometheus / Grafana：平台不托管；在 Control Plane 主机上运行时，抓取上述地址（`credentials_file` 指向 token 的副本），规则与面板取自发布包
  `deploy/observability/`（19 条告警，含 Worker 离线、出口/配额未生效、默认镜像缺失、磁盘与内存接近上限、OOM、Gateway 错误率）。
  每条告警的含义与处置见 [observability-runbook](../observability-runbook.md) 第 5 节。
- LiteLLM 指标需要一把只允许 `/metrics` 的专用 key（同一 runbook 2.2 节）。

## 9. 日志

| 组件 | 命令 |
|---|---|
| Control Plane | `journalctl -u agent-runtime-control-plane -o cat`（JSON，一行一条；`| jq` 便于查看） |
| Worker | `journalctl -u agent-runtime-worker -o cat`（Worker 主机） |
| nginx 访问日志 | `docker logs ar-platform-nginx-1`（JSON；不含 query string 与 Cookie） |
| PostgreSQL、LiteLLM | `docker logs ar-platform-postgres-1`、`docker logs ar-platform-litellm-1` |
| Workspace 容器 | `docker logs agent-runtime-<workspace-id>`（Worker 主机；pi-web 日志） |

按请求追踪：Control Plane 与 Worker 的日志都带 `requestId`。日志永不包含 Cookie、Authorization、token、口令与请求正文。

## 10. 审计

Portal「审计」：按类别、用户、Workspace、Worker、时间筛选，分页加载，导出 CSV。普通用户在「活动」页只看到自己的 Workspace 事件。审计
只追加、不在平台内清理；需要长期保存时定期导出或在数据库备份中保留。

## 11. 定期检查（建议）

| 周期 | 内容 |
|---|---|
| 每天 | 告警；Portal「Worker」全部在线且已生效 |
| 每周 | `audit-host.sh`（每台主机）；Worker 受管根可用空间；备份是否成功 |
| 每季度 | 恢复演练（[21](21-backup-restore.md) 第 5 节）；证书到期时间（[02](02-tls-and-dns.md) 第 3 节）；Runtime 镜像基础层刷新与漏洞扫描（[31](31-security.md)） |
