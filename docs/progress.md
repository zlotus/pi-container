# Project Progress

Last reviewed: 2026-09-10

## Current Milestone

Phase 0 已完成：仓库可以安装、lint、typecheck、测试并连接开发 PostgreSQL。

## Current Baseline

- 根级 TypeScript strict、ESLint、Vitest 与 pnpm workspace 配置。
- `packages/protocol` 提供 version 1 Worker hello/heartbeat、Workspace 命令、响应与事件的 Zod schema。
- `packages/database` 提供受校验的 PostgreSQL client 与 readiness probe。
- `apps/control-plane` 提供 `/health` 和 PostgreSQL-aware `/ready`。
- `apps/worker` 仅提供严格配置解析；Worker daemon、Docker 管理尚未实现。
- `deploy/compose.dev.yml` 提供仅绑定 loopback 的 PostgreSQL 17.6 开发服务。

## In Progress

None。下一开发边界是 Phase 1，不应在同一变更中提前实现 Worker/Docker Runtime。

## Next

1. 实现 Phase 1 PostgreSQL schema、migration、本地账户与安全 session。
2. 实现 Workspace CRUD 和所有 API ownership 测试，不提前引入 Worker/Docker 逻辑。
3. Phase 2 固定 command timeout/retry 语义，并实现 per-worker identity binding。

## Risks And Blockers

- Worker Gateway 的 TLS/认证具体机制仍需结合真实 LAN/Tailscale 部署验证，但规范已要求
  per-worker identity binding、预注册 endpoint 与独立 data-plane credential。
- pi-web/Pi 尚未 pin。2026-09-10 检查的 pi-web upstream 主分支版本为 0.9.0，Phase 3
  开始前仍需固定并核对实际依赖和状态路径。

## Verification

- 2026-09-10：本机工具版本已读取：Node.js v24.20.0、pnpm 11.24.0、Docker 29.7.2、Docker Compose 5.5.0。
- 2026-09-10：`pnpm install` 通过，并生成 `pnpm-lock.yaml`；仅显式允许 `esbuild` dependency build。
- 2026-09-10：`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm peers check` 全部通过。
- 2026-09-10：`docker compose -f deploy/compose.dev.yml config --quiet` 通过。
- 2026-09-10：PostgreSQL 17.6-alpine 实际启动为 healthy；Control Plane `/health` 返回
  `ok`，`/ready` 通过真实 PostgreSQL 查询返回 `ready`。验证后已停止 Container，
  Compose named volume 保留。
