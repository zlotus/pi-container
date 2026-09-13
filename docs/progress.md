# Project Progress

Last reviewed: 2026-09-13

## Current Milestone

Phase 1～4 已完成人工验收，包括真实 Worker daemon reconnect 后的定向 reconciliation。
Phase 5 Multi-host Scheduler 已完成代码、单元测试和 PostgreSQL 并发集成验证；当前等待两台真实
Worker 的跨主机 placement 验收。尚未进入 Phase 6 Persistence / Recovery。

## Current Baseline

- `packages/auth` 使用 Node.js scrypt、随机 salt、opaque session token hash 和
  session-bound HMAC CSRF token，不保存明文密码或 Portal session token。
- `packages/database` 提供幂等 migration 和 Phase 1～5 repository；users、server-side
  sessions、workspaces、workers 与预注册 `gateway_base_url` 均持久化到 PostgreSQL。
- `apps/control-plane` 提供本地登录/注销、Workspace CRUD/start/stop/open、Worker control
  channel 与 Admin Worker 页面；state-changing API 校验精确 Portal Origin 和 CSRF，跨用户
  API/Proxy 访问统一按不可见资源拒绝。
- `apps/web` 提供 Portal；RUNNING Workspace 的“打开”会请求短时 exchange code，再以
  top-level form POST 到 Workspace Host，不使用 query string、iframe 或宽域 Cookie。
- Portal 与 Workspace Host 使用同一条 server-side session 的不同 host-only Cookie 副本；
  exchange code 仅在单 Control Plane 进程内保存 hash 索引及短时绑定，60 秒过期、单次消费，
  并绑定 user/workspace。Portal logout/revoke 后 Workspace Host Cookie 不能继续通过认证。
- exchange 成功后返回带严格 CSP、禁止缓存/嵌入的最小 Workspace-origin bootstrap HTML，由其
  `location.replace("/")` 发起新的同源导航；不使用会让 Firefox 保留 cross-site Fetch Metadata
  的 HTTP redirect，普通 pi-web proxy 仍拒绝全部 cross-site 请求。
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
- Phase 5 Scheduler 在独立纯函数模块中执行 connected/ONLINE/enabled/fresh-heartbeat、capacity、
  architecture、exact runtime image 与 capability filtering；按 authoritative assignment/max score
  选择最低负载，score 相同按 Worker ID 升序确定性选择。
- capacity authoritative source 是 PostgreSQL `workspaces.worker_id` 的 sticky assignment count，
  包含 STOPPED、ERROR 和 WORKER_OFFLINE Workspace。Worker heartbeat 的
  `allocated_workspaces` 仅作为观测 telemetry；Admin Worker 表显示 authoritative assignment/max。
- 首次 placement 在 PostgreSQL advisory-lock 保护的短事务内完成 count、selection 和
  `worker_id + STARTING` reservation，并发请求不能共同获得最后一个 `max_workspaces` slot。
- 已有 `worker_id` 的 Workspace 不重新进入 Scheduler 候选选择。Worker offline/reconnect 仍只在
  原 Worker 上执行 Phase 4 `workspace.inspect` state repair，不迁移、不隐式 ensure/start。
- Worker 重新完成 authenticated hello 后，Control Plane 会仅对仍绑定该 Worker 的
  `WORKER_OFFLINE` Workspace 逐个发送既有 `workspace.inspect`。只有受管 Runtime 身份、镜像和
  实际状态得到确认后才条件更新：运行中恢复 `RUNNING`，已停止恢复 `STOPPED`，受管目录存在但
  Container 缺失或确定的 metadata/identity 错误进入 `ERROR`；临时无法确认则保持
  `WORKER_OFFLINE`。整个 reconciliation 过程不重新调度、不改变 `workerId`，Gateway 继续
  fail-closed。

## In Progress

Phase 5 真实多主机验收：接入至少两台 compatible Worker，观察不同负载下的首次 placement、
Admin authoritative assignment 计数和 sticky restart；同时验证 Control Plane 到两个 Worker
Gateway 的受保护 LAN/VPN TLS、HTTP/SSE 与 WebSocket 可达性。

## Next

1. 按 README 为第二台宿主机预注册独立 Worker identity、Gateway URL 和 data-plane token，保持
   Worker Gateway 仅对 Control Plane 所在受保护网络可达。
2. 创建多个 Workspace，验证多 Worker score/tie-break、capacity 与 sticky placement 的真实
   host 分布，并记录两台宿主机的 architecture/runtime/capability 实际声明。
3. Phase 5 人工验收完成后再评估 Phase 6；当前不加入完整 inventory/orphan/restart recovery。

## Risks And Blockers

- Phase 4 的真实浏览器、Prompt/Terminal 和 Worker reconnect 已由人工验收确认；自动测试仍只
  证明工程边界，不能替代 Phase 5 两台真实宿主机的 placement 与 data-path 验收。
- Worker Gateway 的可选原生 TLS 已实现，公开 Workspace Gateway 预期由受信反向代理终止
  wildcard TLS；真实 LAN/VPN、DNS、certificate、proxy timeout 和防火墙尚未在目标拓扑验证。
- session exchange 存储是单 Control Plane 进程内、短时且 fail-closed；Control Plane restart
  会使尚未消费的 code 失效。Phase 4 单实例不引入 Redis/多实例共享状态。
- `*.agent.localhost` 是开发等价 host 配置；若目标浏览器/系统不解析子域 localhost，需要人工
  配置 wildcard DNS 或等价本地域名，不能回退到 `/w/<id>/` base-path rewrite。
- 当前 Runtime 镜像和真实 Docker 验证仅覆盖 arm64；amd64 仍需实际构建测试后才能声明支持。
- Phase 5 使用单 Control Plane 进程持有的 authenticated Worker channel 集合作为 connected
  eligibility；多 Control Plane 实例和共享 channel presence 不在 MVP 当前范围。

## Verification

- 2026-09-13：`pnpm lint`、`pnpm typecheck`、带本机 PostgreSQL 的 `pnpm test` 和
  `pnpm build:web` 通过；常规测试共 68 passed，真实 Docker 条件测试在常规门中按设计跳过 2 个。
- 2026-09-13：`TEST_DOCKER_RUNTIME=1 pnpm --filter @agent-runtime/worker test` 在 arm64 Docker
  Engine 29.7.2 上 13/13 通过；未改变 Phase 3 Runtime image 或提前加入 Phase 7 Toolchain。
- 2026-09-13：用户确认 Phase 4 人工验收完成，包括真实 Worker daemon offline/reconnect 后
  `WORKER_OFFLINE -> workspace.inspect -> RUNNING/STOPPED` 修复，且未发生 worker reassignment。
- 2026-09-13：Phase 5 纯函数单测覆盖 connection/status/heartbeat/enabled/capacity filtering、
  architecture、exact runtime image、capability、assignment/max score 与 Worker ID tie-break；
  Control Plane 回归覆盖两个在线 Worker 上两个 Workspace 依次分布到不同 Worker，以及另一个
  Worker 在线时原 Worker reconnect 仍仅发送 `workspace.inspect`。
- 2026-09-13：连接本机 PostgreSQL 17.6 的集成测试覆盖 stale-low heartbeat observation 不影响
  authoritative assignment score、architecture/runtime/capability mismatch、sticky placement，及
  两个并发首次 placement 竞争最后一个 slot 时仅一个获得 assignment。

- 2026-09-12：核对 pinned upstream `@agegr/pi-web@0.9.0` tag 对应 commit `0d1df12`；确认
  页面/API 使用根路径，Prompt/Terminal 使用 EventSource/SSE，Host/Origin 校验支持可信 proxy
  场景，且无需修改或 fork pi-web。
- 2026-09-12：`pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build:web` 通过；常规测试
  共 58 passed，5 个 PostgreSQL/真实 Docker 条件测试按设计跳过。新增重连回归覆盖
  `RUNNING -> WORKER_OFFLINE -> inspect -> RUNNING`、reconciliation 期间拒绝打开、STOPPED、
  Container 缺失及暂时无法确认，不发送隐式 `ensure/start`。
- 2026-09-12：Gateway loopback 测试覆盖 HTTP body/response streaming、SSE、WebSocket
  upgrade/双向 bytes、单次 exchange、Workspace-origin bootstrap、host-only Cookie、logout/
  session 失效基础、ownership、RUNNING/Worker route、Origin、Fetch Metadata、header/cookie
  stripping 和固定 Workspace target；cross-site XHR/subresource/iframe/redirect-chain GET 均拒绝。
- 2026-09-12：Firefox 140.14.0esr 临时 loopback 浏览器探针实测 Portal 跨站 POST 为
  `cross-site/navigate/document`，bootstrap 的 `location.replace("/")` 后 GET 为
  `same-origin/navigate/document`，host-only `SameSite=Lax` Cookie 正常携带且无 Referer。
- 2026-09-12：连接本机 PostgreSQL 17.6 后 Control Plane 35/35 通过；3 个数据库集成测试覆盖
  Phase 1～4 migration/repository、两个用户隔离、Worker credential、Gateway route、Workspace
  lifecycle、offline sweep 与带 worker/runtime/state 前置条件的 reconciliation 更新；Runtime image
  夹具使用随机唯一值，不受开发库中真实 ONLINE Worker 干扰，随机数据已清理。
- 2026-09-12：启用真实 Docker 条件集后 Worker 13/13 通过；2 个 Docker integration tests
  覆盖 Runtime create/start/stop/restart/delete、安全/资源/mount/network 基线与持久化，并
  实际通过 authenticated Worker Gateway 访问 pinned pi-web HTTP；随机容器、网络和临时目录
  已清理。
