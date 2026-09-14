# Project Progress

Last reviewed: 2026-09-14

## Current Milestone

Phase 0～6 已完成人工验收。Phase 7 完整 Runtime Toolchain、实际 capability probe 和原生双架构
验证入口已实现；ARM64 image/toolchain/browser/Worker Docker 回归已通过。AMD64 没有从 ARM64 构建
结果推断支持，仍等待 native runner 执行相同 matrix 后再完成本阶段人工验收。Phase 8 尚未开始。

## Current Baseline

- `packages/auth` 使用 Node.js scrypt、随机 salt、opaque session token hash 和
  session-bound HMAC CSRF token，不保存明文密码或 Portal session token。
- `packages/database` 提供幂等 migration 和 Phase 1～6 repository；users、server-side
  sessions、workspaces、workers 与预注册 `gateway_base_url` 均持久化到 PostgreSQL。
- Phase 6 migration 为 Workspace 持久化 `RUNNING | STOPPED | DELETED | UNKNOWN` desired state；start、
  stop、delete 在发 Worker 命令前先持久化 intent。Control Plane 启动会把旧 ONLINE/assigned state
  统一 fail-closed 为 offline，避免重启前 heartbeat/state 继续放行 Gateway。
- `apps/control-plane` 提供本地登录/注销、Workspace CRUD/start/stop/open、Worker control
  channel 与 Admin Worker 页面；state-changing API 校验精确 Portal Origin 和 CSRF，跨用户
  API/Proxy 访问统一按不可见资源拒绝。
- `apps/web` 提供 Portal；RUNNING Workspace 的“打开”由用户点击同步预开新标签页，再请求短时
  exchange code，并在新标签页以 top-level form POST 到 Workspace Host，不使用 query string、
  iframe 或宽域 Cookie；Portal/Workspace 列表保留在原标签页。
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
- Runtime 已升级为 `agent-runtime:phase7-toolchain`：digest-pinned Node.js 22.20.0、Rust 1.90.0、
  pi-web 0.9.0、Pi 0.85.1，另 pin pnpm 11.24.0、uv 0.12.13、Playwright 1.63.0，并加入
  build tools、ffmpeg、Poppler/pandoc、LibreOffice、匹配的 Chromium、基础中英文字体和克制的
  shell/filesystem/process/network diagnostic CLI。
  针对 pi-web 0.9.0 唯一的 downstream 行为变更是带 pinned-version/精确片段校验的构建期
  default-cwd patch：平台设置 `PI_WEB_DEFAULT_CWD=/workspace`，未设置时保留上游
  `~/pi-cwd-YYYYMMDD` fallback。
- Worker hello 不再使用按 architecture 硬编码的 Phase 3 capability。每次连接前都在精确
  `RUNTIME_IMAGE` 上运行 short-lived、non-root、network-none、cap-drop/no-new-privileges 且带资源限制
  的实际探针；browser capability 会真实 launch Chromium、打开本地页、evaluate JS 并 close。
  单项失败上报 `false`，image platform mismatch、缺少探针或无效 schema 则不发送 hello。
- Worker 的 Docker 基线保持不变：UID/GID 1000、非 privileged、drop all capabilities、
  no-new-privileges、CPU/memory/PID limit、两个 managed bind mount、每 Workspace 独立 bridge、
  无 Docker socket，pi-web 只发布到动态 loopback port。
- Worker 将 managed ownership/security identity 与当前 desired Runtime configuration 分开验证。
  cleanup 前仅缺少 `PI_WEB_DEFAULT_CWD` 的合法 Container 可继续 ensure/start/inspect/stop/Gateway/
  delete，并保留 legacy default-cwd 行为；新建 Container 必须设置并验证 `/workspace`。显式冲突
  配置不能启动或进入 data path，但仍可 inspect/stop/delete；不会自动重建或删除用户持久数据。
- Phase 5 Scheduler 在独立纯函数模块中执行 connected/ONLINE/enabled/fresh-heartbeat、capacity、
  architecture、exact runtime image 与 capability filtering；按 authoritative assignment/max score
  选择最低负载，score 相同按 Worker ID 升序确定性选择。
- capacity authoritative source 是 PostgreSQL `workspaces.worker_id` 的 sticky assignment count，
  包含 STOPPED、ERROR 和 WORKER_OFFLINE Workspace。Worker heartbeat 的
  `allocated_workspaces` 仅作为观测 telemetry；Admin Worker 表显示 authoritative assignment/max。
- 首次 placement 在 PostgreSQL advisory-lock 保护的短事务内完成 count、selection 和
  `worker_id + STARTING` reservation，并发请求不能共同获得最后一个 `max_workspaces` slot。
- 已有 `worker_id` 的 Workspace 不重新进入 Scheduler 候选选择。Worker offline/reconnect 只在原
  Worker 上执行 Phase 6 authoritative inventory reconciliation，不迁移、不隐式 ensure/start。
- Worker 重新完成 authenticated hello 后，Control Plane 会仅对仍绑定该 Worker 的
  全部 sticky Workspace 先置为 `WORKER_OFFLINE`，再收到包含 authoritative assignment/desired state
  的 `worker.reconcile`。Worker 扫描 Container、network 和 managed directory，验证 metadata、labels、
  mount、安全/资源配置、legacy compatibility 与 running pi-web readiness 后返回完整 typed report。
- Recovery 仅在 Workspace/Worker/runtime/desired/current-state 全部条件匹配时恢复：desired/observed
  同为运行或停止才恢复 `RUNNING`/`STOPPED`；unexpected stop、缺失、相反状态和确定 mismatch 进入
  `ERROR`；retryable Docker/pi-web 错误、断线或不完整报告保持 `WORKER_OFFLINE`。不重新调度、不改变
  `workerId`，也不隐式 ensure/start。
- Worker 将未分配本地资源分类为 `MANAGED_ORPHAN`、`FOREIGN_MANAGED_RESOURCE` 或
  `UNKNOWN_RESOURCE` 并由 Control Plane 记录结构化 warning；三类都不自动删除。只有已持久化
  `DELETED` intent 且完整 inventory 明确确认 Container、network、directory 均不存在时，才补完成
  中断的 metadata 删除。
- 新建 Runtime 配置 Docker `unless-stopped` restart policy；运行中的 Container 可随 Docker/宿主机
  恢复，显式停止的保持停止。缺少该新增 policy 或 default-cwd 的合法 legacy Runtime 仍可管理，
  recovery 不修改、不重建、不删除它。

## In Progress

Phase 7 工程实现与 ARM64 自动验证已完成，当前等待 AMD64 native matrix 和本阶段人工验收。

## Next

1. 在 native AMD64 Docker host 或 GitHub `ubuntu-24.04` runner 上执行 Phase 7 matrix；通过前不标记支持。
2. 人工确认两个架构的 Worker hello capability、pi-web/Prompt/Terminal 与代表性工具调用。
3. 保持 Phase 6 recovery、安全边界和已验收主线稳定；验收前后都不进入 Phase 8。

## Risks And Blockers

- Phase 5 的两台真实 Worker placement、浏览器 data path、Prompt/Terminal、sticky/offline/reconnect
  与 bind-mount persistence 已由人工验收确认；自动测试仍不能替代目标生产网络、安全和运维验收。
- Worker Gateway 的可选原生 TLS 已实现，公开 Workspace Gateway 预期由受信反向代理终止
  wildcard TLS；本次通过的是开发 HTTP + `nip.io` wildcard DNS，生产 wildcard certificate、
  TLS termination、proxy timeout 和目标防火墙规则尚未验收。
- session exchange 存储是单 Control Plane 进程内、短时且 fail-closed；Control Plane restart
  会使尚未消费的 code 失效。Phase 4 单实例不引入 Redis/多实例共享状态。
- `*.agent.localhost` 仅适合单机开发；跨主机验收已使用 `nip.io` wildcard 示例。生产必须配置
  受管内部 wildcard DNS，不能回退到 `/w/<id>/` base-path rewrite，也不能把 `nip.io` 当作生产依赖。
- 当前 Phase 7 Runtime 的真实 Docker 验证仅覆盖 arm64；本机没有 amd64/binfmt Docker endpoint，
  先前验收示例的远端主机也不可达。仓库已提供 native AMD64/ARM64 workflow，但 amd64 job 尚未在
  该 workflow 上执行，因此 matrix 明确保持 `PENDING`，不能声明支持。
- Phase 5 及更早创建的合法 legacy Container 没有 `unless-stopped` policy；Phase 6 为保持兼容不会在
  recovery 中自动修改它。此类 Runtime 在完整宿主机重启后可能被观察为 STOPPED/ERROR，需用户明确
  start 或删除重建后才获得新 policy。
- Phase 5 使用单 Control Plane 进程持有的 authenticated Worker channel 集合作为 connected
  eligibility；多 Control Plane 实例和共享 channel presence 不在 MVP 当前范围。

## Verification

- 2026-09-14：Phase 7 最终根级验证通过：`pnpm lint`、`pnpm typecheck`、`pnpm test`
  （76 passed，10 个 PostgreSQL/真实 Docker 条件测试按设计跳过）与 `pnpm build:web`；接入本机
  PostgreSQL 后 Control Plane 46/46 通过。随后重新构建最终 ARM64 image，Runtime smoke 与 Worker
  真实 Docker 测试 23/23 再次通过。
- 2026-09-14：本机 ARM64 Docker Engine 29.7.2 构建 `agent-runtime:phase7-toolchain` 成功；
  `runtime/scripts/verify-image.sh ... arm64` 在 network-none、non-root、drop-all-capabilities、
  no-new-privileges 条件下通过全部语言/build/media/PDF/Office/diagnostic 命令。实测版本包括
  Python 3.11.2、uv 0.12.13、Node 22.20.0、pnpm 11.24.0、Rust/cargo 1.90.0、ffmpeg 5.1.9、
  Poppler 22.12.0、pandoc 2.17.1.1 和 LibreOffice 7.4.7.2。
- 2026-09-14：Playwright 1.63.0 下载并运行原生 ARM64 Chrome for Testing 153.0.8010.12；实际
  launch/open local file/evaluate JS/close smoke 通过，strict Worker capability probe 返回六项 `true`。
  `TEST_DOCKER_RUNTIME=1 TEST_RUNTIME_IMAGE=agent-runtime:phase7-toolchain pnpm --filter
  @agent-runtime/worker test` 23/23 通过，覆盖 Phase 3～6 pi-web、persistence、Gateway、reconciliation、
  legacy compatibility 与 network isolation 回归。

- 2026-09-13：Phase 6 post-acceptance cleanup 通过 `pnpm lint`、`pnpm typecheck`、`pnpm test` 与
  `pnpm build:web`；默认测试 74 passed，9 个 PostgreSQL/真实 Docker 条件测试按设计跳过。
  `docker compose -f deploy/compose.dev.yml config` 确认开发 PostgreSQL 的 restart policy 为
  `unless-stopped`。Portal 新标签页行为已通过类型检查与生产构建，仍需在目标浏览器策略下点击确认
  popup blocker 交互。
- 2026-09-13：用户确认 Phase 6 人工验收主线通过；该结论不扩展至 systemd、生产进程托管或其他
  Phase 7+ 部署能力。
- 2026-09-13：Phase 6 工程门通过 `pnpm lint`、`pnpm typecheck`、`pnpm test` 与
  `pnpm build:web`；Node.js 24.20.0 / pnpm 11.24.0 环境下默认测试 74 passed，5 个 PostgreSQL 与
  4 个真实 Docker 条件测试按设计跳过。协议/Control Plane/Worker 单测覆盖 typed authoritative
  inventory、desired/observed state、retryable fail-closed、unexpected stop、缺失/mismatch、orphan 与
  unknown 分类、name/label 冲突不误判为空，以及中断 delete 只在完整缺失确认后补完成 metadata 删除。
- 2026-09-13：连接本机 PostgreSQL 17.6 后 Control Plane 46/46 通过；另在新建的临时空数据库从零
  执行全部 migration 并再次 46/46 通过，验证 startup offline、desired state、条件 recovery 与
  interrupted-delete recovery，临时数据库已删除。
- 2026-09-13：`TEST_DOCKER_RUNTIME=1 pnpm --filter @agent-runtime/worker test` 在 arm64 Docker Engine
  29.7.2 上 20/20 通过；真实 Runtime 验证 `unless-stopped`、Docker Container restart、重建 Worker
  Runtime 对象后的 inventory/recovery、`/workspace` 文件与 Pi Session JSONL 保留、legacy Container
  管理、Gateway 和网络隔离。
- 2026-09-13：Phase 5 cleanup backward-compatibility regression 修复通过 `pnpm lint`、
  `pnpm typecheck`、`pnpm test` 和 `pnpm build:web`；默认测试 67 passed、8 个 PostgreSQL/真实
  Docker 条件测试按设计跳过。启用本机 PostgreSQL 后 Control Plane 42/42 通过，确认 destructive
  delete 后 metadata 删除且 authoritative assignment 从 1 释放为 0；arm64 Docker 条件套件
  18/18 通过，真实构造 cleanup 前仅缺少 `PI_WEB_DEFAULT_CWD` 的 managed Container，并验证
  ensure/start/inspect/stop/delete 后 Container、network 与 managed root 均删除。新 Container 的
  `/workspace` working dir/default cwd、Session JSONL cwd、bind persistence 与既有 Gateway 行为继续通过。
- 2026-09-13：Phase 5 post-acceptance cleanup 通过 `pnpm lint`、`pnpm typecheck`、`pnpm test` 和
  `pnpm build:web`；默认测试门 64 passed，4 个 PostgreSQL 与 3 个真实 Docker 条件测试按设计跳过。
  另以 `TEST_DATABASE_URL` 启用本机 PostgreSQL 后 Control Plane 42/42 通过，使常规测试完整覆盖
  68 passed。
- 2026-09-13：重新构建 `agent-runtime:phase3-minimal` 后，
  `TEST_DOCKER_RUNTIME=1 pnpm --filter @agent-runtime/worker test` 在 arm64 Docker 上 14/14 通过。
  3 个 Docker integration tests 现覆盖 `/workspace` working dir/default cwd、pi-web 创建 Session 后
  JSONL header 的 `/workspace` cwd、从 Session 在 bind mount 写文件并 stop/start 保留、authenticated
  Worker Gateway HTTP，以及移除 `PI_WEB_DEFAULT_CWD` 后上游 `~/pi-cwd-YYYYMMDD` fallback；既有
  HTTP/SSE/WebSocket Gateway 回归仍通过。
- 2026-09-13：用户确认 Phase 5 真实 multi-host 人工验收通过：两台真实 Worker 的首次 placement
  验证了 `assigned/max` load score、deterministic tie-break、capacity full / no eligible Worker；
  STOPPED Workspace 继续占 authoritative assignment，只有 destructive delete 明确成功后才释放
  capacity，释放后新的 Workspace 可以 placement。
- 2026-09-13：同一轮人工验收确认 sticky restart、Worker offline 不 failover、reconnect 后只在原
  Worker reconciliation；远端浏览器经 Control Plane Gateway 可访问 `worker-a` 和 `worker-c`，
  HTTP、pi-web、Prompt streaming、Terminal data path 正常，且 `/workspace` bind mount 的真实跨主机
  持久化已确认。该结论不包含生产 TLS 或 wildcard certificate 验收。
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
  场景，Phase 4 Gateway 当时无需修改或 fork pi-web。
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
