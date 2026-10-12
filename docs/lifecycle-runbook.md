# Lifecycle Runbook

Phase 18（`specs.md` 第 64 节 Phase 18）的运维说明：Runtime 镜像的上架、切换默认、升级与回滚、下线；Worker 的吊销、
重新启用与删除。设计与验收见 `specs.md` 18.4–18.6、18.15。

## 1. Runtime 镜像

### 1.1 概念

- **Runtime 镜像** = 镜像引用（tag）+ digest + 镜像标签 `io.agent-runtime.runtime.version`（另有 `pi-web.version`、
  `pi.version`，Portal 显示）。**同一 tag 永不重建**：内容变化就用新 tag 与新 runtime version。
- 每台 Worker 用 `RUNTIME_IMAGES` 列出它提供的镜像（1～4 个），每项按 digest pin：

  ```bash
  RUNTIME_IMAGES=agent-runtime:phase7-toolchain@sha256:<digest>,agent-runtime:phase18-pi1.1@sha256:<digest>
  ```

  digest 取 `docker image inspect <tag> --format '{{.Id}}'`（containerd 镜像存储下与 `RepoDigests` 相同）。本地构建的镜像在
  不同 Worker 上 digest 不同，各自填写。`RUNTIME_IMAGE`（单镜像、不 pin）只在过渡期保留，与 `RUNTIME_IMAGES` 不能同时设置。
- Worker 每次连接前逐个校验：tag 必须解析到 pin 的 digest、平台为本机架构、有版本标签、版本互不重复；不满足的镜像**不提供**
  （日志 `not offered` 说明原因），全部不满足时 Worker 不连接。每个提供的镜像都跑一次 capability 探针。
- 已有容器始终用创建它的那个镜像 ID 运行；tag 被改指向其他内容不影响运行中的 Workspace，只影响之后新建的容器（届时该镜像
  已不被提供）。
- Control Plane 的 `DEFAULT_RUNTIME_IMAGE` 决定新 Workspace 的镜像和“升级”的目标。

### 1.2 构建与验证

```bash
docker build --platform linux/arm64 --tag agent-runtime:<新 tag> runtime
runtime/scripts/verify-image.sh agent-runtime:<新 tag> arm64
docker image inspect agent-runtime:<新 tag> --format '{{.Id}} {{json .Config.Labels}}'
pnpm test:e2e:runtime                      # 真实 Docker：生命周期、Session、Files、持久化、新旧镜像切换
TEST_DOCKER_RUNTIME=1 pnpm --filter @agent-runtime/worker exec vitest run src/model-relay/catalog.docker.test.ts
```

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
