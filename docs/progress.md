# Project Progress

Last reviewed: 2026-09-11

## Current Milestone

Phase 3 Minimal Runtime + pi-web 的工程实现与自动验证已完成，等待人工验收真实 pi-web
交互、Pi Session 创建/续接和 Portal 到单 Worker 的完整操作流。Phase 4 Gateway 与 Phase 5
Scheduler 均未开始。

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
- `runtime/Dockerfile` 基于 digest-pinned Node.js 22.20.0，精确安装 pi-web 0.9.0、Pi
  0.85.1 和 pnpm 11.24.0；最终镜像仅包含 Phase 3 所需 shell/core CLI、Git、Python、
  Node 与 Pi，不含 Phase 7 的 Rust、Office、ffmpeg 或 Chromium。
- `apps/worker` 通过本机 Docker Engine API 实现 `workspace.ensure/start/stop/delete/inspect`；
  Runtime 使用 UID/GID 1000、非 privileged、drop all capabilities、no-new-privileges、
  CPU/memory/PID limit、两个 managed bind mount 和每 Workspace 独立 bridge。
- pi-web 只发布到动态 `127.0.0.1` host port；`/workspace` 与
  `PI_CODING_AGENT_DIR=/agent/pi` 位于 Worker managed root，Container 不挂 Docker socket。
- Worker 以受 schema 约束的 response 回报命令结果，心跳按真实 managed Container 数量
  上报 allocation；Docker 不可用时不把 Worker 宣告为可用 Runtime。
- Control Plane 增加 ownership/CSRF 保护的 start/stop；首次启动仅在恰好一个在线、容量
  未满且 Runtime/架构/capability 兼容的 Worker 时绑定。多个 eligible Worker 明确拒绝，
  没有评分、随机选择或其他 Phase 5 Scheduler 行为。
- assigned Workspace 的 delete 只有在 Worker 确认 managed Container、network 和持久目录
  删除后才删除 metadata；Worker offline 时拒绝 destructive delete。
- Portal 可启动/停止/删除 Runtime；“打开”保持禁用，因为 authenticated HTTP/WebSocket
  Gateway 属于 Phase 4。
- Control Plane 在握手及后续每条消息校验 credential -> worker ID 绑定，并按服务端
  接收时间判定心跳；credential rotation 后旧连接最迟在下一条消息时关闭。
- `GET /api/admin/workers` 仅允许 admin 访问；Portal 提供自动刷新的 Worker 表格，默认
  35 秒无心跳即显示 Offline。
- Control channel command 每次只发送一次，不做隐式 retry；timeout 失败，迟到/重复
  response 忽略，Worker/request type 不匹配不能完成 pending request。
- 未分配且为 `CREATED` 的 Workspace 可以删除；任何已分配/已进入运行生命周期的
  Workspace 都拒绝纯 metadata 删除，等待后续 Worker 确认协议。
- `deploy/compose.dev.yml` 提供仅绑定 loopback 的 PostgreSQL 17.6 开发服务。

## In Progress

Phase 3 人工验收：使用一个 eligible Worker，从 Portal 启动 Workspace，在本机 loopback
测试入口验证 pi-web Terminal、真实 Pi Session、Prompt/streaming，以及 stop/start 后同一
Session 可继续。该入口不是最终用户访问路径。

## Next

1. 完成并记录 Phase 3 人工验收，尤其是真实 Pi Session restart continuity。
2. 人工验收通过后再进入 Phase 4 Authenticated Gateway；不要将 loopback 测试入口产品化。
3. Phase 5 前保持单 eligible Worker 或管理员预先 assignment，不加入调度评分。

## Risks And Blockers

- Worker Gateway 的 TLS/认证具体机制仍需结合真实 LAN/Tailscale 部署验证，但规范已要求
  per-worker identity binding、预注册 endpoint 与独立 data-plane credential。
- 当前镜像只在 arm64 构建和运行；虽然 base image digest 是 multi-platform manifest，amd64
  仍必须实际构建和测试后才能声明支持。
- 自动测试验证了 pi-web HTTP health 和普通文件形式的 `/agent/pi` 持久化，但没有模型
  credential，尚未代替人工完成真实 Prompt/streaming/Pi Session continuity 验收。
- Phase 4 尚未实现，因此不存在经过最终用户 authentication/authorization 的 pi-web
  data path；当前 loopback 端口只能用于 Worker 宿主机开发验收。

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
- 2026-09-11：用户确认 Phase 2 双 Worker、offline/reconnect、credential identity binding、
  impersonation rejection 与 credential rotation 人工验收全部通过。
- 2026-09-11：`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint`、`pnpm test`
  与 `pnpm build:web` 通过；常规测试为 39 passed，3 个 PostgreSQL/真实 Docker 条件测试
  按设计跳过。
- 2026-09-11：对本机 PostgreSQL 17.6 运行 Phase 1-3 repository 集成测试，3/3 通过，
  覆盖 eligible Worker 查询和 Workspace lifecycle 原子状态转换；随机测试数据已清理。
- 2026-09-11：在 arm64 实际构建 `agent-runtime:phase3-minimal`，确认运行用户为
  `agent(1000:1000)`，Git 2.39.5、Python 3.11.2、Node 22.20.0、pnpm 11.24.0、Pi
  0.85.1 与 pi-web 0.9.0 CLI 可用，pi-web HTTP health 为 healthy。
- 2026-09-11：真实 Docker Runtime integration 2/2 通过，覆盖 create/start/stop/restart/
  delete、资源和 privilege/label/mount/loopback port 基线、Workspace/Pi 文件持久化，以及
  两个 Workspace bridge 互访和从 Container 访问宿主机 loopback 映射均失败；测试资源已清理。
