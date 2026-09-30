# v1.0 Roadmap

状态：已确认（2026-09-30）
基线：`v0.13.0`（`596e7f9`）

本文定义 v0.13 之后到 v1.0 的差距、Phase 顺序、开发节奏和已确认决策。它只规定**范围、顺序和完成
标准**；每个 Phase 开工时，再把该 Phase 的详细设计、API 与验收条目写入 `specs.md` 第 64 节（按
`AGENTS.md` 第 1 节，`specs.md` 是 Phase scope 与验收的权威来源）。

## 1. v1.0 的定义

v0.x 证明了主链可行：多用户、Workspace 隔离、多 Worker 调度、两级认证 Gateway、持久化与恢复、
企业登录与审计。v1.0 的目标是**可以交给企业内部团队长期使用**：

1. **安全边界可信**：容器不能成为访问内网的跳板；单个 Workspace 不能耗尽宿主机资源；认证入口能抵御
   暴力破解。
2. **可运维**：有日志、指标和告警；Runtime 镜像可以升级和回滚；闲置资源可以回收。
3. **可部署**：有生产部署模板和升级手册，不依赖开发者本机的 `tsx watch`。
4. **有企业价值**：模型凭据由平台托管，按用户计量，用户不需要在 Workspace 里自己填 API Key。

同时保持系统精简：**平台不做数据备份**（见第 4 节决策 D5），不引入与 Agent Runtime 基础设施无关的
通用能力。v1.0 仍面向“可信企业内部用户之间的隔离”，不宣称 VM 级隔离或零信任（`AGENTS.md` 第 14 节）。

## 2. 当前差距（2026-09-30 核实）

| # | 差距 | 现状证据 | 优先级 | Phase |
|---|---|---|---|---|
| G1 | 容器出网不受限 | 每 Workspace bridge 为 `Internal: false`，无 iptables/nftables 规则；容器可访问内网与 Worker 宿主机端口 | P0 | 14 |
| G2 | 磁盘无配额 | `/workspace`、`/agent/pi` 为宿主目录 bind mount，无 quota / `StorageOpt`；单个 Workspace 可写满 Worker 磁盘 | P0 | 15 |
| G3 | 登录无限速 | 无 rate limit / lockout 逻辑 | P0 | 15 |
| G4 | 无日志与指标 | Control Plane `Fastify({ logger: false })`；无 `/metrics`；Portal 容量条只是 assignment 数 | P1 | 13、17 |
| G5 | CI 实际未运行 | 仅 `runtime-toolchain.yml`，且只在 PR 触发；日常直接提交 master | P1 | 13 |
| G6 | 模型凭据分散 | 用户在 pi-web 自行配置 key，存于各自 `/agent/pi`；无统一计量与审计 | P1 | 16 |
| G7 | 无空闲回收 | `PI_WEB_IDLE_TIMEOUT_MS=0`；`workspaces.last_activity_at` 只在生命周期操作时更新，不反映 Gateway 访问 | P1 | 18 |
| G8 | 镜像无升级路径 | Worker 要求 runtime image 精确匹配；已有 Workspace 无升级/回滚流程 | P1 | 18 |
| G9 | 无生产部署形态 | `deploy/` 只有开发用 PostgreSQL compose；README 明确未提供生产方案 | P1 | 19 |
| G10 | 代码结构 | `app.ts` 2053 行、`app.test.ts` 3575 行；repository 按 `phaseN.ts` 命名；根目录遗留 `mock_weaver.py` | P2 | 13 |
| G11 | Worker 吊销状态不一致 | `enabled=false` 时周期 offline 检查不处理其 Workspace | P2 | 18 |

原 G9“无备份”已按决策 D5 移出平台范围。

## 3. Phase 规划

编号接续 v0.x 的 Phase 12。顺序原则：**先打工程地基，再补安全边界，再做企业价值，最后是运维与
发布**。每个 Phase 应能在 1～2 周内完成并独立验收。

### Phase 13：工程基线（G4 日志部分、G5、G10）

后续每个 Phase 都依赖可靠的自动验证和可读的代码结构。**不改变任何对外行为。**

- CI 在 push/PR 上运行 typecheck、lint、单元测试、`test:e2e` 和带 PostgreSQL service 的集成测试；
  runtime-toolchain 在 master push 与定时任务上运行。ARM64 是主验证架构；AMD64 由 GitHub 托管
  runner 提供原生证据，没有证据前不宣称支持。
- Control Plane 与 Worker 启用结构化日志，统一 request ID，并对 Cookie、token、password、
  Authorization 头做 redaction。
- 按领域拆分 `app.ts` 路由，repository 按领域重命名；纯重构，以现有测试全绿为准。
- `mock_weaver.py` 移入测试夹具目录。
- 修订 `AGENTS.md` / `specs.md` 中与 v1 冲突的描述（本次路线图确认时已完成主体）。

### Phase 14：Workspace 网络出口控制（G1，P0）

默认“允许公网、拒绝内网”，内网目标按管理员白名单放行（决策 D3）。

- 默认拒绝的目标采用通用内网定义：
  - RFC1918：`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`；
  - Worker 宿主机自身的全部地址；
  - IPv6：保持 Workspace 网络不启用 IPv6；如将来启用，按等价的 `fc00::/7` 下发规则。
- 管理员可配置额外的拒绝网段，供特定部署环境使用（例如存在云 metadata 或 CGNAT 网段时）；默认不包含。
- 白名单只能放行上述内网范围中的具体网段或主机端口，并记审计；**Control Plane、PostgreSQL、Worker
  Gateway、Docker API 等平台管理地址永远不能被放行**（先匹配拒绝，再匹配白名单）。
- Worker 为受管 bridge 下发规则并在 reconciliation 中校验；规则缺失时 fail-closed，不启动 Workspace。
- 预留 Workspace 级模式 `open`（默认）/ `offline`；更细的域名级策略放到 v1.x。

开发环境说明：Clash Verge 与 Tailscale 只存在于开发设备，生产目标环境没有，因此默认规则不针对它们。
开发时需要注意：Clash TUN 模式下容器流量可能经 Clash 代为连接，出口拦截的验收应在关闭 TUN 或确认
容器流量不经 Clash 的条件下进行；Tailscale `100.x` 网段在开发环境中不被默认拦截，这是已知且接受的。

### Phase 15：资源与认证防护（G2、G3，P0）

- **磁盘配额**：每个 Workspace 的持久目录有硬上限，容器可写层与 `/tmp` 同样受限；Portal 显示已用/上限；
  超限只影响该 Workspace。机制（XFS project quota、每 Workspace loop 设备/LVM 卷等）在开工时根据
  ARM64 设备的实际文件系统确认。
- **登录防护**：本地登录按账户与来源 IP 限速，连续失败后临时锁定并记审计；SSO 回调同样限速。
  Local Admin break-glass 不能被锁死。
- 补充 `nofile` 等 ulimit。

**完成 Phase 15 后开始小范围内部试点**（决策 D1）。

### Phase 16：模型网关与凭据托管（G6，P1）

采用现成组件（决策 D4），平台只做集成：

- 候选：LiteLLM Proxy、New API / One API 一类网关。开工时按以下标准选型并记录：ARM64 镜像可用、
  支持虚拟 key 与按 key 计量、支持项目实际使用的模型服务商、能用 PostgreSQL 或自带存储部署、许可证。
- 平台为每个用户/Workspace 通过网关管理 API 签发虚拟 key，注入 Runtime；真实上游 key 只在网关中。
- 用户禁用、session 撤销或 Workspace 删除时，对应虚拟 key 失效。
- Phase 14 出口策略放行网关地址（网关是平台组件，但只暴露推理接口，不暴露管理接口）。
- 先核对 pinned Pi 对自定义 provider / base URL 的实际配置方式，不猜格式。

### Phase 17：可观测性（G4，P1）

- Control Plane 与 Worker 暴露 Prometheus 指标：Workspace 状态分布、Worker 心跳、Gateway 请求量/
  延迟/错误率、命令超时、每个容器的 CPU/内存/磁盘实际用量。
- Portal 的 Worker 与 Workspace 页面显示实际用量。
- 提供示例告警规则与 Grafana 面板。

### Phase 18：生命周期运维（G7、G8、G11，P1）

- **空闲回收**（定义见第 4 节决策 D6）：默认关闭，管理员启用后按保守规则只停不删。
- **Runtime 镜像升级**：Worker 可同时持有多个受支持镜像；Workspace 在停止状态下升级到新镜像（重建
  容器、保留持久目录），失败可回滚。
- 修复 `enabled=false` 的 offline 不一致，提供 `worker:disable` 运维命令。

### Phase 19：生产部署与 v1.0 发布（G9）

- Control Plane、Worker、Portal 的生产镜像或 systemd unit；生产 compose / 部署模板（ARM64 优先）。
- TLS 与 wildcard 证书、反向代理（SPA fallback、WebSocket 超时）配置文档。
- 版本升级流程：数据库迁移、Worker 升级、回滚步骤。
- **数据持久化与外部备份说明**：列出需要由外部工具备份的路径（Worker 的
  `WORKER_MANAGED_ROOT`，默认 `/var/lib/agent-runtime`；Control Plane 的 PostgreSQL），说明一致性
  注意事项与恢复语义（恢复到原 Worker 的原路径；不支持平台内跨 Worker 恢复）。
- 发布前完整回归：全部自动测试、目标环境人工验收、安全复查、文档复核。

## 4. 已确认决策

| # | 决策 |
|---|---|
| D1 | 认可本路线图的优先级与顺序；Phase 15 完成后开始小范围内部试点。 |
| D2 | 主开发与验证环境为 ARM64（Radxa Q8B、Jetson AGX 等低功耗设备），暂无 x86_64 设备；AMD64 只以 CI 原生证据为准。 |
| D3 | 出口默认“允许公网、拒绝内网”，内网按管理员白名单放行。“内网”采用通用定义：RFC1918 与 Worker 宿主机地址；不针对仅存在于开发环境的 Tailscale / Clash 网段。管理员可按部署环境追加拒绝网段。 |
| D4 | 模型网关采用现成组件，平台只做集成。 |
| D5 | **平台不提供备份功能**。备份由虚拟化平台、操作系统或专用备份软件针对挂载点完成；平台负责保持数据布局清晰、文档化，并保证在原路径恢复后 Worker reconciliation 能接管。 |
| D6 | 空闲回收采用保守定义（见下），默认关闭。 |

### D6：空闲的定义

Control Plane 不理解 Pi 协议（`AGENTS.md` 第 5 节），且浏览器断开时 Agent 可能仍在长时间执行任务
（`AGENTS.md` 第 6 节要求此时不得停止）。因此“空闲”必须同时满足以下全部条件，持续达到管理员配置的
时长 N（例如 24 小时）：

1. **无用户连接**：该 Workspace 没有经过 Gateway 的活跃 HTTP 流或 WebSocket 连接（Control Plane 已有
   连接注册表）。
2. **无用户访问**：最近 N 小时没有经过 Gateway 的请求（需新增记录，现有 `last_activity_at` 只在生命
   周期操作时更新）。
3. **无计算活动**：容器 CPU 在整个窗口内持续低于阈值（例如平均 < 2%），由 Worker 采样上报；用于避免
   停掉浏览器已关闭但 Agent 或用户进程（构建、服务）仍在运行的 Workspace。

满足后只执行 `stop`（保留全部数据，记审计），用户可随时再启动。说明：当前 capacity 按 sticky
assignment 计数（STOPPED 也占用），所以空闲回收释放的是内存和 CPU，不释放调度名额。

## 5. 明确不在 v1.0 范围

- 平台内备份、快照与跨 Worker 恢复（D5）
- gVisor / Kata / microVM 运行时
- 非交互任务 API / CI 触发任务 / 定时任务
- Workspace 模板与精简镜像变体、用户选择规格
- 按用户或部门的 Workspace 数量与资源配额
- Control Plane 多实例高可用（需先把 session exchange、OIDC transaction、连接注册表移出进程内存）
- 管理员受控访问用户 Workspace（impersonation）
- 域名级出口策略、完整零信任网络隔离
- Workspace 热迁移、分布式文件系统、Kubernetes、复杂 RBAC、SCIM、计费

## 6. 开发节奏

每个 Phase 按同一流程推进，**上一个 Phase 人工验收通过后才开始下一个**：

1. **开工设计**：在 `specs.md` 第 64 节写入该 Phase 的范围、非目标、API/数据模型变化、验收清单和测试
   计划；涉及 pi-web/Pi 的先核对 pinned upstream；列出需要负责人决定的问题。负责人确认后再写代码。
2. **实现**：在 `phase-NN-<name>` 分支上开发，master 始终是已验收状态。
3. **自动验证**：新增能力必须有测试；安全相关判断要做变异检查（去掉关键判断时测试应失败）；migration
   在真实 PostgreSQL 的独立测试库上验证。
4. **文档同步**：`specs.md`、`progress.md`、README 与相关 runbook 随代码一起更新。
5. **交付说明**：Phase 完成时输出变更总结，并附**逐步可执行的人工验收步骤**（前置条件、操作、预期结果、
   失败时收集哪些信息）。
6. **人工验收**：负责人按步骤在真实环境验证；网络、Docker 等环境级问题按 `AGENTS.md` 第 15 节协同排查。
7. **合入与标记**：验收通过后合入 master，打 `v1.0.0-alpha.N` tag；Phase 19 完成后依次打
   `v1.0.0-rc.1`、`v1.0.0`。
