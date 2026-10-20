# 生产部署

`specs.md` 第 64 节 Phase 19（19.3–19.8）。本文从一台装好操作系统的主机开始，部署可长期运行的平台：一台 Control Plane 主机
（Portal、Control Plane、PostgreSQL、模型网关 LiteLLM、nginx）与一台或多台 Worker 主机。单机部署（两种角色在同一主机）按同样
步骤做两遍，差异见第 6 节。证书与 DNS 见 [tls-and-dns.md](tls-and-dns.md)；升级与回滚见 [upgrade-runbook.md](upgrade-runbook.md)；
备份见 [backup-runbook.md](backup-runbook.md)。

所有命令以有 sudo 权限的管理员执行。示例名字：`portal.ar.internal`、`*.agent.ar.internal`；Control Plane 用户入口地址
`192.168.1.124`、内部入口地址 `100.112.169.46`；Worker `worker-c`，地址 `100.115.94.58`。替换为你的环境。

## 1. 架构与端口

```text
用户 ──443──▶ Control Plane 主机：nginx ─▶ Control Plane（127.0.0.1）─▶ PostgreSQL / LiteLLM（127.0.0.1）
Worker ─8443/8444─▶ 同一 nginx 的内部入口
Control Plane ─https:3100─▶ Worker 主机：Worker Gateway ─▶ Workspace 容器（pi-web 只在 127.0.0.1）
```

| 主机 | 端口 | 对谁开放 |
|---|---|---|
| Control Plane | 443（80 只跳转） | 用户网络 |
| Control Plane | 8443（Worker 控制通道）、8444（模型推理路径） | 仅 Worker 主机 |
| Control Plane | 3000、3001、9464、4400、5432 | 只在 127.0.0.1 |
| Worker | 3100（Worker Gateway，TLS） | 仅 Control Plane 主机 |
| Worker | 3101（模型中继） | 仅本机 Workspace 网桥（平台出口规则） |

**主机防火墙**（平台不管理，示例为 ufw；Docker 发布到 127.0.0.1 的端口不受影响）：

```bash
# Control Plane 主机
sudo ufw allow 443/tcp && sudo ufw allow 80/tcp
sudo ufw allow from 100.115.94.58 to any port 8443,8444 proto tcp     # 每台 Worker 一条
# Worker 主机
sudo ufw allow from 100.112.169.46 to any port 3100 proto tcp         # Control Plane 主机
```

先放行你的 SSH 来源再启用防火墙（`sudo ufw allow from <管理网段> to any port 22`），否则会把自己锁在外面。

## 2. 主机要求

| 项 | Control Plane 主机 | Worker 主机 |
|---|---|---|
| 架构 | linux/arm64（主要验证）；linux/amd64 仅有 CI 证据 | 同左 |
| 系统 | Ubuntu 22.04 及以后（已验证 26.04） | 同左，且内核必须有 `CONFIG_XFS_FS`、`CONFIG_NFT_FIB_IPV4`（缺任一项 Worker 拒绝启动 Workspace；例如 Jetson 的 tegra 内核没有） |
| Docker | Engine 24+、Compose v2 | Engine 24+；不得开放 TCP API |
| 软件包 | `openssl`、`curl` | `nftables`、`xfsprogs`、`zstd`、`util-linux`（setpriv） |
| 磁盘 | PostgreSQL 数据目录 `/var/lib/agent-runtime-postgres` | 受管根 `/var/lib/agent-runtime`：**独立 XFS，`prjquota`**（[storage-runbook.md](storage-runbook.md)） |
| 账户 | — | UID/GID 1000 是 Workspace 的运行身份，不应属于有登录或 sudo 权限的账户（`specs.md` 19.15 Q12；`audit-host.sh` 会告警） |

```bash
uname -m; cat /etc/os-release | head -2; docker version --format '{{.Server.Version}}'
zcat /proc/config.gz 2>/dev/null | grep -E '^CONFIG_(XFS_FS|NFT_FIB_IPV4)=' || grep -E '^CONFIG_(XFS_FS|NFT_FIB_IPV4)=' /boot/config-$(uname -r)
```

## 3. 开发形态与生产形态的区别

| 项 | 开发（仓库 checkout） | 生产（本文） |
|---|---|---|
| 进程 | `tsx watch`（`pnpm dev:*`），以开发者账户运行 | 发布包 + systemd，专用系统用户（`agent-runtime-cp`、`agent-runtime`） |
| Node | 开发者自己的 Node | 发布包内 pin 的 Node 24.22.0 |
| 数据库迁移 | 启动时自动执行（`DATABASE_MIGRATE_ON_START` 默认 `true`） | `DATABASE_MIGRATE_ON_START=false`，备份后 `agent-runtime-ctl db:migrate` |
| 入口 | Vite dev server（5173）、HTTP、`nip.io` | nginx、HTTPS、企业 DNS 或 dnsmasq |
| Cookie | `SESSION_COOKIE_SECURE=false` | `true`（`__Host-` Cookie） |
| 跨主机链路 | 明文 `ws://`、`http://`（受保护网络） | 全部 TLS（`tls-and-dns.md`） |
| 配置与密钥 | 仓库 `.env`、`.data/*.env` | `/etc/agent-runtime/*.env`，权限 0640/0600，密钥单独文件 |
| 日志 | `LOG_FORMAT=pretty` 可用 | JSON 到 journald；`pretty` 不可用（发布包不含开发依赖） |
| Runtime 镜像 | 本地构建 | 一台主机构建一次，归档分发，按 digest pin |
| Worker 权限 | `tools/dev/run-worker-privileged.sh` | unit 中的 `AmbientCapabilities` |

## 4. 发布物

- **平台发布包**：`agent-runtime-<版本>-linux-<arch>.tar.gz` 与 `SHA256SUMS-<版本>-<arch>`，来自 GitHub Release；或在仓库 checkout
  中 `pnpm release:build`（输出到 `dist/release/`）。内容：`bin/node` 与运维命令、`app/`（Control Plane、Worker、迁移）、`portal/`、
  `deploy/`（systemd、compose、nginx、env 示例、脚本）、`release.json`。
- **Runtime 镜像归档**：`agent-runtime_<tag>_linux-<arch>.tar.zst` 与 `.sha256`，在构建主机上由
  `deploy/production/scripts/build-runtime-image.sh <tag>` 生成（[lifecycle-runbook.md](lifecycle-runbook.md) 1.2）。

把它们拷到每台主机（下文假设在 `~/release/`）。

## 5. Control Plane 主机

### 5.1 用户与发布包

```bash
V=<版本>                        # 例如 1.0.0
cd ~/release
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin agent-runtime-cp
# release.sh 在发布包内；先单独取出它
tar -xzf agent-runtime-$V-linux-arm64.tar.gz agent-runtime-$V/deploy/scripts/release.sh -O > /tmp/release.sh && chmod +x /tmp/release.sh
sudo /tmp/release.sh install ~/release/agent-runtime-$V-linux-arm64.tar.gz     # 校验 SHA256SUMS 后解包
sudo /tmp/release.sh activate $V
sudo ln -sfn /opt/agent-runtime/current/bin/agent-runtime-ctl /usr/local/bin/agent-runtime-ctl
C=/opt/agent-runtime/current/deploy
```

### 5.2 配置文件

```bash
sudo install -d -m 0755 /etc/agent-runtime /etc/agent-runtime/model-gateway /etc/agent-runtime/nginx /etc/agent-runtime/tls
sudo install -m 0644 $C/compose.yml /etc/agent-runtime/compose.yml
sudo install -m 0644 $C/env/compose.env.example /etc/agent-runtime/.env              # PostgreSQL / LiteLLM 的 loopback 端口
sudo install -m 0644 $C/env/nginx.env.example /etc/agent-runtime/nginx.env           # 编辑：地址与名字
sudo install -m 0640 -o root -g agent-runtime-cp $C/env/control-plane.env.example /etc/agent-runtime/control-plane.env   # 编辑
sudo install -m 0644 $C/model-gateway/config.yaml /etc/agent-runtime/model-gateway/config.yaml
sudo install -m 0644 $C/model-gateway/catalog.example.json /etc/agent-runtime/model-gateway/catalog.json
sudo install -m 0644 $C/nginx/worker-allow.conf.example /etc/agent-runtime/nginx/worker-allow.conf    # 编辑：每台 Worker 一行 allow
```

需要编辑的项：

- `nginx.env`：`AR_PUBLIC_LISTEN`（用户访问的地址）、`AR_INTERNAL_LISTEN`（Worker 访问的地址，可与前者相同）、`AR_PORTAL_HOST`、
  `AR_WORKSPACE_DOMAIN`、三个端口（与 `control-plane.env` 的 `PORT`、`GATEWAY_PORT` 及 `.env` 的 `AR_LITELLM_PORT` 一致）。
- `control-plane.env`：`PORTAL_ORIGIN`、`WORKSPACE_BASE_URL`、`PLATFORM_EGRESS_PROTECTED`（本主机在各网络中的地址，以及**每台
  Worker 的 Gateway 地址**——Worker 不在 RFC1918 网段时（如 Tailscale/CGNAT 或公网地址）必须列出，否则一台 Worker 上的 Workspace 能连到
  另一台 Worker 的 Gateway 端口；新增 Worker 后改这里并重启 Control Plane）、按需的
  `IDLE_STOP_AFTER_HOURS`、`MODEL_GATEWAY_USER_BUDGET_USD`、OIDC/OAuth2 设置（[authentication-runbook.md](authentication-runbook.md)）。
  端口与 `.env` 不同时同时改 `MODEL_GATEWAY_ADMIN_URL`。
- 格式（systemd `EnvironmentFile` 与 Node `--env-file` 共同支持的写法）：每行 `KEY=value`，**不加引号、不加行尾注释**，JSON 原样写在一行。

### 5.3 密钥

```bash
sudo $C/scripts/init-secrets.sh       # .env 中改了 PostgreSQL 端口时：sudo AR_POSTGRES_PORT=<端口> $C/scripts/init-secrets.sh
sudo nano /etc/agent-runtime/litellm.env   # 填上游模型服务商的 key（DEEPSEEK_API_KEY、XIAOMI_API_KEY 等，名字见 config.yaml）
```

生成 `postgres.env`、`control-plane.secrets.env`（数据库口令、`SESSION_SECRET`、网关 master key、Worker Gateway token 表）、
`litellm.env`、`metrics.token`；已存在的文件不覆盖，不打印任何密钥。OIDC/OAuth2 的 client secret 写进 `control-plane.secrets.env`。

### 5.4 证书

按 [tls-and-dns.md](tls-and-dns.md) 第 3 节签发 `public`、`internal` 与每台 Worker 的 Gateway 证书，并放置 `internal-ca.crt`。

### 5.5 第三方服务、数据库与 Control Plane

```bash
sudo docker compose -p ar-platform -f /etc/agent-runtime/compose.yml up -d postgres
sudo $C/scripts/init-postgres.sh                      # agent_runtime 与 litellm 两个角色和库
sudo docker compose -p ar-platform -f /etc/agent-runtime/compose.yml up -d     # LiteLLM、nginx
sudo agent-runtime-ctl db:migrate && sudo agent-runtime-ctl db:status
sudo install -m 0644 $C/systemd/agent-runtime-platform.service $C/systemd/agent-runtime-control-plane.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-runtime-platform.service agent-runtime-control-plane.service
journalctl -u agent-runtime-control-plane -n 20 -o cat       # "control plane starting" 带版本，无 error
```

### 5.6 管理员

```bash
sudo LOCAL_USER_EMAIL=admin@example.internal LOCAL_USER_USERNAME=admin LOCAL_USER_ROLE=admin \
  LOCAL_USER_PASSWORD='<至少 12 位>' agent-runtime-ctl user:create
```

为避免口令进入 shell 历史，可先 `read -rs LOCAL_USER_PASSWORD && export LOCAL_USER_PASSWORD`。

### 5.7 验证

```bash
curl -s http://127.0.0.1:3000/ready                                    # {"status":"ready"}
curl -s -o /dev/null -w '%{http_code}\n' --cacert /etc/agent-runtime/tls/internal-ca.crt \
  --resolve portal.ar.internal:443:192.168.1.124 https://portal.ar.internal/admin/workers   # 200（SPA）
curl -s -o /dev/null -w '%{http_code}\n' --cacert /etc/agent-runtime/tls/internal-ca.crt \
  --resolve portal.ar.internal:443:192.168.1.124 https://portal.ar.internal/api/workers/connect   # 404
sudo $C/scripts/audit-host.sh
```

浏览器打开 `https://portal.ar.internal`（客户端需信任根证书并能解析名字），以管理员登录。

## 6. Worker 主机

### 6.1 前置

```bash
sudo apt-get install -y nftables xfsprogs zstd
sudo systemctl disable --now nftables.service 2>/dev/null || true   # 发行版的 nftables.service 会 flush ruleset，不要启用
```

受管根：按 [storage-runbook.md](storage-runbook.md) 第 3 节（独立磁盘/LV）或第 4 节（loop 镜像）准备挂载在 `/var/lib/agent-runtime`
的 XFS（`prjquota`，挂载早于 Docker）。确认：`findmnt -T /var/lib/agent-runtime` 为 `xfs` 且选项含 `prjquota`。

### 6.2 用户、发布包与出口规则

```bash
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin agent-runtime
sudo usermod -aG docker agent-runtime
sudo chown agent-runtime:agent-runtime /var/lib/agent-runtime && sudo chmod 0755 /var/lib/agent-runtime
# 发布包（同 5.1 的 release.sh 两步）
sudo /tmp/release.sh install ~/release/agent-runtime-$V-linux-arm64.tar.gz && sudo /tmp/release.sh activate $V
for b in agent-runtime-image migrate-legacy-workspace; do sudo ln -sfn /opt/agent-runtime/current/bin/$b /usr/local/bin/$b; done
C=/opt/agent-runtime/current/deploy
sudo install -D -m 0644 $C/egress/agent-runtime-egress.nft /etc/agent-runtime/egress-base.nft
sudo install -m 0644 $C/egress/agent-runtime-egress.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agent-runtime-egress.service
sudo nft list table inet agent_runtime | head -3       # 平台表；只过滤 Workspace 网桥（arw-*），不影响主机自身流量
```

### 6.3 Runtime 镜像

```bash
sudo agent-runtime-image load ~/release/agent-runtime_<tag>_linux-arm64.tar.zst    # 校验 sha256，输出 RUNTIME_IMAGES 项
```

### 6.4 注册 Worker（在 Control Plane 主机上）

```bash
# 输出含两个 token，只出现一次：写进 root-only 文件，不要贴进聊天或工单
sudo bash -c 'umask 077; WORKER_ID=worker-c WORKER_GATEWAY_BASE_URL=https://100.115.94.58:3100 \
  agent-runtime-ctl worker:provision > /root/worker-c.provision'
# Control Plane 用 WORKER_GATEWAY_TOKEN 访问该 Worker：加入 control-plane.secrets.env 的
#   WORKER_GATEWAY_TOKENS_JSON={"worker-c":"<WORKER_GATEWAY_TOKEN>"}  （多台 Worker 写在同一个 JSON 中）
sudo nano /etc/agent-runtime/control-plane.secrets.env
sudo systemctl restart agent-runtime-control-plane
```

把 `/root/worker-c.provision` 与该 Worker 的 Gateway 证书、私钥、根证书经 root 通道拷到 Worker 主机，例如：

```bash
sudo tar -C / -cf - root/worker-c.provision etc/agent-runtime/ca/ca.crt \
  etc/agent-runtime/ca/issued/worker-c-gateway.crt etc/agent-runtime/ca/issued/worker-c-gateway.key \
  | ssh admin@100.115.94.58 'sudo bash -c "umask 077; mkdir -p /root/incoming && tar -C /root/incoming -xf -"'
```

### 6.5 Worker 配置与证书（在 Worker 主机上）

```bash
I=/root/incoming
sudo install -d -m 0755 /etc/agent-runtime/tls
sudo install -m 0644 $I/etc/agent-runtime/ca/ca.crt /etc/agent-runtime/tls/internal-ca.crt
sudo install -m 0644 $I/etc/agent-runtime/ca/issued/worker-c-gateway.crt /etc/agent-runtime/tls/worker-gateway.crt
sudo install -m 0640 -o root -g agent-runtime $I/etc/agent-runtime/ca/issued/worker-c-gateway.key /etc/agent-runtime/tls/worker-gateway.key
sudo install -m 0640 -o root -g agent-runtime $C/env/worker.env.example /etc/agent-runtime/worker.env
sudo nano /etc/agent-runtime/worker.env   # CONTROL_PLANE_URL、WORKER_ID、两个 token（来自 $I/root/worker-c.provision）、
                                          # WORKER_GATEWAY_HOST、WORKSPACE_BASE_URL、RUNTIME_IMAGES、WORKER_MODEL_GATEWAY_URL
sudo shred -u $I/root/worker-c.provision   # 写入后删除
sudo -u agent-runtime /opt/agent-runtime/current/bin/node --env-file=/etc/agent-runtime/worker.env \
  /opt/agent-runtime/current/app/worker/server.mjs --check-config
```

### 6.6 启动

```bash
sudo install -m 0644 $C/systemd/agent-runtime-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agent-runtime-worker
journalctl -u agent-runtime-worker -n 30 -o cat      # control channel connected；无 error
sudo $C/scripts/audit-host.sh
```

Portal → Worker：该 Worker `在线`、版本与平台一致、出口控制与磁盘配额“已生效”、镜像 capability 全部为真。之后在 Portal 新建
Workspace 并打开，确认 Prompt、Terminal、Files 正常。

### 6.7 单机部署

Control Plane 与 Worker 在同一主机时：两种角色各自的用户、配置与 unit 都按上文安装；`CONTROL_PLANE_URL` 与
`WORKER_MODEL_GATEWAY_URL` 指向本机的内部入口（证书 SAN 包含该地址），`WORKER_GATEWAY_HOST=127.0.0.1`、
`WORKER_GATEWAY_BASE_URL=https://127.0.0.1:3100`（Gateway 证书签 `IP:127.0.0.1`）。

## 7. 重启后的顺序

开机时依次：受管根挂载 → `agent-runtime-egress`（早于 Docker）→ Docker（重新拉起原本运行中的 Workspace 容器）→
`agent-runtime-platform`（PostgreSQL、LiteLLM、nginx）→ `agent-runtime-control-plane`；Worker 主机上 `agent-runtime-worker` 在 Docker 与
出口规则之后启动并 reconcile。运行中的 Workspace 回到 `RUNNING`，停止的保持停止。

## 8. 使用企业已有的反向代理

不用模板中的 nginx 时，代理必须满足（[nginx 模板](../deploy/production/nginx/templates/agent-runtime.conf.template) 即参考实现）：

1. Portal：静态目录为当前发布的 `portal/`；不存在的路径回落到 `/index.html`（`/assets/` 下不存在的返回 404）；`index.html` 不缓存、
   `/assets/` 长缓存；`/api/`、`/auth/` 转发到 Control Plane；**`/api/workers/` 不对用户开放**。
2. `X-Forwarded-For` **覆盖**为客户端地址，并把代理地址写进 `AUTH_TRUSTED_PROXIES`。
3. Workspace（`*.agent.<域>`）：**原样转发 `Host`**；支持 WebSocket upgrade；关闭响应与请求缓冲；不限制请求体大小；读/写超时
   ≥ 60 秒（pi-web 每 30 秒发送 SSE 心跳；模板用 600 秒）；不添加或改写安全响应头。
4. 访问日志不记录 query string、Cookie、Authorization（OAuth/OIDC callback 的 code 在 query 中）；错误日志同样会记录请求行。
5. 内部入口只对 Worker 地址开放：控制通道只有 `/api/workers/connect`（WebSocket）；模型网关只有 `POST /v1/chat/completions`、
   `/v1/responses`、`/v1/messages`、`/v1/messages/count_tokens`。

## 9. 卸载与清理

删除一台主机上的平台（不可恢复；先按 [backup-runbook.md](backup-runbook.md) 备份需要的数据）：

```bash
# Worker 主机
sudo systemctl disable --now agent-runtime-worker agent-runtime-egress
docker rm -f $(docker ps -aq --filter label=app=agent-runtime-platform)
docker network rm $(docker network ls -q --filter label=app=agent-runtime-platform)
sudo nft delete table inet agent_runtime
sudo find /var/lib/agent-runtime -mindepth 1 -maxdepth 1 -exec rm -rf {} +      # Workspace 数据
# Control Plane 主机
sudo systemctl disable --now agent-runtime-control-plane agent-runtime-platform
sudo docker compose -p ar-platform -f /etc/agent-runtime/compose.yml down
sudo rm -rf /var/lib/agent-runtime-postgres                                   # 平台与网关数据库
# 两者
sudo rm -f /etc/systemd/system/agent-runtime-*.service && sudo systemctl daemon-reload
sudo rm -rf /opt/agent-runtime /etc/agent-runtime
sudo userdel agent-runtime 2>/dev/null; sudo userdel agent-runtime-cp 2>/dev/null
```

在 Control Plane 中删除一台已清理的 Worker：`WORKER_ID=<id> sudo -E agent-runtime-ctl worker:disable`，其 Workspace 删除后
`worker:delete`（[lifecycle-runbook.md](lifecycle-runbook.md)）。
