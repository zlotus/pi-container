# Containerized Agent Runtime Platform

面向企业私有环境的多用户容器化 Agent Workspace 原型。平台复用
[pi-web](https://github.com/agegr/pi-web) 与 Pi Coding Agent，自身只负责认证、
Workspace、Worker、Docker 生命周期、调度和安全代理。

当前仓库已完成 **Phase 1：Multi-user Portal**：包含 PostgreSQL migration、本地账户、
服务端 session、Workspace CRUD、ownership 隔离和 React Portal。Worker、Docker
Workspace Runtime 与最终用户 Gateway 尚未实现；不要把 `CREATED` Workspace 当作已经
运行的 Agent 环境。

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

密码至少 12 个字符，以 scrypt 和随机 salt 保存。`LOCAL_USER_USERNAME` 可省略。

## Run the Phase 1 portal

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

Phase 1 API：

```text
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/me
GET    /api/workspaces
POST   /api/workspaces
GET    /api/workspaces/:id
DELETE /api/workspaces/:id
```

当前只允许删除尚未分配 Worker 且处于 `CREATED` 的 Workspace。未来已分配 Workspace
必须等待 Worker 明确确认底层 Container 与持久目录均已删除，Control Plane 不会提前
删除 metadata。

架构与安全边界以 [AGENTS.md](AGENTS.md) 为长期规则，以 [specs.md](specs.md)
为产品范围和分阶段验收规范。当前状态见 [docs/progress.md](docs/progress.md)。
