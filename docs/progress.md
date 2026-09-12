# Project Progress

Last reviewed: 2026-09-12

## Current Milestone

Phase 1～3 已完成人工验收。Phase 4 Authenticated Gateway 的工程实现和自动验证已完成，
当前等待在真实浏览器、真实模型凭据和目标 LAN/TLS 拓扑中人工验收 Portal 到 pi-web 的
完整交互。Phase 5 Scheduler 尚未开始。

## Current Baseline

- `packages/auth` 使用 Node.js scrypt、随机 salt、opaque session token hash 和
  session-bound HMAC CSRF token，不保存明文密码或 Portal session token。
- `packages/database` 提供幂等 migration 和 Phase 1～4 repository；users、server-side
  sessions、workspaces、workers 与预注册 `gateway_base_url` 均持久化到 PostgreSQL。
- `apps/control-plane` 提供本地登录/注销、Workspace CRUD/start/stop/open、Worker control
  channel 与 Admin Worker 页面；state-changing API 校验精确 Portal Origin 和 CSRF，跨用户
  API/Proxy 访问统一按不可见资源拒绝。
- `apps/web` 提供 Portal；RUNNING Workspace 的“打开”会请求短时 exchange code，再以
  top-level form POST 到 Workspace Host，不使用 query string、iframe 或宽域 Cookie。
- Portal 与 Workspace Host 使用同一条 server-side session 的不同 host-only Cookie 副本；
  exchange code 仅在单 Control Plane 进程内保存 hash 索引及短时绑定，60 秒过期、单次消费，
  并绑定 user/workspace。Portal logout/revoke 后 Workspace Host Cookie 不能继续通过认证。
- `apps/control-plane` 的独立 Workspace Gateway listener 严格解析
  `<workspace-id>.<WORKSPACE_BASE_URL host>`，每个 HTTP 请求和 WebSocket handshake 都重新
  校验 session、ownership、RUNNING、Worker heartbeat、预注册 route 与 per-Worker token。
- Control Plane 只路由到数据库中该 Worker 的 `gateway_base_url`，并使用
  `WORKER_GATEWAY_TOKENS_JSON` 中按 Worker ID 绑定、与 control credential 分离的 data-plane
  credential；浏览器不能指定 target host/port、Worker ID 或可信平台头。
- `apps/worker` 提供可配置 host/port、可选原生 TLS 的 Worker Gateway。它再次校验独立
  credential、Workspace ID、公共 Host/proto 与本机 managed metadata/container labels，且
  只把一个 RUNNING 容器的精确 `127.0.0.1:<workspace-port>` 作为上游。
- `packages/gateway` 使用 Node HTTP 流和透明 WebSocket upgrade/tunnel，不解析 Pi RPC，支持
  SSE、上传/下载和长连接；两级代理剥离 hop-by-hop/Connection 指定头、平台 Cookie、浏览器
  伪造的 Authorization/Workspace 头，并阻止 upstream 覆盖平台 Cookie。
- Worker 到 pi-web 的 Host/Origin 会在完成外部 Host/Origin 校验后重写为受管 loopback
  endpoint，兼容已存在的 Phase 3 容器；新容器同时显式设置该 Workspace 的
  `PI_WEB_ALLOWED_HOSTS`。绝对 upstream redirect 会改写回公共 Workspace origin。
- Runtime 仍为 Phase 3 Minimal Image：digest-pinned Node.js 22.20.0、pi-web 0.9.0、Pi
  0.85.1、pnpm 11.24.0，以及 shell/core CLI、Git、Python、Node；Phase 7 Toolchain 未提前加入。
- Worker 的 Docker 基线保持不变：UID/GID 1000、非 privileged、drop all capabilities、
  no-new-privileges、CPU/memory/PID limit、两个 managed bind mount、每 Workspace 独立 bridge、
  无 Docker socket，pi-web 只发布到动态 loopback port。
- Phase 3/4 仍只在恰好一个 eligible Worker 时自动绑定；没有 Phase 5 的评分、随机选择、
  跨 Worker 迁移或 persistent control-WebSocket byte tunnel。

## In Progress

Phase 4 人工验收：在真实 Portal/Workspace wildcard Host 下，分别使用 User A/B 验证 host-only
session exchange 与 ownership；在真实 pi-web 中验证页面、Prompt SSE streaming、Workspace
Terminal、文件上传/下载和浏览器断开/重连。多主机部署还需验证 Control Plane 到 Worker
Gateway 的受保护 LAN/VPN 可达性、TLS certificate 和 WebSocket upgrade。

## Next

1. 按 README 配置现有 Worker 的 `gateway_base_url`、独立 Gateway token 与 Workspace wildcard
   Host，完成人工 Phase 4 单机浏览器验收。
2. 在目标 LAN/Tailscale 或等价私网中完成真实跨主机 TLS/HTTP/WebSocket 联调，并记录实际
   certificate、DNS 与防火墙边界；不暴露 Worker Gateway 或 pi-web loopback endpoint。
3. Phase 4 完整 Demo 稳定后再进入 Phase 5；此前不加入多 Worker score/capability Scheduler。

## Risks And Blockers

- pinned pi-web 0.9.0 的 Prompt 与 Terminal 实际使用 HTTP + SSE；当前代理已用真实 chunked
  SSE 和独立 WebSocket echo upstream 验证两种传输，但仍需带模型 credential 的真实 Prompt/
  Terminal 浏览器验收，自动测试不能替代该结果。
- Worker Gateway 的可选原生 TLS 已实现，公开 Workspace Gateway 预期由受信反向代理终止
  wildcard TLS；真实 LAN/VPN、DNS、certificate、proxy timeout 和防火墙尚未在目标拓扑验证。
- session exchange 存储是单 Control Plane 进程内、短时且 fail-closed；Control Plane restart
  会使尚未消费的 code 失效。Phase 4 单实例不引入 Redis/多实例共享状态。
- `*.agent.localhost` 是开发等价 host 配置；若目标浏览器/系统不解析子域 localhost，需要人工
  配置 wildcard DNS 或等价本地域名，不能回退到 `/w/<id>/` base-path rewrite。
- 当前 Runtime 镜像和真实 Docker 验证仅覆盖 arm64；amd64 仍需实际构建测试后才能声明支持。

## Verification

- 2026-09-12：核对 pinned upstream `@agegr/pi-web@0.9.0` tag 对应 commit `0d1df12`；确认
  页面/API 使用根路径，Prompt/Terminal 使用 EventSource/SSE，Host/Origin 校验支持可信 proxy
  场景，且无需修改或 fork pi-web。
- 2026-09-12：`pnpm install --offline`、`pnpm lint`、`pnpm typecheck`、`pnpm test` 和
  `pnpm build:web` 通过；常规测试共 52 passed，5 个 PostgreSQL/真实 Docker 条件测试按设计
  跳过。
- 2026-09-12：Gateway loopback 测试覆盖 HTTP body/response streaming、SSE、WebSocket
  upgrade/双向 bytes、单次 exchange、host-only Cookie、logout/session 失效基础、ownership、
  RUNNING/Worker route、Origin、header/cookie stripping 和固定 Workspace target。
- 2026-09-12：连接本机 PostgreSQL 17.6 后 Control Plane 29/29 通过；3 个数据库集成测试覆盖
  Phase 1～4 migration/repository、两个用户隔离、Worker credential、Gateway route 和 Workspace
  lifecycle，随机数据已清理。
- 2026-09-12：启用真实 Docker 条件集后 Worker 13/13 通过；2 个 Docker integration tests
  覆盖 Runtime create/start/stop/restart/delete、安全/资源/mount/network 基线与持久化，并
  实际通过 authenticated Worker Gateway 访问 pinned pi-web HTTP；随机容器、网络和临时目录
  已清理。
- 尚未声明完成：真实模型 Prompt、Terminal SSE、浏览器 session exchange、外部 wildcard
  DNS/TLS、跨主机 Worker Gateway 和真实 upstream WebSocket（pi-web 0.9.0 当前无该业务路径）。
