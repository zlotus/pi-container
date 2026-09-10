# Containerized Agent Runtime Platform

面向企业私有环境的多用户容器化 Agent Workspace 原型。平台复用
[pi-web](https://github.com/agegr/pi-web) 与 Pi Coding Agent，自身只负责认证、
Workspace、Worker、Docker 生命周期、调度和安全代理。

当前仓库处于 **Phase 0：Repository Bootstrap**。尚未实现用户系统、Docker
Workspace Runtime 或最终用户 Gateway；不要把当前健康检查服务当作完整原型。

## Prerequisites

- Node.js 22.20.0 或更高版本
- pnpm 11.24.0
- Docker Engine 与 Docker Compose

## Bootstrap

```bash
pnpm install
cp deploy/.env.example .env
docker compose --env-file .env -f deploy/compose.dev.yml up -d postgres
pnpm typecheck
pnpm test
pnpm lint
```

启动本机 Control Plane 健康检查服务：

```bash
set -a
. ./.env
set +a
pnpm dev:control-plane
```

默认只监听 `127.0.0.1:3000`。`GET /health` 是进程存活检查，`GET /ready`
会验证 PostgreSQL 连接。

架构与安全边界以 [AGENTS.md](AGENTS.md) 为长期规则，以 [specs.md](specs.md)
为产品范围和分阶段验收规范。当前状态见 [docs/progress.md](docs/progress.md)。
