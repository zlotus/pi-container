# Project Progress

Last reviewed: 2026-09-10

## Current Milestone

Phase 2 已完成：预注册的两个 Worker 可以使用各自 credential 同时建立持久 control
channel；Control Plane 接收 hello/heartbeat，并向 admin 展示 Online/Offline 状态。

## Current Baseline

- `packages/auth` 使用 Node.js scrypt、随机 salt、opaque session token hash 和
  session-bound HMAC CSRF token，不保存明文密码或 session token。
- `packages/database` 提供幂等 migration，以及 users、server-side sessions、workspaces
  的 PostgreSQL repository；Workspace UUID 由服务端生成。
- `apps/control-plane` 提供本地登录/注销、`/api/me`、Workspace list/create/get/delete；
  state-changing API 校验精确 Origin 和 CSRF，跨用户资源统一返回 404。
- `apps/web` 提供 React/Vite 登录和 Workspace Portal；不复制 pi-web Chat UI。
- `workers` registry 持久化 credential hash、主机/架构、Runtime 声明、容量和最后心跳；
  原始 Worker token 只在 provision/rotation CLI 中输出一次。
- `apps/worker` 实现主动 WebSocket control channel、严格配置解析、hello、10 秒默认
  heartbeat 和有上限的指数退避重连；Phase 2 capability 全部明确上报 `false`。
- Control Plane 在握手及后续每条消息校验 credential -> worker ID 绑定，并按服务端
  接收时间判定心跳；credential rotation 后旧连接最迟在下一条消息时关闭。
- `GET /api/admin/workers` 仅允许 admin 访问；Portal 提供自动刷新的 Worker 表格，默认
  35 秒无心跳即显示 Offline。
- Control channel command 每次只发送一次，不做隐式 retry；timeout 失败，迟到/重复
  response 忽略，Worker/request type 不匹配不能完成 pending request。
- 未分配且为 `CREATED` 的 Workspace 可以删除；任何已分配/已进入运行生命周期的
  Workspace 都拒绝纯 metadata 删除，等待后续 Worker 确认协议。
- Worker 尚不访问 Docker，Workspace Runtime、assignment 和生命周期命令仍未实现。
- `deploy/compose.dev.yml` 提供仅绑定 loopback 的 PostgreSQL 17.6 开发服务。

## In Progress

None。下一开发边界是 Phase 3 Minimal Runtime + pi-web，不应提前实现 Phase 4 Gateway
或 Phase 5 Scheduler。

## Next

1. 核对并 pin 当前 pi-web、Pi、Node major 与实际 state path。
2. 构建 Phase 3 Minimal Runtime，只包含 pi-web、pi-agent、shell/core CLI、Git、Python、Node。
3. 通过 Worker 实现 managed Container create/start/stop 与 persistent mount；多 Worker
   联调时只启用一个 eligible Worker 或预先固定 assignment，不实现 Scheduler score。

## Risks And Blockers

- Worker Gateway 的 TLS/认证具体机制仍需结合真实 LAN/Tailscale 部署验证，但规范已要求
  per-worker identity binding、预注册 endpoint 与独立 data-plane credential。
- pi-web/Pi 尚未 pin。2026-09-10 检查的 pi-web upstream 主分支版本为 0.9.0，Phase 3
  开始前仍需固定并核对实际依赖和状态路径。
- Phase 2 的两个真实 Worker 进程在同一 arm64 主机和 loopback 网络完成验收；尚未验证
  跨主机网络、TLS 或 amd64，这些结果不能外推为跨主机/双架构验收。

## Verification

- 2026-09-10：用户确认 Phase 1 已人工验收 ownership、CSRF、logout/session 失效和
  PostgreSQL persistence，并已提交 async form target 修复。
- 2026-09-10：当前工具版本为 Node.js v24.20.0、pnpm 11.24.0、Docker 29.7.2、Docker
  Compose 5.5.0；PostgreSQL 17.6-alpine Compose 服务实查为 healthy。
- 2026-09-10：Phase 2 `pnpm typecheck`、`pnpm lint`、`pnpm test` 和 `pnpm build:web`
  通过；常规测试中的 PostgreSQL 用例在未设置 `TEST_DATABASE_URL` 时按设计跳过。
- 2026-09-10：在临时 PostgreSQL database 从零执行 0001/0002 migration 与真实集成测试，
  Control Plane 测试 20/20 通过，包含 credential 持久化、hello 和 rotation；临时
  database 已删除。
- 2026-09-10：使用真实 Control Plane 与两个真实 Worker daemon 完成同机联调：两者同时
  为 ONLINE；终止 Worker B 后，在缩短为 5 秒的验收阈值下得到 A=ONLINE、B=OFFLINE。
  测试进程及临时 Worker 记录均已清理。
