# 03 部署 Control Plane 主机

Portal、Control Plane、PostgreSQL、模型网关（LiteLLM）与 nginx。前置：01 规划、02 证书与名字。

所有命令以有 sudo 权限的管理员执行。示例名字：`portal.ar.internal`、`*.agent.ar.internal`；Control Plane 用户入口地址
`192.168.1.124`、内部入口地址 `100.112.169.46`；Worker `worker-c`，地址 `100.115.94.58`。替换为你的环境。

## 1. Control Plane 主机

### 1.1 用户与发布包

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

### 1.2 配置文件

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
  另一台 Worker 的 Gateway 端口；新增 Worker 后改这里并重启 Control Plane）、`IDLE_STOP_AFTER_HOURS`（空闲回收，模板默认 8 小时，留空则关闭）、按需的、`MODEL_GATEWAY_USER_BUDGET_USD`、OIDC/OAuth2 设置（[authentication-runbook.md](../authentication-runbook.md)）。
  端口与 `.env` 不同时同时改 `MODEL_GATEWAY_ADMIN_URL`。
- 格式（systemd `EnvironmentFile` 与 Node `--env-file` 共同支持的写法）：每行 `KEY=value`，**不加引号、不加行尾注释**，JSON 原样写在一行。

### 1.3 密钥

```bash
sudo $C/scripts/init-secrets.sh       # .env 中改了 PostgreSQL 端口时：sudo AR_POSTGRES_PORT=<端口> $C/scripts/init-secrets.sh
sudo nano /etc/agent-runtime/litellm.env   # 填上游模型服务商的 key（DEEPSEEK_API_KEY、XIAOMI_API_KEY 等，名字见 config.yaml）
```

生成 `postgres.env`、`control-plane.secrets.env`（数据库口令、`SESSION_SECRET`、网关 master key、Worker Gateway token 表）、
`litellm.env`、`metrics.token`；已存在的文件不覆盖，不打印任何密钥。OIDC/OAuth2 的 client secret 写进 `control-plane.secrets.env`。

### 1.4 证书

按 [02 TLS 与 DNS](02-tls-and-dns.md) 第 3 节签发 `public`、`internal` 与每台 Worker 的 Gateway 证书，并放置 `internal-ca.crt`。

### 1.5 第三方服务、数据库与 Control Plane

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

### 1.6 管理员

```bash
sudo LOCAL_USER_EMAIL=admin@example.internal LOCAL_USER_USERNAME=admin LOCAL_USER_ROLE=admin \
  LOCAL_USER_PASSWORD='<至少 12 位>' agent-runtime-ctl user:create
```

为避免口令进入 shell 历史，可先 `read -rs LOCAL_USER_PASSWORD && export LOCAL_USER_PASSWORD`。

### 1.7 验证

```bash
curl -s http://127.0.0.1:3000/ready                                    # {"status":"ready"}
curl -s -o /dev/null -w '%{http_code}\n' --cacert /etc/agent-runtime/tls/internal-ca.crt \
  --resolve portal.ar.internal:443:192.168.1.124 https://portal.ar.internal/admin/workers   # 200（SPA）
curl -s -o /dev/null -w '%{http_code}\n' --cacert /etc/agent-runtime/tls/internal-ca.crt \
  --resolve portal.ar.internal:443:192.168.1.124 https://portal.ar.internal/api/workers/connect   # 404
sudo $C/scripts/audit-host.sh
```

浏览器打开 `https://portal.ar.internal`（客户端需信任根证书并能解析名字），以管理员登录。
