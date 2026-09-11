# Containerized Agent Runtime Platform

面向企业私有环境的多用户容器化 Agent Workspace 原型。平台复用
[pi-web](https://github.com/agegr/pi-web) 与 Pi Coding Agent，自身只负责认证、
Workspace、Worker、Docker 生命周期、调度和安全代理。

当前仓库已实现 **Phase 3：Minimal Runtime + pi-web**：在 Phase 2 control channel
之上增加 pinned Runtime Image、受约束的本机 Docker 生命周期、Workspace/Pi state
持久化，以及仅在恰好一个 eligible Worker 时进行的最小自动绑定。最终用户 Gateway
仍未实现；Portal 的“打开”入口会保持禁用直到 Phase 4。

## Prerequisites

- Node.js 22.20.0 或更高版本
- pnpm 11.24.0
- Docker Engine 与 Docker Compose

## Bootstrap

```bash
pnpm install
cp deploy/.env.example .env
# 将 SESSION_SECRET 替换为：openssl rand -hex 32
docker compose --env-file .env -f deploy/compose.dev.yml up -d postgres
docker build --tag agent-runtime:phase3-minimal runtime
set -a
. ./.env
set +a
pnpm db:migrate
pnpm typecheck
pnpm test
pnpm lint
```

## Create local users

本地账户不开放公共注册。为验收创建两个账户时，分别执行以下命令，并为每次命令设置不同
的邮箱、用户名和密码：

```bash
export LOCAL_USER_EMAIL=user-a@example.internal
export LOCAL_USER_USERNAME=user-a
export LOCAL_USER_ROLE=user
read -rsp "Password: " LOCAL_USER_PASSWORD
export LOCAL_USER_PASSWORD
pnpm user:create
unset LOCAL_USER_PASSWORD
```

密码至少 12 个字符，以 scrypt 和随机 salt 保存。`LOCAL_USER_USERNAME` 可省略。查看
Worker 管理页的账户应将 `LOCAL_USER_ROLE` 设置为 `admin`。

## Run the Portal and Control Plane

启动 Control Plane：

```bash
set -a
. ./.env
set +a
pnpm dev:control-plane
```

另一个终端启动 Portal：

```bash
pnpm dev:web
```

打开 `http://127.0.0.1:5173`。Vite 将 `/api` 代理到 `127.0.0.1:3000`；该地址必须与
`PORTAL_ORIGIN` 完全匹配。默认只监听 loopback。`GET /health` 是进程存活检查，
`GET /ready` 会验证 PostgreSQL 连接。

本地 HTTP 开发环境显式设置 `SESSION_COOKIE_SECURE=false`，使用 host-only
`platform-session` Cookie。HTTPS 部署必须设置 `SESSION_COOKIE_SECURE=true`，此时平台
使用带 `Secure`、`HttpOnly`、`SameSite=Lax` 的 `__Host-platform-session` Cookie。
所有修改状态的 API 同时校验配置的 Origin 和 session-bound CSRF token。

## Provision and run Workers

Worker 不会自行注册身份。管理员使用 Control Plane 数据库预注册每个 Worker；命令只输出一次
原始 token，数据库只保存 hash：

```bash
export WORKER_ID=worker-a
pnpm worker:provision
# 安全保存输出的 WORKER_TOKEN，然后为 worker-b 重复一次
```

Worker 默认将 Workspace 持久数据写入 `/var/lib/agent-runtime`。首次在一台宿主机运行 Worker
前，需要由管理员创建该目录并将其交给运行 Worker 的系统用户；Worker 本身不应以 root 身份运行：

```bash
sudo install -d \
  -o "$(id -u)" \
  -g "$(id -g)" \
  -m 0700 \
  /var/lib/agent-runtime
```

复制 `deploy/worker.env.example` 到已被 `.gitignore` 排除的 `.data/`，为每个 Worker
保留各自的私有环境文件，填入对应 ID/token 后启动；不要提交这些文件：

```bash
mkdir -p .data
cp deploy/worker.env.example .data/worker-a.env
set -a
. ./.data/worker-a.env
set +a
pnpm dev:worker
```

同一 credential 不能在 `worker.hello` 中声明另一个 Worker ID。默认每 10 秒 heartbeat，
35 秒未收到服务端认可的 hello/heartbeat 后 Admin 列表显示 `OFFLINE`。轮换凭证使用：

```bash
export WORKER_ID=worker-a
pnpm worker:rotate
```

轮换会立即使旧 token 无法重连，并在旧连接的下一条消息或 heartbeat 时关闭它。生产网络
应使用 `wss://`；示例中的 `ws://127.0.0.1` 仅用于 loopback 开发。

Platform API：

```text
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/me
GET    /api/workspaces
POST   /api/workspaces
GET    /api/workspaces/:id
DELETE /api/workspaces/:id
POST   /api/workspaces/:id/start
POST   /api/workspaces/:id/stop
GET    /api/admin/workers
WS     /api/workers/connect
```

首次启动仅在恰好一个在线、enabled、容量未满且 Runtime/架构/capability 兼容的 Worker
存在时自动绑定；零个会返回 unavailable，多个会要求管理员预先固定 assignment，不做
Phase 5 的评分或随机选择。已分配 Workspace 的删除必须等待 Worker 明确确认 managed
Container、独立 network 与持久目录均已删除，Control Plane 才删除 metadata。

Phase 3 人工集成时，可在 Worker 宿主机用下面的命令查看仅绑定 loopback 的临时端口：

```bash
docker port agent-runtime-<workspace-uuid> 30141/tcp
```

该地址只用于本机开发/验收，不是最终用户入口，不应暴露到 LAN。Phase 4 才会实现经过
平台认证与 ownership 检查的 HTTP/WebSocket Gateway。

架构与安全边界以 [AGENTS.md](AGENTS.md) 为长期规则，以 [specs.md](specs.md)
为产品范围和分阶段验收规范。当前状态见 [docs/progress.md](docs/progress.md)。
