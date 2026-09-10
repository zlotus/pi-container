# Project Progress

Last reviewed: 2026-09-10

## Current Milestone

Phase 1 已完成：两个本地账户可以独立登录、管理各自的 Workspace，服务端在 API 和
PostgreSQL 查询两层执行 ownership 隔离。

## Current Baseline

- `packages/auth` 使用 Node.js scrypt、随机 salt、opaque session token hash 和
  session-bound HMAC CSRF token，不保存明文密码或 session token。
- `packages/database` 提供幂等 migration，以及 users、server-side sessions、workspaces
  的 PostgreSQL repository；Workspace UUID 由服务端生成。
- `apps/control-plane` 提供本地登录/注销、`/api/me`、Workspace list/create/get/delete；
  state-changing API 校验精确 Origin 和 CSRF，跨用户资源统一返回 404。
- `apps/web` 提供 React/Vite 登录和 Workspace Portal；不复制 pi-web Chat UI。
- 未分配且为 `CREATED` 的 Workspace 可以删除；任何已分配/已进入运行生命周期的
  Workspace 都拒绝纯 metadata 删除，等待后续 Worker 确认协议。
- `apps/worker` 仅提供严格配置解析；Worker daemon、Docker 管理尚未实现。
- `deploy/compose.dev.yml` 提供仅绑定 loopback 的 PostgreSQL 17.6 开发服务。

## In Progress

None。下一开发边界是 Phase 2 Worker Control Channel，不应提前实现 Phase 3 Runtime。

## Next

1. 固定 Phase 2 command timeout/retry 语义与 credential rotation 行为。
2. 实现 per-worker credential -> worker_id binding、persistent control channel 与 heartbeat。
3. 实现 admin worker page，并用两个 Worker 验证 Online/Offline 检测。

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
- 2026-09-10：Phase 1 `pnpm typecheck`、`pnpm lint`、`pnpm test` 和 `pnpm build:web`
  通过；常规测试共 20 个用例通过，PostgreSQL 集成用例在未设置 `TEST_DATABASE_URL` 时跳过。
- 2026-09-10：在一次性 PostgreSQL 17.6-alpine tmpfs Container 上实际执行 migration 两次，
  两个持久化用户均登录成功；User A 创建 Workspace 后 User B 列表为空。集成测试 9/9
  通过，随后停止并自动删除测试 Container 与 tmpfs 数据。
