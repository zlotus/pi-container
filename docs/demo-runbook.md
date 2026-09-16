# Phase 8 Demo And Acceptance Runbook

本手册用于比赛演示和 Phase 8 人工验收。它建立在已经验收的 Phase 0～7 基线上，不替代生产
TLS、防火墙、身份源或运维验收。

## What The Automated E2E Proves

确定性平台 E2E：

```bash
pnpm test:e2e
```

该入口串行执行 Control Plane 与 Gateway 场景，覆盖登录、两个用户 ownership、Workspace 创建、
多 Worker 调度、session exchange、HTTP/SSE、WebSocket、Stop/Start sticky placement，以及 Worker
Gateway 的二次认证和固定上游。

本机真实 Docker/Runtime E2E：

```bash
pnpm test:e2e:runtime
```

该入口要求本机已有 `agent-runtime:phase7-toolchain`，会启动真实受限 Container 和 pi-web，创建
Pi Session，通过 pi-web 的 bash tool 在 `/workspace` 生成 `artifact.txt`，再经 pi-web Files API
确认成果可见；随后验证 Stop/Start、Container restart、Worker reconciliation、Workspace 文件和
Pi Session JSONL 均保留。测试还覆盖独立 bridge、loopback-only pi-web、无 privileged、无 Docker
socket、资源限制与 legacy Runtime 回归，并在结束时删除随机测试资源。

自动 E2E 不携带真实模型凭据，因此不能证明目标模型的 Prompt/streaming 质量，也不代替目标浏览器、
真实多主机网络和人工视觉验收。下列步骤专门覆盖这些边界。

## Demo Preflight

1. 确认 `git status --short --branch` 是预期版本，`.env` 与 Worker 私有环境未被纳入 Git。
2. 运行数据库 migration、`pnpm test:e2e`，并在本机 Runtime image 可用时运行
   `pnpm test:e2e:runtime`。
3. 打开 `/ready`，确认返回 `200` 和 `{"status":"ready"}`。
4. 以 admin 登录 Portal，确认目标 Worker 均为 `ONLINE`，架构、Runtime version、六项实测
   capability、主机 CPU/Memory 和 authoritative assignment/max 均符合预期。
5. 确认浏览器可解析 `WORKSPACE_BASE_URL` 的 wildcard hostname；多主机环境再确认 Control Plane
   能访问每个预注册 Worker Gateway，而最终用户不能绕过 Control Plane 直接访问它。
6. 比赛演示期间不要启用 auto-stop；本项目当前默认不做 auto-stop。

## Recommended Demo Path

### 1. Login And Placement

1. 以 User A 登录，新建 `demo-a`，点击“启动”。
2. 观察卡片从 `CREATED` 经 `STARTING` 到 `RUNNING`，记录绑定的 Worker。
3. 以 User B 在另一个浏览器 profile 登录，新建并启动 `demo-b`。
4. 回到 admin Portal，解释 `assigned/max` 是 PostgreSQL authoritative capacity，`reported` 只是
   Worker heartbeat telemetry；展示两个 Workspace 的 placement 与 sticky 语义。

### 2. Open pi-web And Execute A Real Task

1. 在 User A Portal 点击“打开”，确认新标签页进入原生 pi-web，而不是平台复制的 Chat UI。
2. 新建 Pi Session，执行一个可重复、无需外部下载的任务，例如：

   ```text
   在 /workspace 创建 demo-result 目录：
   1. 用 Python 生成 summary.json；
   2. 用 ffmpeg 生成 2 秒测试视频 demo.mp4；
   3. 用 LibreOffice headless 生成或转换一份 PDF；
   4. 用 Playwright 打开本地 HTML，读取标题并把结果写入 browser.txt；
   5. 最后列出所有成果及大小。
   ```

3. 观察 Prompt streaming 与 tool execution。在 pi-web Files 中打开 `/workspace/demo-result`，预览或
   下载成果。平台不建立第二份 Artifact registry，成果的 canonical copy 始终位于 `/workspace`。
4. 新建第二个 Pi Session，确认仍在同一个 Platform Workspace 中，说明
   `Platform Workspace != Pi Session`。

### 3. Isolation

1. 复制 User B 的 Workspace URL，在 User A 已登录的浏览器中直接打开。
2. 预期 Gateway 返回不可见资源语义，不能进入 User B 的 pi-web。
3. 不要通过 UUID、query、伪造 Worker header 或直接 Worker Gateway 绕过；这些路径应继续被拒绝。

### 4. Persistence

1. 关闭 pi-web 标签页，再从 Portal 打开 `demo-a`；Workspace 与 Agent 不应因浏览器关闭而销毁。
2. 在 Portal 停止 `demo-a`，确认状态为 `STOPPED`；此状态仍占原 Worker assignment。
3. 再次启动并打开，确认 Worker ID 未变化，原 Pi Session 与 `/workspace/demo-result` 全部恢复。
4. 如演示 Worker/宿主机恢复，只使用 Phase 6 已验收流程：原 Worker reconnect 后 authoritative
   reconciliation；不得触发迁移、隐式重建或 orphan 自动删除。

### 5. Audit And Security Story

1. 在“最近基础设施事件”中确认出现 created、scheduled、starting/running、opened、
   stopping/stopped 等事件；admin 还能看到 Worker online/offline/runtime report。
2. 确认事件不包含 Prompt、assistant message、tool input/output、文件正文、Cookie、session exchange
   code 或 Worker credential。
3. 展示安全面板，并使用准确表述：Docker-based、per-Workspace filesystem/process/resource
   isolation、authenticated reverse proxy；不要宣称 VM-grade、zero-trust 或绝对防逃逸。

## Acceptance Checklist

- [ ] User A/B 均能登录，且互相看不到、打不开对方 Workspace。
- [ ] 两个 eligible Worker 的 placement、capacity 与 sticky Worker ID 可解释。
- [ ] Portal 打开原生 pi-web，真实 Prompt streaming 与至少一个 tool call 正常。
- [ ] Agent 在 `/workspace` 生成成果，pi-web Files 能查看或下载。
- [ ] HTTP/SSE、WebSocket/Terminal 在目标浏览器和真实网络中正常。
- [ ] 关闭浏览器不会停止 Workspace 或丢失 Pi Session。
- [ ] Stop/Start 后 Workspace 文件和 Pi Session 恢复，Worker ID 不改变。
- [ ] Portal 能展示实测 Runtime capabilities、Worker 资源容量、安全边界和平台 Audit Trail。
- [ ] Audit 不包含 Pi 对话/tool stream 或 credential；普通用户只看到自己的 Workspace 事件。
- [ ] 删除演示 Workspace 后，managed Container、network、persistent directory 和 metadata 均按既有
      destructive delete 语义清理；Worker offline 时不伪装删除成功。

## Demo Cleanup

从 Portal 对明确的 `demo-a`、`demo-b` 执行删除并等待成功。不要手工删除 `/var/lib/agent-runtime`
下的广泛目录，也不要用 Docker label 不明的资源做批量清理。若 Worker offline 或 identity mismatch，
保留 metadata 和现场证据，恢复原 Worker 后重试；不要把失败改写成成功，也不要自动删除 orphan、
foreign 或 unknown resource。
