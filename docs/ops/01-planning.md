# 01 规划：架构、主机、端口与发布物

部署前读。决定拓扑、主机、名字与证书后，再按 02～05 部署。设计依据：`specs.md` 第 64 节 Phase 19（19.3–19.8）。

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
| 磁盘 | PostgreSQL 数据目录 `/var/lib/agent-runtime-postgres` | 受管根 `/var/lib/agent-runtime`：**独立 XFS，`prjquota`**（[storage-runbook.md](../storage-runbook.md)） |
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
| 跨主机链路 | 明文 `ws://`、`http://`（受保护网络） | 全部 TLS（`02-tls-and-dns.md`） |
| 配置与密钥 | 仓库 `.env`、`.data/*.env` | `/etc/agent-runtime/*.env`，权限 0640/0600，密钥单独文件 |
| 日志 | `LOG_FORMAT=pretty` 可用 | JSON 到 journald；`pretty` 不可用（发布包不含开发依赖） |
| Runtime 镜像 | 本地构建 | 一台主机构建一次，归档分发，按 digest pin |
| Worker 权限 | `tools/dev/run-worker-privileged.sh` | unit 中的 `AmbientCapabilities` |

## 4. 发布物

- **平台发布包**：`agent-runtime-<版本>-linux-<arch>.tar.gz` 与 `SHA256SUMS-<版本>-<arch>`，来自 GitHub Release；或在仓库 checkout
  中 `pnpm release:build`（输出到 `dist/release/`）。内容：`bin/node` 与运维命令、`app/`（Control Plane、Worker、迁移）、`portal/`、
  `deploy/`（systemd、compose、nginx、env 示例、脚本）、`release.json`。
- **Runtime 镜像归档**：`agent-runtime_<tag>_linux-<arch>.tar.zst` 与 `.sha256`，在构建主机上由
  `deploy/production/scripts/build-runtime-image.sh <tag>` 生成（[lifecycle-runbook.md](../lifecycle-runbook.md) 1.2）。

把它们拷到每台主机（下文假设在 `~/release/`）。

## 5. 使用企业已有的反向代理

不用模板中的 nginx 时，代理必须满足（[nginx 模板](../deploy/production/nginx/templates/agent-runtime.conf.template) 即参考实现）：

1. Portal：静态目录为当前发布的 `portal/`；不存在的路径回落到 `/index.html`（`/assets/` 下不存在的返回 404）；`index.html` 不缓存、
   `/assets/` 长缓存；`/api/`、`/auth/` 转发到 Control Plane；**`/api/workers/` 不对用户开放**。
2. `X-Forwarded-For` **覆盖**为客户端地址，并把代理地址写进 `AUTH_TRUSTED_PROXIES`。
3. Workspace（`*.agent.<域>`）：**原样转发 `Host`**；支持 WebSocket upgrade；关闭响应与请求缓冲；不限制请求体大小；读/写超时
   ≥ 60 秒（pi-web 每 30 秒发送 SSE 心跳；模板用 600 秒）；不添加或改写安全响应头。
4. 访问日志不记录 query string、Cookie、Authorization（OAuth/OIDC callback 的 code 在 query 中）；错误日志同样会记录请求行。
5. 内部入口只对 Worker 地址开放：控制通道只有 `/api/workers/connect`（WebSocket）；模型网关只有 `POST /v1/chat/completions`、
   `/v1/responses`、`/v1/messages`、`/v1/messages/count_tokens`。
