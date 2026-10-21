# Lifecycle Runbook

Phase 18（`specs.md` 第 64 节 Phase 18）的运维说明：Runtime 镜像的上架、切换默认、升级与回滚、下线；Worker 的吊销、
重新启用与删除。设计与验收见 `specs.md` 18.4–18.6、18.15。

## 1. Runtime 镜像

### 1.1 概念

- **Runtime 镜像** = 镜像引用（tag）+ digest + 镜像标签 `io.agent-runtime.runtime.version`（另有 `pi-web.version`、
  `pi.version`，Portal 显示）。**同一 tag 永不重建**：内容变化就用新 tag 与新 runtime version。
- 每台 Worker 用 `RUNTIME_IMAGES` 列出它提供的镜像（1～4 个），每项按 digest pin：

  ```bash
  RUNTIME_IMAGES=agent-runtime:phase7-toolchain@sha256:<digest>,agent-runtime:phase18-pi1.1-r2@sha256:<digest>
  ```

  digest 取 `docker image inspect <tag> --format '{{.Id}}'`（containerd 镜像存储下与 `RepoDigests` 相同），或直接用
  `agent-runtime-image verify <tag>` 输出的整行。镜像只构建一次、以归档分发，各 Worker 的 digest 相同（1.2）。过渡期的
  `RUNTIME_IMAGE` / `RUNTIME_VERSION` 已在 v1.0 移除（Phase 19），环境中仍有它们时 Worker 拒绝启动并提示改写。
- Worker 每次连接前逐个校验：tag 必须解析到 pin 的 digest、平台为本机架构、有版本标签、版本互不重复；不满足的镜像**不提供**
  （日志 `not offered` 说明原因），全部不满足时 Worker 不连接。每个提供的镜像都跑一次 capability 探针。
- 已有容器始终用创建它的那个镜像 ID 运行；tag 被改指向其他内容不影响运行中的 Workspace，只影响之后新建的容器（届时该镜像
  已不被提供）。
- Control Plane 的 `DEFAULT_RUNTIME_IMAGE` 决定新 Workspace 的镜像和“升级”的目标。

### 1.2 构建与验证

在一台构建主机（开发环境为 worker-a）上，从干净的 checkout 构建一次（`specs.md` 19.4.2）：

```bash
# 新 tag 即 runtime version，例如 2026.11-pi1.2；本地已有同名 tag 时拒绝（永不重建）
deploy/production/scripts/build-runtime-image.sh <新 tag>
# -> dist/runtime-images/agent-runtime_<tag>_linux-<arch>.tar.zst（+ .sha256、.manifest.txt 构建清单）
pnpm test:e2e:runtime                      # 真实 Docker：生命周期、Session、Files、持久化、新旧镜像切换
TEST_DOCKER_RUNTIME=1 pnpm --filter @agent-runtime/worker exec vitest run src/model-relay/catalog.docker.test.ts
```

Node 包（pi-web、Pi、Playwright、pnpm 及全部传递依赖）由 `runtime/packages/package-lock.json` 固定、`npm ci` 安装；
改动 pi-web / Pi 版本时先改 `package.json`，再在镜像所用的 node 镜像中重新生成 lockfile 并审阅差异：

```bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/runtime/packages:/work" -w /work \
  node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e \
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund
```

**同一镜像分发到各 Worker**：Debian 系统包按构建当天解析，各 Worker 分别构建得到的镜像不保证完全相同，所以**不要在各
Worker 上各自构建**。把归档拷到其他 Worker 后加载（校验 sha256、平台与版本标签，输出 `RUNTIME_IMAGES` 项；digest 与构建
主机相同）：

```bash
scp dist/runtime-images/agent-runtime_<tag>_linux-<arch>.tar.zst{,.sha256} <Worker>:/tmp/
agent-runtime-image load /tmp/agent-runtime_<tag>_linux-<arch>.tar.zst   # 发布包 bin/ 中；开发 checkout 为 deploy/production/bin/
# 也可：docker save agent-runtime:<tag> | ssh <Worker> docker load，再 agent-runtime-image verify agent-runtime:<tag>
```

v1.0 不使用镜像仓库（`specs.md` 19.15 Q3）；企业已有内部仓库时的做法见 `docs/ops/22-offline-deployment.md`。

最后一条在本机的每个 Runtime 镜像中加载平台模型目录：新旧镜像共用一个目录，任一 Pi 版本拒绝都不能上线。pi-web 版本变化时
必须重写 `runtime/patches/pi-web-<版本>.mjs`（只接受 pin 的版本，片段对不上即构建失败），并按 `specs.md` 18.1 的检查表核对
release notes。

### 1.3 上线流程（与 `specs.md` 18.15 一致）

1. **上架**：每台 Worker 取得新镜像，把 `<tag>@<digest>` **追加**到 `RUNTIME_IMAGES`（保留旧镜像），重启 Worker。
   Admin Workers 的“详情”列出各镜像、版本与使用它的 Workspace 数；capability 应全部为真。
2. **试点**：Admin Workspaces 中对一两个已停止的 Workspace 执行“切换 Runtime”，使用至少一个工作日。
3. **切换默认**：所有可调度 Worker 都提供新镜像后，修改 `DEFAULT_RUNTIME_IMAGE` 并重启 Control Plane。缺镜像的 Worker 在
   Admin Workers 显示“缺少默认 Runtime”，并触发 `AgentRuntimeDefaultRuntimeImageMissing`；新 Workspace 不会分配到它。
4. **用户升级**：存量 Workspace 的卡片显示“有新版本可升级”，用户停止后在“⋯”菜单中升级；管理员也可代为切换。
5. **回滚窗口**：旧镜像至少保留两周。
6. **下线**：旧镜像的 Workspace 计数为 0 后，从 `RUNTIME_IMAGES` 移除、重启 Worker，再 `docker image rm`。仍在使用被移除镜像的
   Workspace 可以查看、停止、删除，但不能启动（`RUNTIME_IMAGE_UNAVAILABLE`），Admin Workers 详情中会提示数量。

### 1.4 升级、回滚与重试

- 只对**已停止**的 Workspace 进行：删除容器并用目标镜像按同一套配置重建；`/workspace`、主目录、`/agent/pi`（Pi 会话与配置）、
  网络与配额都不变，`/tmp` 照常在下次启动前清空。
- Owner：“升级 Runtime”（到平台默认）、“回滚到上一版本”。Admin：在 Admin Workspaces 中切换到该 Worker 提供的任一镜像（不
  打开、不启动、不删除）。
- **回滚的数据兼容性**（`specs.md` 18.16 S2）：普通对话与工具调用的会话在 Pi 1.1.0 与 0.85.1 之间双向可用；Pi 1.x 特有的
  会话条目（上下文编辑类扩展产生的 `context_edit` 等）回滚后可能无法完整显示，文件不受影响。平台不在升级前复制 `/agent/pi`。
- **切换未完成**：命令超时、Worker 断线或 Docker 错误时，Workspace 进入“Runtime 切换未完成”（`ERROR`），卡片提示“重试”或
  “回滚”，二者都是幂等的同一操作；完成前不能启动（`RUNTIME_CHANGE_INCOMPLETE`）。Worker 重连后的 reconcile 也会收敛：容器
  已是目标镜像且已停止则恢复为“已停止”。
- 排查：`docker inspect agent-runtime-<workspaceId> --format '{{.Config.Image}} {{.Image}}'`、该 Workspace 的
  `metadata/managed.json`（`runtimeImage`、`runtimeImageId`、`previousRuntimeImage`）、Worker 日志（按 workspaceId）。

### 1.5 新镜像中的 pi-web 行为（pi-web 0.12.0 / Pi 1.1.0）

- 没有会话时 pi-web 显示“选择项目”：点 Files 区域的“Use default directory”即打开 `/workspace` 并可新建会话。
- pi-web 由 `pi-web-launch` 启动，每次启动在 tmpfs 中生成新的 preview 密钥；不要在容器中直接运行 `pi-web`。
- 镜像默认关闭 Pi 的安装/更新 telemetry 与版本检查（`PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`）。
- MCP：全局配置在 `/agent/pi/mcp.json`，项目配置 `.pi/mcp.json` 需要先信任项目（决定保存在 `/agent/pi/trust.json`）。stdio
  server 在容器内运行；HTTP server 受出口规则约束（内网默认拒绝）。

## 2. Worker 吊销、重新启用与删除

| 命令 | 作用 |
|---|---|
| `WORKER_ID=<id> pnpm worker:disable` | 吊销：`enabled=false`、状态 `DISABLED`，其 Workspace 置为 `WORKER_OFFLINE`，这些 Workspace 的模型 key 进入吊销（网关确认后为 `revoked`）。Control Plane 在 5 秒内断开该 Worker 的控制连接与指向其 Workspace 的浏览器连接。幂等。 |
| `WORKER_ID=<id> pnpm worker:enable` | 重新启用，**同时轮换凭据**并输出新的 `WORKER_TOKEN`；更新该 Worker 的 `.env` 后重启，reconcile 恢复其 Workspace，模型 key 由后台循环重新签发。 |
| `WORKER_ID=<id> pnpm worker:delete` | 删除 Control Plane 中的 Worker 记录，仅限已禁用且没有任何 Workspace 的 Worker；之后从 `WORKER_GATEWAY_TOKENS_JSON` 中移除它。不改动该主机。 |

- 直接在数据库中把 `workers.enabled` 改为 false 与 `worker:disable` 效果相同（数据库触发器保证，Audit 的 `source` 为
  `database`）；`worker:rotate` 也会把该 Worker 的 Workspace 置为 `WORKER_OFFLINE`，直到 Worker 用新凭据重连。
- 吊销后宿主机上的 Worker 进程与容器仍在运行（平台无法再向它下发命令），Agent 任务不受影响，但用户无法经 Gateway 访问，
  平台模型 key 在网关删除后立即失效。如需停止这些容器，在该主机上执行：

  ```bash
  docker stop $(docker ps -q --filter label=managed_by=worker --filter label=worker_id=<id>)
  ```

- 被吊销 Worker 上的 Workspace 不能删除（Worker 无法确认删除）；要么重新启用该 Worker，要么接受数据留在该主机。
- Audit：`worker.disabled`（含受影响 Workspace 数与吊销的模型 key 数）、`worker.enabled`、`worker.deleted`。

## 3. 空闲回收（idle stop）

- 默认关闭。在 Control Plane 的环境中设置 `IDLE_STOP_AFTER_HOURS`（整数 1～720，建议 24）启用，`IDLE_CPU_THRESHOLD_CORES`
  （默认 0.05 核）为“有计算活动”的阈值；修改后重启 Control Plane。Admin Workers 页首显示当前策略。
- 一个运行中的 Workspace 只有在**同时**满足以下条件并持续 N 小时时才被停止：没有经过 Gateway 的打开连接（浏览器标签页、
  SSE、WebSocket）；N 小时内没有经过 Gateway 的访问；CPU 的 5 分钟平均一直低于阈值。不知道的情况一律算作“有活动”：
  Worker 断开、样本缺失或间断、容器重启，以及 Control Plane 启动后的头 N 小时（重启后窗口重新计时）。
- 只执行 `stop`：文件、会话、模型凭据与 Worker 分配都保留，capacity 名额不释放；卡片显示“因长时间空闲已自动停止”，用户随时
  可再启动。每 5 分钟检查一次，每轮最多停止 10 个；Audit `workspace.idle_stopped`（含时长、阈值、最后访问时间）。
- 停不下来的常见原因：保持打开的 pi-web 标签页（会一直保持连接，这是有意的）；Workspace 中仍在运行的进程（构建、服务、Agent
  任务）；Worker 离线。Admin Workspaces 的“最近访问”列显示最后一次 Gateway 访问。
- 指标：`agent_runtime_idle_policy_enabled`、`agent_runtime_idle_stops_total{result="stopped|skipped_race|failed"}`。
