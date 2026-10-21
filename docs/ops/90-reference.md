# 90 参考：配置、命令、文件与端口

所有配置在启动时校验，不合法即拒绝启动（日志说明哪一项）。格式：每行 `KEY=value`，不加引号、不加行尾注释。

## 1. Control Plane：`/etc/agent-runtime/control-plane.env` 与 `control-plane.secrets.env`

带 🔒 的放在 `control-plane.secrets.env`（`init-secrets.sh` 生成）。

| 配置项 | 默认 | 说明 |
|---|---|---|
| 🔒 `DATABASE_URL` | — | 平台数据库 |
| `DATABASE_MIGRATE_ON_START` | `true`（模板 `false`） | 生产只用 `agent-runtime-ctl db:migrate` 迁移；为 `false` 且有待执行 migration 时拒绝启动 |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Portal API 与 Worker 控制通道（nginx 转发） |
| `GATEWAY_HOST` / `GATEWAY_PORT` | `127.0.0.1` / `3001` | Workspace Gateway（nginx 转发 `*.agent.<域>`） |
| `METRICS_HOST` / `METRICS_PORT` / `METRICS_TOKEN_FILE` | `127.0.0.1` / 空（模板 `9464`） / — | 指标监听；端口为空则不监听；token 文件必须 0600 |
| `PORTAL_ORIGIN` | — | `https://portal.<域>`，Cookie 与 Origin 校验、SSO 回调都以它为准 |
| `PORTAL_ALLOWED_ORIGINS` | 空 | 额外可信 Origin（精确匹配，逗号分隔） |
| `WORKSPACE_BASE_URL` | — | `https://agent.<域>`；Workspace 为 `<id>.agent.<域>`，必须与 Worker 的同名项一致 |
| 🔒 `SESSION_SECRET` | — | 会话与 CSRF 的密钥（≥ 32 字符）；更换会使全部登录失效 |
| `SESSION_COOKIE_SECURE` / `SESSION_TTL_HOURS` | `true` / `12` | |
| `WORKSPACE_SESSION_EXCHANGE_TTL_MS` | `60000` | 打开 Workspace 的一次性码有效期 |
| 🔒 `WORKER_GATEWAY_TOKENS_JSON` | `{}` | `{"<worker id>":"<WORKER_GATEWAY_TOKEN>"}`，每台 Worker 一项 |
| `DEFAULT_RUNTIME_IMAGE` | `agent-runtime:2026.10-pi1.1` | 新 Workspace 与“升级”的目标镜像 |
| `WORKER_OFFLINE_AFTER_MS` / `WORKER_STATUS_SWEEP_MS` / `WORKER_COMMAND_TIMEOUT_MS` | `35000` / `5000` / `15000` | Worker 离线判定、巡检周期、命令超时 |
| `WORKSPACE_CPU_COUNT` / `WORKSPACE_MEMORY_BYTES` / `WORKSPACE_PIDS_LIMIT` | `2` / 4 GiB / `512` | 新 Workspace 的资源上限 |
| `WORKSPACE_DISK_LIMIT_BYTES` / `WORKSPACE_DISK_LIMIT_MAX_BYTES` | 20 GiB / 1 TiB | 默认数据配额 / 管理员可设的最大值 |
| `IDLE_STOP_AFTER_HOURS` / `IDLE_CPU_THRESHOLD_CORES` | 空（模板 `8`） / `0.05` | 空闲回收；空即关闭 |
| `PLATFORM_EGRESS_PROTECTED` | 空 | 平台保护地址（IPv4 或 CIDR，逗号分隔）：本机地址、每台 Worker 地址 |
| `AUTH_TRUSTED_PROXIES` | 空（模板 loopback） | 读取 `X-Forwarded-For` 的代理地址 |
| `AUTH_TRUSTED_NETWORKS` | `127.0.0.1/32,::1/128` | 管理网络：不受账户维度登录锁定影响 |
| `AUTH_LOCKOUT_ACCOUNT_IP_THRESHOLD` / `AUTH_LOCKOUT_IP_THRESHOLD` / `AUTH_LOCKOUT_ACCOUNT_THRESHOLD` / `AUTH_SSO_START_LIMIT` | `5` / `20` / `50` / `30` | 登录防护阈值 |
| `AUTH_OIDC_ENABLED`、`AUTH_OIDC_PROVIDER_ID`、`AUTH_OIDC_ISSUER`、`AUTH_OIDC_CLIENT_ID`、🔒 `AUTH_OIDC_CLIENT_SECRET`、`AUTH_OIDC_AUTO_PROVISION`、`AUTH_OIDC_ALLOWED_DOMAINS` | 关 | OIDC 登录；回调 `<PORTAL_ORIGIN>/auth/oidc/callback` |
| `AUTH_OAUTH2_*`（`_ENABLED`、`_AUTHORIZATION_URL`、`_TOKEN_URL`、`_USERINFO_URL`、`_USERINFO_TOKEN_METHOD`、`_CLIENT_ID`、🔒`_CLIENT_SECRET`、`_SCOPE`、`_SUBJECT_FIELD`、`_USERNAME_FIELD`、`_EMAIL_FIELD`、`_DISPLAY_NAME_FIELD`、`_AUTO_PROVISION`、`_ALLOWED_DOMAINS`、`_PROVIDER_ID`） | 关 | OAuth2 + UserInfo 登录；回调 `<PORTAL_ORIGIN>/auth/oauth2/callback` |
| `MODEL_GATEWAY_ADMIN_URL` / 🔒 `MODEL_GATEWAY_MASTER_KEY` / `MODEL_GATEWAY_CATALOG_FILE` | 空 | 三项同时设置或同时留空；地址须为 HTTPS 或 loopback HTTP |
| `MODEL_GATEWAY_USER_BUDGET_USD` / `MODEL_GATEWAY_BUDGET_DURATION` | 空（不限） / `30d` | 每用户预算 |
| `MODEL_GATEWAY_KEY_RPM` / `MODEL_GATEWAY_KEY_TPM` | `60` / 空 | 每个虚拟 key 的速率 |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | |

## 2. Worker：`/etc/agent-runtime/worker.env`（root:agent-runtime 0640）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `CONTROL_PLANE_URL` | — | `wss://<内部入口>:8443/api/workers/connect` |
| `WORKER_ID` / `WORKER_TOKEN` / `WORKER_GATEWAY_TOKEN` | — | `worker:provision` 的输出；两个 token 必须不同 |
| `WORKER_MAX_WORKSPACES` | — | 分配上限（含已停止的 Workspace） |
| `WORKER_GATEWAY_HOST` / `WORKER_GATEWAY_PORT` | `127.0.0.1` / `3100` | Worker Gateway 监听；非 loopback 时必须配 TLS |
| `WORKER_GATEWAY_TLS_CERT_PATH` / `WORKER_GATEWAY_TLS_KEY_PATH` | — | 同时设置 |
| `WORKSPACE_BASE_URL` | — | 与 Control Plane 完全一致 |
| `RUNTIME_IMAGES` | —（必填） | 1～4 个 `<名字>@sha256:<digest>`，逗号分隔 |
| `RUNTIME_CAPABILITY_PROBE_TIMEOUT_MS` | `120000` | 每个镜像的能力探针超时 |
| `WORKER_MANAGED_ROOT` | `/var/lib/agent-runtime` | 独立 XFS（`prjquota`） |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | 只有 Worker 使用，从不挂进 Workspace |
| `WORKSPACE_CPU_COUNT` / `WORKSPACE_MEMORY_BYTES` / `WORKSPACE_PIDS_LIMIT` | `2` / 4 GiB / `512` | 与 Control Plane 一致 |
| `WORKSPACE_UID` / `WORKSPACE_GID` | `1000` / `1000` | Workspace 运行身份 |
| `WORKSPACE_DATA_INODE_LIMIT` / `WORKSPACE_PI_STATE_LIMIT_BYTES` / `WORKSPACE_PI_INODE_LIMIT` | 200 万 / 2 GiB / 20 万 | 配额细项 |
| `WORKSPACE_NOFILE_LIMIT` / `WORKSPACE_START_TIMEOUT_MS` | `65536` / `60000` | |
| `WORKER_QUOTA_PROJECT_ID_MIN` | `1000000` | 本 Worker 的 XFS project ID 起点 |
| `WORKER_EGRESS_PROTECTED` | 空 | 本 Worker 额外的保护地址 |
| `WORKER_MODEL_GATEWAY_URL` / `WORKER_MODEL_RELAY_PORT` / `WORKER_MODEL_RELAY_MAX_BODY_BYTES` | 空 / `3101` / 32 MiB | 模型中继；URL 为空则不提供平台模型 |
| `WORKER_HEARTBEAT_INTERVAL_MS` / `WORKER_RECONNECT_INITIAL_MS` / `WORKER_RECONNECT_MAX_MS` | `10000` / `1000` / `30000` | |
| `WORKER_EGRESS_NFT_PATH` / `WORKER_XFS_QUOTA_PATH` / `WORKER_LSATTR_PATH` | `/usr/sbin/nft` 等 | 系统工具路径 |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | |
| ~~`RUNTIME_IMAGE`~~ / ~~`RUNTIME_VERSION`~~ | — | v1.0 已移除；出现即拒绝启动 |

## 3. nginx：`/etc/agent-runtime/nginx.env`

`AR_PUBLIC_LISTEN`（用户入口地址）、`AR_INTERNAL_LISTEN`（Worker 访问的地址）、`AR_PORTAL_HOST`、`AR_WORKSPACE_DOMAIN`、
`AR_CONTROL_PLANE_PORT`、`AR_GATEWAY_PORT`、`AR_LITELLM_PORT`。另有 `/etc/agent-runtime/nginx/worker-allow.conf`（每台 Worker 一行
`allow <地址>;`）。compose 的 loopback 端口在 `/etc/agent-runtime/.env`（`AR_POSTGRES_PORT`、`AR_LITELLM_PORT`）。

## 4. 运维命令

| 命令 | 主机 | 作用 |
|---|---|---|
| `agent-runtime-ctl version` | CP | 当前发布的 `release.json` |
| `agent-runtime-ctl db:status` / `db:migrate` | CP | migration 状态（退出码 3 = 数据库来自更新的版本，4 = 有待执行） / 执行迁移 |
| `agent-runtime-ctl user:create` | CP | 环境变量 `LOCAL_USER_EMAIL`、`LOCAL_USER_PASSWORD`、可选 `LOCAL_USER_USERNAME`、`LOCAL_USER_ROLE` |
| `agent-runtime-ctl auth:unlock login <x>` / `ip <x>` / `all` | CP | 解除登录锁定 |
| `agent-runtime-ctl worker:provision` / `rotate` / `configure-gateway` / `disable` / `enable` / `delete` | CP | 环境变量 `WORKER_ID`、`WORKER_GATEWAY_BASE_URL` |
| `agent-runtime-ctl --release <版本> <命令>` | CP | 用已安装但未激活的版本执行（升级时先迁移再激活） |
| `release.sh install <包>` / `activate <版本>` / `list` / `prune <版本>` | 全部 | 发布管理（`/opt/agent-runtime/current/deploy/scripts/`） |
| `agent-runtime-image load <归档>` / `verify <镜像>` | Worker | 加载与检查 Runtime 镜像，输出 `RUNTIME_IMAGES` 项 |
| `migrate-legacy-workspace <id>` | Worker（root） | v0.13 旧容器迁移 |
| `internal-ca.sh init` / `issue` / `show` | CP | 内部 CA |
| `init-secrets.sh`、`init-postgres.sh` | CP | 首次部署 |
| `audit-host.sh` / `audit-host.sh --containers-only` | 全部 | 只读安全审计 |
| `build-runtime-image.sh <tag>` | 构建主机（源码） | 构建并归档 Runtime 镜像 |

## 5. 文件与目录

| 路径 | 主机 | 内容 |
|---|---|---|
| `/opt/agent-runtime/releases/<版本>/`、`/opt/agent-runtime/current` | 全部 | 发布包、当前版本链接 |
| `/etc/agent-runtime/control-plane.env`、`control-plane.secrets.env` | CP | 配置、密钥 |
| `/etc/agent-runtime/{compose.yml,.env,nginx.env,postgres.env,litellm.env,metrics.token}` | CP | 第三方服务与密钥 |
| `/etc/agent-runtime/model-gateway/{config.yaml,catalog.json}` | CP | 模型网关配置与平台模型目录 |
| `/etc/agent-runtime/nginx/worker-allow.conf` | CP | 内部入口白名单 |
| `/etc/agent-runtime/tls/` | 全部 | 证书与私钥；`internal-ca.crt` 为内部根证书 |
| `/etc/agent-runtime/ca/` | 保管 CA 的主机 | 内部 CA 私钥（root 0700，离线备份） |
| `/var/lib/agent-runtime-postgres/` | CP | PostgreSQL 数据（备份） |
| `/etc/agent-runtime/worker.env` | Worker | Worker 配置与凭据 |
| `/etc/agent-runtime/egress-base.nft` | Worker | 开机加载的基础出口规则 |
| `/var/lib/agent-runtime/` | Worker | 受管根：`workspaces/<id>/{workspace,home,tmp,pi,metadata}`、`egress/ruleset.json`（备份） |

## 6. 端口

| 主机 | 端口 | 监听 | 可达方 |
|---|---|---|---|
| CP | 443（80 跳转） | nginx | 用户网络 |
| CP | 8443（Worker 控制通道）、8444（模型推理） | nginx | 仅 Worker |
| CP | 3000、3001、9464、4400、5432 | 127.0.0.1 | 本机 |
| Worker | 3100 | Worker Gateway（TLS） | 仅 Control Plane |
| Worker | 3101 | 模型中继 | 仅本机 Workspace 网桥 |
| Worker | 动态 | pi-web | 127.0.0.1 |

## 7. systemd unit

| unit | 主机 | 说明 |
|---|---|---|
| `agent-runtime-platform` | CP | `docker compose -p ar-platform up -d`（开机早于 Control Plane） |
| `agent-runtime-control-plane` | CP | 用户 `agent-runtime-cp`，无 capability，`ProtectSystem=strict` |
| `agent-runtime-egress` | Worker | 开机早于 Docker 加载出口规则 |
| `agent-runtime-worker` | Worker | 用户 `agent-runtime`（docker 组），capability：`NET_ADMIN SYS_ADMIN CHOWN FOWNER DAC_OVERRIDE` |
