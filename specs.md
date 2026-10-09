# specs.md

# 面向企业私有环境的容器化安全隔离智能体任务执行平台

**Product & Technical Specification**

版本：`1.0 规划`
状态：Phase 0–12 与 v0.13 Portal 调整已实现并验收（tag `v0.13.0`）；v1.0 按 Phase 13–19 推进，
见第 64 节与 `docs/v1-roadmap.md`
核心依赖：`pi-web + pi-agent + Docker`

## 阅读指引

- 第 1–54 节是长期有效的产品与架构规范；其中凡与 v1.0 计划相关的内容已按 v1 改写，并标注对应 Phase。
  **标注为“Phase NN 实现”的能力在该 Phase 完成前尚未存在**，不要按已实现处理。
- 第 55、56、61、62 节是 v0.x 的开发与验收历史，保留作为回归基线，不再代表待办范围。
- 第 64 节是 v1.0 各 Phase 的范围与验收；第 65 节是 Phase 开发流程。
- 文中“MVP”指 v0.x 确立的基线设计（如 Host routing、sticky placement、本地持久存储、不引入 Redis）。
  除非本文已标注 v1 变更或第 64 节另有规定，这些约束在 v1.0 继续有效。
- 如本文件内部仍有表述冲突，以第 64、65 节和 `docs/v1-roadmap.md` 为准，并在发现时修正本文件。

---

# 1. 项目背景

当前常见 Web AI 系统通常采用：

```text
Web UI
  -> LLM API
  -> 少量 Tool / Workflow
```

这类系统适合问答、RAG 和固定业务流程，但在复杂工程任务中，Agent 往往需要真正使用：

- shell
- Git
- Python
- Node.js
- Rust
- 编译工具链
- ffmpeg
- PDF 工具
- LibreOffice
- Playwright
- Chromium
- 各类 CLI 软件
- 项目目录和长期持久文件

因此，本项目不准备把智能体限制在少量预定义 Tool 中，而是为每个用户提供一个完整、持久、隔离的 Linux Agent Workspace。

核心理念：

> **不是给大模型挂几个工具，而是给智能体提供一台隔离的计算机。**

---

# 2. 与 pi-web 的关系

本项目明确采用：

`https://github.com/agegr/pi-web`

作为 Workspace 内部的 Agent Web Runtime。

pi-web 已经处理了大量 Web Wrapper 细节，因此本项目不重复造轮子。

## 2.1 原则

pi-web 负责它擅长的部分：

```text
Pi Session
Chat
Streaming
Tool rendering
Terminal
Files
Git
Pi RPC
Session resume
Model / Agent config
```

本项目负责 pi-web 没有解决、也不应该由单用户 Web Wrapper 解决的部分：

```text
Multi-user
Auth
Authorization
Container isolation
Workspace lifecycle
Worker fleet
Multi-host scheduling
Resource limits
Gateway
Security boundary
Infrastructure audit
```

因此，本项目不是：

> 再写一个 pi-web。

而是：

> **把成熟的单用户 Pi Web Runtime 封装成可供企业多用户安全使用的容器化 Agent Workspace。**

---

# 3. 产品定位

项目名称：

# 面向企业私有环境的容器化安全隔离智能体任务执行平台

可选英文名：

**Containerized Agent Runtime Platform**

核心产品对象不是 Chat，而是：

# Workspace

一个 Workspace 相当于：

> 一台专门提供给 Agent 使用的持久 Linux 工作机。

---

# 4. 核心数据模型

MVP 采用：

```text
User
  ├── Workspace A
  │     ├── Docker Container
  │     │     └── pi-web
  │     │           └── pi-agent
  │     │
  │     └── Pi Sessions
  │           ├── Session 1
  │           ├── Session 2
  │           └── Session 3
  │
  └── Workspace B
        └── ...
```

关键定义：

```text
Platform Workspace != Pi Session
```

MVP：

```text
1 Workspace
  = 1 persistent filesystem
  = 1 Docker Container allocation
  = 1 pi-web instance
```

一个 Workspace 内部允许存在多个 Pi Session。

这样用户：

> 新开一个聊天

不会导致：

> 新建一个完整 Docker Runtime。

---

# 5. 为什么采用 Workspace 而不是 Session Container

完整 Runtime Image 可能包含：

- Office
- Chromium
- Playwright
- Rust
- Node
- Python
- ffmpeg
- 编译工具

如果：

```text
1 Pi Session = 1 Container
```

会带来：

- 大量重复 Container
- Workspace 文件不方便共享
- 同一项目每次聊天都重建 Runtime
- 资源浪费
- 生命周期过于碎片化

因此采用：

```text
1 Project-like Workspace
  -> N Pi Sessions
```

更符合真实 CLI Agent 使用方式。

---

# 6. 典型用户体验

用户登录平台后看到：

```text
我的 Workspace

network-sim
document-work
rust-project
```

点击：

```text
network-sim
```

平台：

1. 检查 Workspace 所属 Worker。
2. 如果 Container 未运行，则启动。
3. 确认 pi-web 健康。
4. Gateway 代理用户进入该 Workspace。
5. 用户看到正常 pi-web UI。
6. pi-web 内部继续管理 Pi Session。

用户体验应接近：

> 独占一台远端 CLI Agent 工作机。

但底层实际是：

> 多租户 Docker Runtime。

---

# 7. 典型任务

## 7.1 软件研发

```text
打开 repo
-> 分析项目
-> 安装依赖
-> 修改代码
-> cargo test / pytest / pnpm test
-> 生成报告
```

## 7.2 PDF / Office

```text
读取 PDF
-> pdftotext
-> Python 分析
-> LibreOffice 转换
-> 生成新文档
```

## 7.3 音视频

```text
ffprobe
-> ffmpeg
-> Python
-> 生成结果
```

## 7.4 Browser Agent

```text
Playwright
-> Chromium
-> 浏览网站
-> 下载数据
-> Python 处理
-> 输出报告
```

## 7.5 混合任务

```text
Browser
 -> download
 -> PDF
 -> Python
 -> ffmpeg
 -> Office
 -> report
```

无需为每一个步骤在平台侧开发专用 Tool。

Agent 可以直接使用 Runtime 中的 CLI。

---

# 8. 总体架构

```text
                           Browser
                              |
                              | HTTPS
                              v
+--------------------------------------------------------------+
|                    Control Plane / Gateway                   |
|                                                              |
|  Login / Auth                                                |
|  User                                                        |
|  Workspace API                                               |
|  Scheduler                                                   |
|  Worker Registry                                             |
|  Reverse Proxy                                               |
|  Admin UI                                                    |
|                                                              |
+-----------------------------+--------------------------------+
                              |
                              | authenticated persistent WS
                              |
              +---------------+----------------+
              |                                |
              v                                v
+-----------------------------+  +-----------------------------+
| Worker Host A               |  | Worker Host B               |
|                             |  |                             |
| Worker Daemon               |  | Worker Daemon               |
| Docker Engine               |  | Docker Engine               |
|                             |  |                             |
| +-------------------------+ |  | +-------------------------+ |
| | Workspace A             | |  | | Workspace B             | |
| |                         | |  | |                         | |
| | pi-web                  | |  | | pi-web                  | |
| | pi-agent                | |  | | pi-agent                | |
| | Python / Node / Rust    | |  | | Python / Node / Rust    | |
| | ffmpeg / PDF / Office   | |  | | ffmpeg / PDF / Office   | |
| | Playwright / Chromium   | |  | | Playwright / Chromium   | |
| +-------------------------+ |  | +-------------------------+ |
+-----------------------------+  +-----------------------------+
```

---

# 9. 部署形态

## 9.1 单机开发模式

```text
Host
├── Control Plane
├── PostgreSQL
├── Worker
└── Docker
    ├── Workspace A
    └── Workspace B
```

虽然单机运行，Control Plane 和 Worker 仍保持独立。

不得为了开发方便绕开 Worker。

---

## 9.2 多机部署

推荐：

```text
Host 1
├── Control Plane
├── Web
└── PostgreSQL

Host 2
├── Worker A
└── Docker

Host 3
├── Worker B
└── Docker
```

如果只有两台：

```text
Host 1
├── Control Plane
├── PostgreSQL
└── Worker A

Host 2
└── Worker B
```

也可以证明跨主机执行能力。

当前开发与验证设备均为低功耗 ARM64 主机（如 Radxa Q8B、Jetson AGX）。开发设备之间可能通过
Tailscale（`100.64.0.0/10` 地址）组成虚拟局域网，并可能运行 Clash Verge（TUN 或系统代理模式）；这些只
存在于开发环境，生产目标环境是通用企业内网，平台设计不依赖也不针对它们。开发中排查网络问题时需考虑
这些因素，见 `AGENTS.md` 第 15 节。

---

# 10. Control Plane

Control Plane 是多用户平台核心。

负责：

- Auth
- User
- Workspace metadata
- Worker registry
- Scheduling
- Workspace lifecycle command
- Reverse Proxy
- WebSocket Proxy
- Admin UI
- 基础平台 Audit
- Artifact authorization

不负责：

- Pi Agent Loop
- Pi RPC parsing
- Tool Call rendering
- Pi Session history
- Pi conversation database
- Terminal protocol
- pi-web 内部前端状态

这些尽量由 pi-web 负责。

---

# 11. Worker

每台 Agent 运行主机部署 Worker。

Worker 使用本机：

```text
/var/run/docker.sock
```

管理 Docker。

但该 socket：

- 只允许 Worker 使用
- 不允许 Runtime Container 挂载
- 不允许远程网络直接访问

Worker 主动连接：

```text
Worker -> Control Plane
```

推荐协议：

```text
authenticated WebSocket
```

---

# 12. 为什么 Worker 主动连接 Control Plane

不采用：

```text
Control Plane -> Docker Remote TCP API
```

原因：

1. Docker API 权限过大。
2. 暴露 Docker TCP API 风险高。
3. 多主机需要处理防火墙。
4. Worker 可以提供严格的业务命令边界。
5. Worker control channel 由 Worker 主动连接，在 NAT 后更容易建立。

第 5 点只适用于 control channel。MVP 的 HTTP/WebSocket data path 仍要求 Control
Plane 能访问 Worker Gateway；可使用受保护 LAN、Tailscale 或等价私网，但不能把
Worker Gateway 公开给最终用户。如果实际网络无法提供该可达性，应暂停联调并记录
网络证据，不得临时改成 Docker Remote API，也不得未经 ADR 改成通用 byte tunnel。

Control Plane 只发：

```text
workspace.ensure
workspace.start
workspace.stop
workspace.delete
workspace.inspect
```

而不是：

```text
docker run ...
```

---

# 13. Worker 注册

Worker 启动后发送：

```text
worker_id
hostname
architecture
runtime_image
runtime_version
capabilities
max_workspaces
allocated_workspaces
CPU
Memory
```

示例 capability：

```json
{
  "browser": true,
  "office": true,
  "ffmpeg": true,
  "python": true,
  "node": true,
  "rust": true
}
```

Heartbeat 建议：

```text
10 s
```

Offline threshold：

```text
30-45 s
```

这些参数都应配置化。

MVP 不使用所有 Worker 共用的 bearer token。每个 Worker 使用独立 credential，
Control Plane 必须将 credential 绑定到预注册的 `worker_id`；`worker.hello` 中自报的
ID 不得覆盖该绑定。Worker Gateway 地址也属于管理员配置或预注册信息，不能直接信任
未认证消息中的任意 URL，否则会形成 SSRF 或错误路由入口。

Phase 2 的 credential rotation 采用单一当前 credential：数据库原子替换 token hash 并
清空旧 heartbeat。握手与每条后续消息都校验当前 hash，因此旧 token 立即不能新建连接，
已有旧连接最迟在下一条消息或 heartbeat 时关闭。数据库和 Admin API 不返回原始 token。

---

# 14. Workspace 调度

Workspace 第一次启动：

```text
Workspace
  -> Scheduler
  -> Worker
```

候选 Worker：

- ONLINE
- enabled
- schedulable（未被 admin 暂停调度）
- 当前 Control Plane 上存在 authenticated control channel
- heartbeat 未超过 offline threshold
- 未超容量
- architecture compatible
- runtime image compatible
- capability compatible

`enabled` 与 `schedulable` 语义不同，不得混用：

- `enabled = false`：吊销 Worker。control channel 握手与后续消息被拒绝，Gateway 不再路由，其 sticky
  Workspace 全部不可用；当前只能由运维直接修改数据库，Portal 不提供入口。
- `schedulable = false`：暂停调度（cordon）。Worker 身份、control channel、Gateway 路由和已分配的
  sticky Workspace 均不受影响，可照常 start/stop/open/delete；只是不再参与新 Workspace 的首次
  placement。admin 可在 Portal 随时暂停或恢复，并记录 `worker.scheduling_paused/resumed` Audit。
  暂停与首次 placement 共用 scheduler advisory lock，避免与进行中的 reservation 交错。

Phase 5 的 capacity authoritative source 固定为 Control Plane PostgreSQL 中已有的
sticky assignment 数量：

```text
count(workspaces.worker_id = worker.id)
```

计数包含 STOPPED、ERROR、WORKER_OFFLINE 等仍占有该 Worker 本地持久 Runtime 的 Workspace；
只有 destructive delete 确认完成并删除 metadata 后才释放 assignment。Worker heartbeat 中的
`allocated_workspaces` 是本机观测 telemetry，可能滞后，不作为新 placement 的 reservation 或
capacity 真相。

首次 placement 必须在 PostgreSQL 短事务中完成“读取 authoritative assignment count、选择
Worker、写入 sticky `worker_id`”的原子 reservation，并发请求不能共同占用最后一个 slot。

Phase 5 load score：

```text
authoritative_assigned_workspaces / max_workspaces
```

选择最低值；score 相同时按 Worker ID 升序做 deterministic tie-break。runtime compatibility
在当前 Workspace 数据模型中指 `workspaces.runtime_image == workers.runtime_image` 的精确匹配；
`runtime_version` 继续作为 Worker 镜像内容版本的观测字段，不替代 Workspace 声明的 image
identity。

---

# 15. Sticky Placement

一旦：

```text
workspace.worker_id = worker-a
```

MVP 不再自动改变。

如果 Worker A Offline：

```text
Workspace state = WORKER_OFFLINE
```

不自动：

```text
复制目录
-> Worker B
-> 再拉 Container
```

因为那已经进入：

- Distributed Storage
- Migration
- State Replication

范围。

未来再做。

---

# 16. Workspace 生命周期

状态：

```text
CREATED
SCHEDULING
STARTING
RUNNING
STOPPING
STOPPED
DELETING
ERROR
WORKER_OFFLINE
```

说明：

### CREATED

数据库存在，未分配 Worker。

### SCHEDULING

正在寻找 Worker。

### STARTING

Worker 正在准备 Container / pi-web。

### RUNNING

Workspace 可以代理访问。

### STOPPING

正在停止。

### STOPPED

Container 停止，但持久数据存在。

### DELETING

Control Plane 已授权 destructive delete，正在等待 assigned Worker 确认 managed
Container 与 managed persistent directory 均已删除。失败时 metadata 必须保留，并进入
`ERROR` 或可重试的显式失败结果；只有 Worker 明确成功后才删除平台 metadata。

### WORKER_OFFLINE

Workspace 数据仍归属于原 Worker，但当前不可访问。

---

# 17. pi-web 集成方式

Workspace Container 内直接运行：

```text
pi-web
```

pi-web 使用本地：

- workspace
- Pi state
- Pi session data
- Terminal
- Git
- Agent

平台不需要直接操作 Pi RPC。

---

# 18. pi-web upstream 原则

实现前必须检查当前 pin 版本 pi-web 源码和 README。

重点确认：

- 启动参数
- listen address
- base path 支持
- WebSocket path
- session storage
- config storage
- terminal
- file serving
- Git/worktree
- Pi 配置目录
- static asset URL
- reverse proxy compatibility

MVP Runtime 启动 pi-web 时应显式关闭自动打开浏览器，并将 Pi state 指向持久目录。当前 upstream 可使用：

```text
PI_WEB_NO_OPEN=1
PI_CODING_AGENT_DIR=/agent/pi
```

`PI_WEB_HOSTNAME`、`PI_WEB_ALLOWED_HOSTS`、认证和 idle timeout 的最终值必须结合 Gateway/Worker 网络方案，在当前 pinned version 上验证后确定；不要依赖默认值碰运气。

如发现问题：

## 第一优先

通过配置解决。

## 第二优先

Gateway rewrite。

## 第三优先

对 pi-web 做最小 patch。

## 最后

才考虑自己重新实现相关功能。

---

# 19. Gateway

用户不直接访问 Worker。

公开 URL 示例：

```text
https://<workspace-id>.agent.example.internal/
```

请求流程：

```text
Browser
  |
  v
Gateway
  |
  +-- authenticate
  |
  +-- load workspace
  |
  +-- check workspace.user_id == current_user.id
  |
  +-- resolve worker / runtime endpoint
  |
  +-- reverse proxy
  v
pi-web
```

---

# 20. WebSocket

pi-web streaming / terminal 很可能依赖 WebSocket。

Gateway 必须完整支持：

```text
Connection: Upgrade
Upgrade: websocket
```

并处理：

- auth
- ownership
- long-lived connection
- upstream disconnect
- Worker offline
- pi-web restart

不能只实现普通 HTTP proxy。

---

# 21. Reverse Proxy 方案

MVP 可选两种方式。

## 方案 A：Control Plane 内置 Proxy

优点：

- auth 逻辑统一
- 最简单 Demo
- Workspace resolution 灵活

## 方案 B：独立 Gateway

例如：

```text
Control Plane
 -> dynamic routing data
Gateway
 -> reverse proxy
```

MVP 优先 A。

不要一开始引入复杂 Service Mesh。

---

# 22. Runtime Image

Runtime 应接近一台常用 CLI Linux Workstation。

## 22.1 Base

```text
bash
coreutils
findutils
procps
file
tree
less
curl
wget
ca-certificates
git
openssh-client
jq
ripgrep
fd
zip
unzip
tar
xz
```

## 22.2 Build

```text
gcc
g++
make
cmake
pkg-config
```

## 22.3 Python

```text
python3
uv
pip
```

## 22.4 Node

```text
node
corepack
pnpm
```

## 22.5 Rust

```text
rustc
cargo
rustup
```

## 22.6 PDF / Document

```text
poppler-utils
pandoc
libreoffice --headless
```

加基础中英文字体。

## 22.7 Media

```text
ffmpeg
ffprobe
```

## 22.8 Browser

```text
Playwright
Chromium
```

以及运行依赖。

## 22.9 Agent

```text
pi-agent
pi-web
```

---

# 23. Runtime Image 版本

必须 pin：

- pi-web version/commit
- Pi version
- Node version major
- Playwright version

Worker 上报：

```text
runtime_image
runtime_version
```

避免：

```text
Control Plane 认为能力一致
但不同 Worker 镜像内容不同
```

---

# 24. Multi-arch

目标：

```text
linux/amd64
linux/arm64
```

v1.0 的主验证架构是 `linux/arm64`（当前全部开发与 Worker 设备均为 ARM64）。`linux/amd64` 保持可构建，
但只有在 CI 原生 runner 或真实 AMD64 Worker 上取得验证证据后才宣称支持。

建议用 Docker Buildx：

```text
docker buildx build --platform linux/amd64,linux/arm64 ...
```

但 Browser / LibreOffice / Pi 等必须分别测试。

若某架构某 capability 不可用：

```text
capability=false
```

Scheduler 据此避免错误调度。

---

# 25. Container 安全基线

禁止：

```text
--privileged
--network host
-v /:/host
-v /var/run/docker.sock:/var/run/docker.sock
```

推荐：

```text
non-root user
memory limit
cpu limit
pids limit
managed Docker network
managed bind mount
```

“managed Docker network”不能是所有租户共享且可互访的普通 bridge。每个 Workspace
必须使用独立的 user-defined bridge（或经过等价隔离验证的实现），不得加入 Worker/
Control Plane management network，也不得直接解析或连接其他 Workspace Container。
宿主机发布的 pi-web 端口必须只绑定 `127.0.0.1`，并测试 Workspace A 无法连接 Workspace B 的 pi-web、
宿主机 loopback upstream 或 Worker Gateway 管理入口。出站访问遵循第 44 节：v1.0 默认允许公网、
拒绝内网（Phase 14 实现）。

---

# 26. Runtime User

正常运行：

```text
user = agent
uid ~= 1000
```

Workspace 目录归该 UID 所有。

MVP 不需要在 Runtime 内提供通用 sudo。

常用依赖预装进 Image。

如未来要做：

> sudo / apt approval

再单独设计 Human-in-the-loop。

---

# 27. 持久文件

Worker：

```text
/var/lib/agent-runtime/
└── workspaces/
    └── <workspace-uuid>/
        ├── workspace/
        ├── pi/
        └── metadata/
```

Container：

```text
/workspace
/agent/pi
```

当前 pi-web upstream 明确使用 Pi 的 agent data，并支持通过 `PI_CODING_AGENT_DIR` 指定目录。因此 MVP 优先显式设置：

```text
PI_CODING_AGENT_DIR=/agent/pi
```

Workspace 文件持久化到 `/workspace`。

**不要预设一个独立 `/agent/pi-web` 持久目录。** 只有当前 pinned pi-web 版本源码确认存在额外、必须持久化且不属于 Pi agent data 的状态时，才新增并记录该目录。

最终路径仍必须以实际 pinned version 的源码与集成测试为准。

---

# 28. 为什么数据保存在 Worker 本地

MVP 使用 local persistent storage：

优点：

- 简单
- 性能好
- 不依赖 NAS / Ceph / NFS
- 容易 Demo

代价：

- Workspace 与 Worker 绑定
- Worker 离线时 Workspace 不可访问
- 不能热迁移

这在 v1.0 仍然接受。

**平台不提供备份、快照或跨 Worker 恢复功能**（v1 决策 D5）。备份由虚拟化平台、操作系统或专用备份
软件针对挂载点完成。平台的责任是：

- 全部持久状态只位于两处：Worker 的 `WORKER_MANAGED_ROOT`（默认 `/var/lib/agent-runtime`）与
  Control Plane 的 PostgreSQL；
- 在部署文档中说明需要备份的路径、一致性注意事项（运行中备份可能拿到写入中途的文件，建议先停止
  Workspace 或使用文件系统快照）与恢复语义；
- 保证把数据恢复到**原 Worker 的原路径**后，Worker reconciliation 能正常接管；跨 Worker 恢复不在
  平台范围内。

---

# 29. 用户与权限

基础 role 保持：

```text
user
admin
```

User：

- 管理自己的 Workspace
- 访问自己的 pi-web
- 启动/停止自己的 Runtime

Admin：

- 查看 Worker
- 查看 Workspace placement
- disable Worker scheduling
- 查看用户列表与用户状态
- 创建 Local User
- enable / disable User
- 修改 `user/admin`
- 重置 Local User 密码
- revoke User sessions
- 查看某用户的 Workspace metadata

Admin **不因 admin role 自动获得用户 Workspace 内容访问权**。已有 Workspace ownership 边界保持不变；如果未来需要 support impersonation / break-glass content access，必须另做显式设计与 Audit，不在 Phase 9–12 范围。

用户删除不是日常管理动作。Phase 9–12 以：

```text
active
disabled
```

作为用户生命周期主状态。避免因为删除 User 连带破坏 Workspace、Audit 与历史 metadata。

---

# 30. Authentication

平台支持两类登录入口：

```text
Local Account
External Identity Provider
```

Local Account 延续 Phase 1 已有用户名/邮箱 + 密码登录。

External Identity Provider：

```text
OIDC                <- 标准路径，Phase 10
OAuth2 + UserInfo   <- 兼容路径，仅在 Phase 11 有明确需要时实现
```

认证与授权边界固定为：

```text
OIDC / OAuth2
    |
    v
External Identity
    |
    v
Platform User
    |
    v
Platform server-side session
    |
    v
Authorization / Workspace ownership
```

**IdP token 不是平台内部通用 session。**

OIDC/OAuth2 完成后，后续 Portal API、Workspace Host、Gateway、HTTP/WebSocket proxy 仍使用平台自己的 server-side session 和既有 Workspace ownership 逻辑。

Local 与 External login 共同要求：

- modern password hash（Local Account）
- HTTP-only cookie
- HTTPS 时 Secure
- CSRF 策略与 Auth 方式匹配
- Server-side ownership check
- `users.status=disabled` 必须 fail-closed
- session revoke 必须立即使服务端 session 无效

由于 Portal 与 `<workspace-id>.agent.example.internal` 分属不同 Host，平台继续沿用既有 session exchange 设计，不因为引入 OIDC 改成宽域 Cookie：

1. Portal 登录建立 server-side session，并设置 `Secure`、`HttpOnly`、`SameSite=Lax`
   的 `__Host-` host-only Cookie；
2. Open Workspace 时，Portal 签发短时、单次使用且绑定 user/workspace 的 exchange code；
3. 浏览器以 top-level POST 将 code 交给该 Workspace Host 上由 Gateway 截获的
   `/_platform/session`；Gateway 校验后设置该 Host 自己的 `__Host-` Cookie，并返回禁止缓存、
   禁止嵌入且只允许 nonce script 的最小 Workspace-origin bootstrap HTML；该页面以
   `location.replace("/")` 发起新的同源导航，避免跨站 POST 的 redirect chain 污染后续
   `Sec-Fetch-Site`；
4. exchange code 不放入 query string，不进入 pi-web、访问日志或 Referer；
5. Gateway 保留平台 Cookie 名称空间，不能允许 upstream `Set-Cookie` 覆盖平台 session；
6. 平台 state-changing API 校验 CSRF token 与 canonical `PORTAL_ORIGIN` 加可选
   `PORTAL_ALLOWED_ORIGINS` allowlist 中的 exact-match `Origin`（不允许 wildcard 或 `*`），
   WebSocket upgrade 校验 session、`Origin`、Host 与 Workspace ownership。

服务端注销、User disable 或 session revoke 后，Portal 和各 Workspace Host 的 Cookie 即使仍存在也不得继续获得访问权限。

Runtime 内 pi-web 的 `PI_WEB_PASSWORD` 默认不启用。平台用户只登录一次，由 Control Plane / Gateway 完成身份认证和 Workspace ownership 授权。

该设计依赖网络边界：用户不能直接访问 pi-web，也不能绕过 Control Plane 直接访问 Worker Gateway。

## 30.1 OIDC 固定原则

Phase 10 先支持 **一个 Generic OIDC Provider**，不要一开始设计 multi-provider framework。

要求使用：

```text
Authorization Code Flow
PKCE
state
nonce
issuer validation
audience/client_id validation
redirect URI exact match
```

External Identity 的稳定键：

```text
(provider_id, subject)
```

其中 `subject` 对应 OIDC `sub`。

禁止：

```text
email == identity primary key
```

email、display name 只作为 profile snapshot / display data；不得因为 email 相同就静默把两个外部身份合并成同一 Platform User。

OIDC Provider 第一版优先通过服务端配置 / environment 配置，不要求先做 Provider CRUD UI。client secret 不得返回 Browser、写入 Audit details 或注入 Workspace。

## 30.2 Local Admin / break-glass

平台必须保留至少一个可用的 Local Admin 管理入口。

引入 OIDC 后不得出现：

> IdP 配置错误 / IdP 故障 -> 所有管理员都无法登录 -> 无法修复 IdP 配置

Phase 9–12 不要求自研 MFA；如企业要求 MFA，应交给上游 IdP。

---

# 31. 数据模型

既有主键与 Workspace ownership 不重构，以增量 migration 为主。

## users

建议在当前 users 基础上补齐：

```text
id uuid
email text nullable
username text nullable
display_name text nullable
password_hash text nullable
role text                  # user | admin
status text                # active | disabled
last_login_at nullable
created_at
updated_at
```

约束：

- Local User 必须存在可登录的 local identifier 与 `password_hash`。
- External-only User 可以没有 `password_hash`。
- `role` 与 `status` 属于 Platform User，而不是由 IdP token 每次直接覆盖。
- External Identity 默认创建/绑定后 role 仍为 `user`，除非平台 admin 显式修改。

具体字段命名应优先兼容当前已实现 schema；如果代码现状与上述名称不同，使用最小 migration 保持语义，不为了文档重命名既有字段。

## user_identities

Phase 10 新增：

```text
id uuid
user_id uuid
provider_id text
provider_subject text
email_snapshot text nullable
display_name_snapshot text nullable
created_at
last_login_at nullable
```

必须有：

```text
UNIQUE(provider_id, provider_subject)
```

不要对 `email_snapshot` 做身份唯一约束。

Phase 10 单 Provider 时 `provider_id` 仍保留，避免以后 migration 时把 identity 语义重新拆表。

## auth provider configuration

Phase 10 第一版优先通过服务端配置：

```text
AUTH_OIDC_ENABLED
AUTH_OIDC_ISSUER
AUTH_OIDC_CLIENT_ID
AUTH_OIDC_CLIENT_SECRET
AUTH_OIDC_AUTO_PROVISION
```

Provider secret 不进入普通数据库 API / Browser。

如果 Phase 11 后确有 multi-provider 管理需求，再独立设计 `auth_providers` 表；不要在 Phase 10 提前实现。

## workers

```text
id text
hostname text
architecture text
status text
enabled bool
schedulable bool
runtime_image text
runtime_version text
gateway_base_url text
capabilities jsonb
max_workspaces int
allocated_workspaces int
cpu_capacity jsonb
memory_bytes bigint
last_heartbeat_at
created_at
updated_at
```

## workspaces

```text
id uuid
user_id uuid
name text
worker_id text nullable
state text
desired_state text
runtime_image text
required_architecture text nullable
required_capabilities jsonb
created_at
updated_at
last_activity_at
```

## platform_audit_events

仅保存追加式平台基础设施与认证管理事件：

```text
id bigint cursor
event_type
actor_user_id nullable
owner_user_id nullable
workspace_id nullable
worker_id nullable
details jsonb
created_at
```

既有例如：

```text
workspace.created
workspace.scheduled
workspace.running
workspace.stopped
workspace.opened
workspace.deleted
worker.runtime_reported
worker.offline
```

Phase 12 增加例如：

```text
auth.login_succeeded
auth.login_failed
auth.logout
auth.session_revoked
user.created
user.enabled
user.disabled
user.role_changed
user.password_reset
identity.bound
identity.unbound
```

Worker 调度管理增加：

```text
worker.scheduling_paused
worker.scheduling_resumed
```

两者由 admin 请求在同一事务内写入，`actor_user_id` 为操作者，`details` 只含 requestId、IP 与截断
User-Agent。暂停调度不改变 `workers.status`，因此不会产生 `worker.offline/disabled` 状态事件。

Workspace/Worker 的数据库生命周期事件与状态变更在同一事务追加，避免状态已经生效但 Audit 漏记。
Workspace 删除后 Audit 仍保留，因此 subject ID 不作为级联删除外键。普通用户只能查询
`owner_user_id` 为自己的 Workspace 事件；admin 可以查看平台事件。

`details` 只允许平台控制的结构化 metadata，不得保存：

- Cookie
- session token / exchange code
- password / password hash
- OIDC authorization code
- access token / refresh token / ID token 原文
- OAuth/OIDC client secret
- Prompt
- Pi message/tool stream
- 文件内容

## artifacts

可选：

```text
id
workspace_id
relative_path
display_name
mime_type
size_bytes
created_at
```

---

# 32. API

## Auth

既有：

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/me
```

Phase 10 新增：

```text
GET /auth/oidc/login
GET /auth/oidc/callback
```

具体 callback path 可以根据当前 Web 框架约定调整，但必须固定、可配置为 IdP exact redirect URI，不允许 open redirect。

Phase 11 如实现 OAuth2 compatibility，应与 OIDC adapter 边界分离，不要把不同协议验证逻辑揉成一个宽松 callback。

## Admin Users

Phase 9 增加语义等价 API：

```text
GET    /api/admin/users
POST   /api/admin/users
PATCH  /api/admin/users/:id
POST   /api/admin/users/:id/reset-password
POST   /api/admin/users/:id/revoke-sessions
GET    /api/admin/users/:id/workspaces
```

具体 REST path 可按现有代码风格微调，但必须覆盖：

- list
- create Local User
- enable / disable
- role change
- password reset
- session revoke
- read-only Workspace metadata lookup

禁止通过通用 PATCH 暗中支持 user destructive delete。

Phase 11 identity management 可增加：

```text
GET    /api/admin/users/:id/identities
POST   /api/admin/users/:id/identities/...     # 仅在有明确人工绑定流程时
DELETE /api/admin/users/:id/identities/:identityId
```

所有 identity bind/unbind 必须有严格 authorization 与 Audit。

## Workspace

```text
GET    /api/workspaces
POST   /api/workspaces
GET    /api/workspaces/:id
DELETE /api/workspaces/:id

POST   /api/workspaces/:id/start
POST   /api/workspaces/:id/stop
```

操作语义：

- `start`：启动已有 Workspace Runtime；如尚未 placement，则按当前 Phase 的 Worker 选择规则分配。
- `stop`：停止 Container/pi-web，但保留 persistent Workspace、Pi Session 数据与数据库 metadata。
- `DELETE /api/workspaces/:id`：destructive delete。必须删除本系统 managed Container、该 Workspace 的 managed persistent directory 与平台 metadata。

`DELETE` 不等同于 `stop`。

如果 assigned Worker Offline，Control Plane 无法确认底层 managed persistent directory 已删除时，不得返回“删除成功”。MVP 应拒绝该操作并返回可识别的 conflict/unavailable error，待 Worker 恢复后再执行。

## Admin

```text
GET /api/admin/workers
PATCH /api/admin/workers/:id      { "schedulable": boolean }
GET /api/admin/workspaces
```

`GET /api/admin/workspaces` 仅 admin 可用，返回全平台 Workspace 的只读 metadata 与所有者
（`owner.id/username/email`），不含 runtime image、Runtime 内容或 open/exchange 能力；admin 打开他人
Workspace 仍按不可见资源拒绝。响应禁止缓存。

`PATCH /api/admin/workers/:id` 仅 admin 可用，要求可信 Origin 与 CSRF；body 严格只接受
`schedulable`，不能修改 `enabled`、capacity 或 credential。重复设置相同值是幂等的，不追加 Audit。

## Audit

```text
GET /api/audit-events?limit=30&before=<event-id>
    &category=workspace|worker|auth|user|identity
    &userId=<uuid>&workspaceId=<uuid>&workerId=<id>
    &from=<ISO datetime>&to=<ISO datetime>
```

返回倒序、cursor pagination 的结构化平台事件。普通用户只看到自己的 Workspace 事件；admin 可看到
全平台 Workspace/Worker/Authentication 管理事件。响应禁止缓存，不提供 Pi conversation 或 tool stream 导出。

筛选参数全部可选，只在调用者既有可见范围内进一步收窄，不能扩大范围：普通用户传 `category=auth` 或
他人 `userId` 只会得到空结果。`userId` 同时匹配 actor 与 owner；`from` 包含、`to` 不包含。未知参数或
格式错误返回 400。Portal 的 CSV 导出在浏览器端基于已加载事件生成，不新增服务端导出接口；导出单元格
对 `= + - @` 等前缀做公式注入防护。

## Proxy

MVP Gateway 以 Host routing 为主：

```text
Host: <workspace-id>.agent.example.internal
```

Gateway：

1. 从经过严格 validation 的 Host 解析 `workspace-id`
2. auth
3. authorize
4. resolve Workspace -> Worker
5. proxy HTTP / WebSocket

可以保留普通平台 API path，但不要把 `/w/:workspaceId/*` 作为 pi-web 的主入口。

---

# 33. Worker Protocol

Envelope：

```json
{
  "version": 1,
  "type": "workspace.start",
  "requestId": "uuid",
  "payload": {}
}
```

最小协议：

```text
worker.hello
worker.heartbeat
worker.reconcile

workspace.ensure
workspace.start
workspace.stop
workspace.delete
workspace.inspect

event.workspace
event.error

response.ok
response.error
```

`response.ok` / `response.error` 必须复用被响应命令的 `requestId` 以完成关联，并返回
受 schema 约束的业务结果或稳定错误码；不得把 Worker stack、host path 或原始 Docker
错误对象发送给 Browser。非请求触发的 `event.workspace` / `event.error` 使用独立
`eventId` 与 `observedAt`，不要伪造 request correlation。超时、重试和重复响应处理在
Phase 2 control channel 实现时固定并测试。

Phase 2 固定为：每个 dispatch 只发送一次，超时后失败，不做传输层隐式重试；迟到或
重复 response 在 pending request 已清理后忽略。response 的 Worker、`requestId` 或
`requestType` 不匹配时，不得完成另一个请求。后续 Phase 如需重试，由业务层根据命令
语义显式决定；`workspace.ensure` 依靠其幂等契约允许安全重试，destructive command 不得
被通用传输层自动重放。

---

# 34. workspace.ensure

必须 idempotent。

Control Plane 可以安全重复请求。

如果 Container 已存在：

```text
inspect
-> verify managed identity / safe-to-manage security baseline
-> verify current or explicitly supported legacy runtime configuration
-> return current state
```

不要创建重复 Container。

`managed identity / safe-to-manage` 与 `current desired runtime configuration` 必须分开验证。
前者包含 workspace metadata、Worker/Workspace labels、managed name、metadata 中记录的历史 runtime image
与实际 Container image 一致、UID/GID、
managed bind mount、managed network、privileged/capability/security options 与 loopback port exposure
等 ownership/security 边界；后续新增的功能性环境变量不得追溯性地使原本合法的 managed
Container 变成不可 inspect/stop/delete。

Phase 5 post-acceptance baseline 明确支持：在引入 `PI_WEB_DEFAULT_CWD=/workspace` 前创建且仅缺少
该变量的合法 Container，继续允许幂等 ensure、legacy-compatible start、inspect、stop、Gateway
和 delete，不自动重建、不自动删除持久数据。它在被明确删除/重建前保留旧 pi-web default-cwd
行为。新建 Container 必须设置并在 create 后验证当前变量；显式设置冲突值时拒绝 ensure/start/
Gateway，但只要 managed identity 仍完整，inspect/stop/delete 继续可用以完成安全清理。
Worker 的当前 `RUNTIME_IMAGE` 升级后，旧 Workspace 的 `managed.json.runtimeImage` 保持原值；只要
metadata 中的 workspace/Worker 身份、managed 路径、Container/Network labels 和 Container image 与
历史 metadata 仍一致，inspect/stop/destructive delete 不因当前镜像 pin 改变而拒绝管理。delete 必须在
移除任何资源前完成这些身份校验，并返回历史 runtime image 供 Control Plane 对照 Workspace metadata；
ensure/start/Gateway 与 recovery 仍要求当前镜像兼容，不自动修改 metadata 或重建旧 Runtime。

---

# 35. workspace.delete

`workspace.delete` 是 destructive operation，必须满足：

1. Control Plane 已完成用户/admin authorization；
2. Worker 验证 Workspace assignment；
3. Worker 只处理带正确 managed label 的本系统 Container；
4. 删除 Container；
5. 删除该 Workspace 对应的 managed persistent directory；
6. 返回明确结果后，Control Plane 才删除/终结对应 metadata。

如果 Worker 无法访问、路径校验失败或存在 assignment/label 不一致，不得静默继续或报告成功。

---

# 36. Docker Label

系统管理 Container：

```text
app=agent-runtime-platform
managed_by=worker
workspace_id=<uuid>
```

Worker 只能删除/修改带正确 managed label 的 Container。

不要因为 container id 来自 Control Plane 就无条件执行。

---

# 37. Container Endpoint

Workspace Container 使用 private Docker network，并让 pi-web 监听固定内部端口。

MVP Worker 在宿主机上为每个 Workspace 分配：

```text
127.0.0.1:<workspace-port>
```

该端口只作为 Worker Gateway 到 Workspace 的本机上游，不直接暴露给用户或企业 LAN。

MVP 跨主机流量固定采用：

```text
Browser
  -> Control Plane / Gateway
  -> authenticated Worker Gateway
  -> 127.0.0.1:<workspace-port>
  -> Workspace pi-web
```

Worker Gateway：

- 仅接受来自受信 Control Plane 的认证请求；
- 根据平台下发/同步的 Workspace assignment 做本机二次校验；
- 只允许代理自己管理且 label 正确的 Workspace；
- 同时支持 HTTP 与 WebSocket；
- 不提供任意 target host/port proxy；
- 不暴露 Docker API。

Control Plane 只可路由到该 Worker 预注册并通过 credential 绑定的
`gateway_base_url`。Worker Gateway 使用与 Worker control credential 分离的认证材料；
Runtime Container 内不得拥有这类材料。所有转发请求都携带不可由浏览器提供的
Control Plane 身份，并在 Worker 侧再次核对 Workspace assignment 与 managed labels。

MVP 不实现“在 Worker persistent WebSocket 上复用任意 HTTP/WebSocket byte tunnel”。该方案可在后续为了 NAT/防火墙部署便利再演进。

Worker Gateway 的监听地址、TLS/认证方式必须配置化，并在真实多主机环境中验证。开发环境可使用受保护内网，但不得让最终用户绕过 Control Plane 直接访问。

---

# 38. Workspace URL 与 pi-web Base Path

MVP 用户入口固定采用 Workspace subdomain：

```text
https://<workspace-id>.agent.example.internal/
```

Gateway 根据 Host 中的 Workspace ID：

1. authenticate user；
2. load Workspace；
3. ownership check；
4. resolve assigned Worker；
5. proxy 到该 Worker Gateway。

MVP 不以：

```text
/w/<workspace-id>/
```

作为主要访问方案。

原因是 pi-web 当前集成不应依赖复杂 base-path rewrite；static assets、API、WebSocket 等全部保持 pi-web 预期的根路径语义，更容易稳定复用 upstream。

部署因此需要：

- 内部 wildcard DNS，例如 `*.agent.example.internal`
- wildcard certificate，或开发环境等价 TLS/host 配置
- Gateway Host validation

Runtime 内 pi-web 不启用 `PI_WEB_PASSWORD` 作为第二层用户登录。平台 Gateway 是最终用户认证与授权边界。

pi-web endpoint 必须保持不可由最终用户直接访问；Worker Gateway 也只对 Control Plane 所在受保护网络开放。

如果未来部署环境无法提供 wildcard DNS/certificate，再通过 ADR 重新评估 path-based routing，而不是在 MVP 同时维护两套路由模型。

---

# 39. Workspace URL 不应成为权限凭证

即使 UUID 足够随机：

```text
/w/7c2...
```

也必须：

```text
current_user.id == workspace.user_id
```

UUID 只是 locator，不是 credential。

---

# 40. Browser Disconnect

Browser 关闭：

```text
Browser X
```

不等于：

```text
Workspace stop
Pi abort
```

Workspace 生命周期只由显式用户操作、Admin 策略或 idle policy 控制。

用户回来：

```text
same URL
-> Gateway
-> same Workspace
-> same pi-web
```

Pi Session continuity 交由 pi-web/Pi。

---

# 41. Idle Policy

v0.x 行为：永不自动停止（`PI_WEB_IDLE_TIMEOUT_MS=0`）。

v1.0（Phase 18 实现）：可配置的空闲回收，**默认关闭**，由管理员启用并设置时长 N。

Control Plane 不理解 Pi 协议（`AGENTS.md` 第 5 节），且浏览器断开后 Agent 可能仍在执行长任务（第 40 节要求此时
不得停止）。因此只有同时满足以下全部条件并持续 N 时，才判定 Workspace 空闲：

1. 无经过 Gateway 的活跃 HTTP 流或 WebSocket 连接；
2. 最近 N 内没有经过 Gateway 的请求（需要新增访问时间记录；现有 `last_activity_at` 只在生命周期操作时
   更新，不能直接使用）；
3. 容器 CPU 在整个窗口内持续低于阈值，由 Worker 采样上报，用于避免停掉 Agent 或用户进程仍在运行的
   Workspace。

判定空闲后只执行 `stop`：保留全部持久数据与 Pi Session，记录 Audit，用户可随时再次启动。**不得删除
任何数据。** capacity 按 sticky assignment 计数（STOPPED 也占用），空闲回收释放的是内存与 CPU，
不释放调度名额。

---

# 42. Artifact

MVP 的必需能力是：

> Agent 能在 `/workspace` 生成真实成果，用户能够通过 pi-web 已有的 Workspace 文件能力查看或下载。

因此第一选择：

> **直接复用 pi-web 的 Workspace 文件访问和下载。**

这已经满足 MVP 的“成果生成/下载”验证，不要求为了 MVP 主链额外实现平台级 Artifact registry。

只有需要平台统一展示“任务成果”时，才增加 Artifact 表和平台级 Artifact 页面；该能力属于后续展示增强。

如果平台层增加 Artifact：

```text
relative_path
```

必须限定在 Workspace root。

禁止：

```text
../
absolute path
symlink escape
```

下载时必须重新执行 Workspace ownership check。

---

# 43. Secret

平台自身的存储与日志约束（始终有效）：

- secret 不进 browser localStorage
- 不写 `/workspace`
- 不打 log
- 不进入 Artifact

这里约束的是平台自身的存储与日志行为，不代表可以向有 shell 权限的 Agent 隐藏已经注入 Runtime 的
secret。Agent 进程原则上能够读取自身环境和 Pi credential store；因此不能宣称注入 Runtime 的 secret
对 Workspace 内代码不可见。

OIDC/OAuth2 的 `client_secret`、authorization code、access token、refresh token、ID token 原文属于
Control Plane authentication secret，**不得注入 Runtime**。

## 43.1 模型凭据（v1.0，Phase 16 实现）

v0.x：用户在 pi-web 中自行配置模型凭据，由 Pi 持久化到各自的 `/agent/pi`。

v1.0（Phase 16，详细设计见第 64 节 Phase 16）：采用现成的模型网关组件（LiteLLM Proxy）托管真实上游 key：

- 真实上游 key 只存在于模型网关，不进入 Runtime、Control Plane、普通日志或 Portal；
- 平台为每个 Workspace 通过网关管理 API 签发可撤销的虚拟 key（归属平台用户，按用户计量与限额，只具备推理
  权限）。虚拟 key **不注入 Runtime**：它只保存在 Worker 上，由 Worker 模型中继按来源识别 Workspace 后注入请求；
  Pi 中的平台 provider 只含占位字面量；
- 用户禁用或 Workspace 删除时，对应虚拟 key 被吊销（以网关确认为准，失败时重试，不假装完成）；session 撤销后
  被撤销者无法再经 Gateway 进入 Workspace，因而无法使用平台模型；
- 网关（推理与管理接口）对 Workspace 在网络层面不可达，Workspace 只能访问本机 Worker 的中继端口；
- 注入方式以 pinned Pi 0.85.1 的 `models.json` 自定义 provider 机制为准。

用户仍可在 pi-web 中自行配置其他 provider 的凭据；这部分不受平台托管，平台也不读取。

---

# 44. Network

v0.x：Workspace 默认允许任意出站访问，只实现了 Workspace 之间、以及 Workspace 到宿主机 loopback
upstream / Worker Gateway 的隔离。

v1.0（Phase 14 实现，详细设计见第 64 节 Phase 14，运维见 `docs/egress-runbook.md`）：**默认允许公网、
拒绝内网，内网按管理员白名单放行。**

默认拒绝的目标采用通用内网定义：

```text
10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16   RFC1918
Worker 宿主机自身的全部地址
```

管理员可按部署环境追加拒绝网段（例如云 metadata `169.254.0.0/16`、CGNAT `100.64.0.0/10`），默认不包含。

规则：

- 白名单只能放行上述内网范围中的具体网段或主机端口，由管理员配置并记录 Audit。
- Control Plane、PostgreSQL、Worker Gateway、Docker API、模型网关管理接口等平台管理地址**永远不能
  被放行**：先匹配拒绝，再匹配白名单。模型网关地址同样属于平台管理地址；Workspace 只能访问本机 Worker
  的模型中继端口（Phase 16 的受限例外，见第 43.1 节与第 64 节 Phase 16）。
- 规则由 Worker 为受管 Workspace bridge 下发，并在 reconciliation 中校验；规则缺失或无法确认时
  fail-closed，不启动 Workspace。
- Workspace 级模式预留 `open`（默认）与 `offline`；域名级策略放到 v1.x。
- Workspace 网络保持不启用 IPv6；如将来启用，必须按等价的 `fc00::/7` 下发 IPv6 规则。

开发环境说明：Clash Verge 与 Tailscale 只存在于开发设备，生产目标环境没有，默认规则不针对它们。
Clash TUN 模式下容器流量可能经 Clash 代为连接，出口拦截的验收应在关闭 TUN 或确认容器流量不经
Clash 的条件下进行。

这仍然是基础的出口控制，不是完整的零信任网络隔离。

---

# 45. Runtime capability test

测试必须与当前 Phase 的镜像能力声明一致，不能要求 Phase 3 Minimal Runtime 假装具备
Phase 7 Toolchain。

Phase 3 构建/CI 至少执行：

```bash
git --version
python3 --version
node --version
pnpm --version
pi --version
pi-web --help
```

Phase 7 再对完整 Runtime 执行：

```bash
python3 --version
uv --version
node --version
pnpm --version
rustc --version
cargo --version
gcc --version
ffmpeg -version
pdftotext -v
pandoc --version
libreoffice --headless --version
```

Browser：

```text
launch chromium
open local page
evaluate JS
close
```

Pi/pi-web：

```text
start pi-web
health check
open page
create Pi Session
send prompt
```

---

# 46. pi-web Integration Test

只测试平台边界，不复制 upstream 全量测试。

至少：

1. Container 启动。
2. pi-web 启动。
3. Gateway HTTP 可以访问。
4. Gateway WebSocket 正常。
5. pi-web 可以打开 Terminal。
6. pi-web 可以创建 Pi Session。
7. 可以发送 Prompt。
8. Streaming 正常。
9. Workspace 文件可读写。
10. Container restart。
11. Pi Session 可以继续。

---

# 47. Ownership Test

必须：

```text
User A -> Workspace A = 200
User A -> Workspace B = 403/404
```

测试：

- API
- proxy HTTP
- proxy WebSocket
- start
- stop
- delete
- artifact

尤其要测试：

> 已经建立 WebSocket 后是否可以通过参数切换到另一个 Workspace。

Phase 9–12 增加：

```text
disabled User -> Portal API = 401/403
disabled User -> existing Workspace Host session = denied
revoked session -> existing Portal/Workspace cookies cannot continue
OIDC login -> still cannot access another user's Workspace
```

---

# 48. Worker 安全测试

必须确认：

- Worker token 错误拒绝
- Worker ID 不合法拒绝
- invalid protocol 拒绝
- Runtime 不挂 Docker socket
- Container 非 privileged
- Worker 不删除 unrelated Container
- bind mount 只能来自 managed root
- Container path 不来自用户直接输入
- Worker credential 不能冒充其他 `worker_id`
- Workspace A 不能连接 Workspace B 或 Worker management endpoint
- Runtime 中不存在 OIDC/OAuth2 provider credential 或用户 SSO token

---

# 49. Worker Reconciliation

Worker restart 后：

1. scan managed containers
2. scan managed Workspace directory
3. reconnect Control Plane
4. report observed Workspace
5. Control Plane 返回 authoritative assignment
6. reconcile

不要自动删除“不认识”的数据。

宁可：

```text
orphan warning
```

不要：

```text
rm -rf
```

Phase 4 稳定性范围包含一个受限的 reconnect state repair：Worker 完成 authenticated hello
并重新注册 control channel 后，Control Plane 仅对数据库中仍绑定该 Worker 且状态为
`WORKER_OFFLINE` 的 Workspace 逐个发送 `workspace.inspect`。在受管 Runtime 身份、runtime
image 和实际状态得到确认前保持 `WORKER_OFFLINE`，Gateway 必须继续 fail-closed；确认运行或
停止后分别恢复 `RUNNING` / `STOPPED`，Container 缺失或确定的 metadata/identity mismatch
进入 `ERROR`，暂时无法确认则保持 `WORKER_OFFLINE`。该修复不得改变 `worker_id`、自动迁移、
隐式 `ensure/start`，也不等同于完整 Worker inventory reconciliation。

Phase 3 的 persistence 验收只覆盖 Worker 正常在线时，对同一 managed Container 的显式
stop/start。Phase 6 才覆盖完整 managed container/directory inventory、orphan 处理、Container
意外退出、Worker 宿主机重启、Control Plane 重启后的 observed state 上报与 authoritative
assignment reconciliation；不能把 Phase 4 的定向 reconnect state repair 当作 Phase 6 的
完整 persistence/recovery 验收。

Phase 6 固定 recovery contract：Control Plane 将每个 Workspace 的 desired state 持久化；进程启动
以及 Worker authenticated hello 后，已分配 Workspace 先进入 `WORKER_OFFLINE`，再由 Control Plane
通过 `worker.reconcile` 下发该 Worker 的 authoritative assignments。Worker 只读扫描本机 managed
Container、network 和 Workspace directory，验证 runtime image、metadata、labels、mount、network、
security/resource baseline 与 pi-web readiness 后返回 observed state。状态恢复必须使用 Workspace ID、
Worker ID、runtime image、desired state 和当前 `WORKER_OFFLINE` 的条件更新，不能覆盖并发 lifecycle。

期望运行且确认运行才恢复 `RUNNING`；期望停止且确认停止才恢复 `STOPPED`。unexpected stop、相反状态、
资源缺失或确定 mismatch 进入 `ERROR`；暂时 Docker/pi-web 错误、断线或不完整报告保持
`WORKER_OFFLINE`。迁移前无法确定 intent 的 legacy `ERROR/WORKER_OFFLINE` 记录使用 `UNKNOWN` desired
state，一次完整、有效的 observed state 可将其恢复为实际 `RUNNING/STOPPED`。

不在 authoritative assignments 中的资源必须区分为当前 Worker 的 `MANAGED_ORPHAN`、其他 Worker
identity 的 `FOREIGN_MANAGED_RESOURCE` 或不能证明 managed identity 的 `UNKNOWN_RESOURCE`。三者均只
告警，不自动删除。唯一允许 recovery 补完成的删除，是数据库已持久化 `DELETED` intent，且完整
inventory 明确确认 Container、network 与 managed directory 全部不存在的 Workspace metadata 删除。

---

# 50. PostgreSQL

Control Plane metadata 使用 PostgreSQL。

MVP 不需要 Redis。

跨服务实时通信：

```text
Worker persistent WebSocket
```

已经够用。

如果未来多实例 Control Plane，再考虑：

- Redis
- NATS
- PostgreSQL LISTEN/NOTIFY

---

# 51. 推荐技术栈

## Platform

```text
TypeScript
Node.js
pnpm
Fastify
React
Vite
PostgreSQL
Drizzle
Zod
Vitest
Playwright
```

OIDC 应优先使用成熟、维护中的标准协议库完成 discovery / token validation / PKCE 等基础协议工作，不自行手写 JWT / JWK / signature validation。

## Worker

```text
TypeScript
Node.js
Docker Engine API
systemd
```

## Runtime

```text
Docker
Linux
pi-web
pi-agent
```

---

# 52. Monorepo

```text
.
├── AGENTS.md
├── specs.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── apps/
│   ├── web/
│   ├── control-plane/
│   └── worker/
├── packages/
│   ├── protocol/
│   ├── database/
│   ├── auth/
│   ├── gateway/
│   └── shared/
├── runtime/
│   ├── Dockerfile
│   ├── entrypoint.sh
│   └── scripts/
├── deploy/
│   ├── compose.dev.yml
│   ├── compose.control.yml
│   ├── worker.env.example
│   └── agent-worker.service
└── tests/
```

---

# 53. Portal UI

平台自己的 UI 不要和 pi-web 重复。

平台只需要：

## Login

Phase 9：

```text
username / email
password
```

Phase 10 在同一 Login 页面增加：

```text
使用企业 SSO 登录
```

不要为了 OIDC 自己实现 IdP 风格复杂登录页。跳转、MFA、条件访问等交给上游 IdP。

## Workspace List

Portal 使用轻量前端路由拆分主要信息架构：Workspace 列表位于 `/`，普通用户自己的 Workspace Activity
位于 `/activity`；admin-only 的 Users、Workers、Audit 分别位于 `/admin/users`、`/admin/workers`、
`/admin/audit`，只读的全平台 Workspace 列表位于 `/admin/workspaces`。普通用户导航显示 Workspace /
活动，admin 导航显示 Workspace / 用户 / 全部 Workspace / Worker / 审计；Portal 文案统一为中文，状态枚举仅在展示层映射为中文标签，API 值不变。Audit/Activity 等日志
类事件显示本地 `YYYY-MM-DD HH:mm:ss` 绝对时间（悬停显示相对时间）；Workspace 创建时间、Worker 心跳
等新鲜度信息显示相对时间（悬停显示绝对时间）。API 时间字段仍为 ISO 8601 UTC。前端无权限页面不能
替代后端 authorization。Activity 与 Admin Audit 复用事件展示，普通用户仍只能从服务端获得自己的
`workspace.*` 事件。

```text
Workspace      State       Worker
network-sim    RUNNING     worker-a
documents      STOPPED     worker-b
```

操作：

```text
Open
Start
Stop
Delete
New Workspace
```

## Admin Workers

```text
Worker        State    Arch     Workspace
worker-a      ONLINE   amd64    3/8
worker-b      ONLINE   arm64    2/4
```

操作仅限暂停调度 / 恢复调度（见第 14 节）；暂停需确认并说明已有 Workspace 不受影响。Portal 不提供
吊销（`enabled = false`）、删除 Worker 或修改 capacity 的入口。

## Admin Users

Phase 9 增加紧凑用户管理页，例如：

```text
User          Source      Role     Status      Workspace
zhangsan      OIDC        user     active      3
lisi          Local       user     disabled    1
admin         Local       admin    active      0
```

需要的管理动作仅限：

```text
Create Local User
Enable / Disable
Change Role
Reset Local Password
Revoke Sessions
View Workspace Metadata
```

Phase 11 可展示 Identity binding，但不要做 Organization / Department / group-policy 管理后台。

用户列表支持按用户名/邮箱/ID 搜索和按来源、角色、状态筛选，均在浏览器端对已加载列表进行，不新增
服务端查询接口。创建用户、重置密码、绑定 subject 及启停、角色变更、撤销会话、解绑的确认都使用
Portal 内对话框，不使用浏览器原生 `prompt/confirm`；失败信息显示中文并附 API error code。

## Admin Workspaces

只读列表：Workspace、所有者、状态、Worker、创建时间、最近活动，支持按名称/所有者/ID 搜索和按状态、
Worker 筛选。不提供 start/stop/open/delete；admin role 不因此获得 Workspace 内容访问权。

点击 Open Workspace 后进入：

```text
pi-web
```

不要自己再做一套 Chat。

---

# 54. Portal 与 pi-web 视觉关系

MVP 可以：

```text
Portal -> Open Workspace -> pi-web
```

可以是：

- same tab
- new tab
- full page reverse proxy

不强求 iframe。

甚至建议不要 iframe，避免：

- CSP
- Cookie
- WebSocket
- focus
- clipboard
- terminal keyboard

等额外问题。

---

# 55. v0.x 开发阶段（已完成）

本节记录 Phase 0–12 的范围与验收，全部已实现并通过验收（`v0.12.0`；v0.13 的 Portal 调整见
`docs/progress.md`）。它们是 v1.0 的回归基线：后续 Phase 不得破坏这里的验收结果。v1.0 的新增范围见
第 64 节。

## Phase 0：Repository Bootstrap

完成：

- pnpm monorepo
- PostgreSQL
- shared protocol
- dev Compose
- lint/typecheck/test

验收：

```text
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

---

## Phase 1：Multi-user Portal

完成：

- users
- local login
- Workspace CRUD
- ownership

验收：

- User A/B 登录
- 互相看不到 Workspace

---

## Phase 2：Worker Control Channel

完成：

- worker daemon
- per-worker credential auth 与 credential -> worker_id 绑定
- heartbeat
- admin worker page

验收：

- 两个 Worker 同时在线
- Offline 可检测

---

## Phase 3：Minimal Runtime + pi-web

目标是先证明“Workspace Container 能稳定承载 pi-web + pi-agent”，不要提前完成 Phase 7 的完整 Toolchain。

Runtime Image 最低包含：

```text
pi-web
pi-agent
shell / core CLI
Git
Python
Node
```

Rust、ffmpeg、PDF/Office、Playwright/Chromium 等完整工具链统一放到 Phase 7 加入和验证；只有 pi-web/Pi 的构建或运行确实依赖某项工具时才提前引入。

Worker：

- create
- start
- stop
- persistent mount
- 当系统只有一个 eligible Worker 时，允许首次启动的 Workspace 直接自动绑定到该 Worker

这里的自动绑定只是 Phase 3/4 的最小运行逻辑，不实现多 Worker score/capability scheduler；完整 Scheduler 属于 Phase 5。

如果 Phase 2 联调环境中已有多个在线 Worker，Phase 3/4 验收时必须只启用一个 eligible
Worker，或由管理员预先完成固定 assignment；不能暗中提前实现 Phase 5 score，也不能
不确定地任选一个 Worker。

验收：

直接访问仅用于开发/集成验证的本机测试入口时：

```text
pi-web works
Pi works
workspace persists
Pi Session persists after container restart
```

该测试入口不得成为最终用户访问路径，也不得暴露到企业 LAN。

---

## Phase 4：Authenticated Gateway

完成：

```text
Portal
 -> auth
 -> Workspace
 -> Gateway
 -> Worker
 -> pi-web
```

要求：

- HTTP
- WebSocket
- Terminal
- streaming
- Workspace Host 的单次 session exchange 与 host-only Cookie
- Control Plane -> authenticated Worker Gateway data path
- Worker daemon 短暂掉线后，对原 Worker 上 `WORKER_OFFLINE` Workspace 执行受限、fail-closed
  的 `workspace.inspect` state repair，不迁移或隐式启动 Runtime

验收：

User A：

```text
Open Workspace A
-> 正常使用 pi-web
```

User B：

```text
Open Workspace A
-> forbidden
```

**Phase 4 是第一个完整 Prototype milestone。**

做到这里先不要扩功能，应先完整 Demo 和修稳定性。

---

## Phase 5：Multi-host Scheduler

将 Phase 3/4 的“单 eligible Worker 自动绑定”升级为真正的多 Worker Scheduler。

完成：

- Worker selection
- capacity，以 PostgreSQL sticky assignment count 为 authoritative source
- capability compatibility
- architecture / exact runtime image compatibility
- `assigned / max` load score 与 Worker ID deterministic tie-break
- sticky placement；已有 `worker_id` 不重新进入候选选择
- PostgreSQL 事务内原子 placement reservation

验收：

```text
Workspace A -> Host A
Workspace B -> Host B
并发首次启动 -> 不突破任一 Worker 的 max_workspaces
Worker A offline/reconnect -> 原 Workspace 仍绑定 Worker A
```

---

## Phase 6：Persistence / Recovery

完成：

- Container restart
- Worker 宿主机重启及完整 managed Runtime inventory
- Control Plane restart
- authoritative assignment / orphan reconciliation
- persistent desired state 与 Control Plane 启动 fail-closed
- 新建 Runtime 使用 `unless-stopped`，legacy Runtime 保持可管理且不自动改写
- orphan/foreign/unknown resource 只告警、不删除

验收：

- Workspace 文件不丢
- Pi Session 不丢
- Worker/宿主机与 Control Plane restart 后完整恢复正常

---

## Phase 7：完整 Toolchain

在 Phase 3 的 Minimal Runtime 基础上补齐并验证：

```text
Playwright
Chromium
LibreOffice
ffmpeg
Rust
PDF tools
```

同时重新验证已有：

```text
Node / pnpm
Python / uv
Base CLI / build tools
```

完成 AMD64 / ARM64 capability matrix。某架构无法通过真实 capability test 时必须上报 `false`，不允许仅因镜像构建成功就宣称支持。

---

## Phase 8：演示增强

本阶段完成：

- Artifact 主链继续复用 pi-web Files：Agent 在 `/workspace` 生成成果，用户在原生 pi-web 中查看或下载；
  当前没有跨 Workspace 统一成果列表的必要，因此不新增平台 Artifact registry、文件副本或下载端点。
- PostgreSQL-backed platform Audit Trail：记录 Workspace create/schedule/state/open/delete、Worker
  register/online/offline/runtime capability report 等基础设施事件；不复制 Pi message/tool stream。
- Portal 管理视图：展示 Workspace placement、Worker authoritative assignment/max、heartbeat
  observation、host capacity、实际 capability probe 结果和紧凑的平台状态概览；安全与 Artifact
  路径说明保留在文档及演示 runbook，不占用日常操作界面。
- E2E 分为确定性平台主链与真实 Docker Runtime 两层：前者覆盖 login、ownership、placement、
  session exchange、HTTP/SSE/WebSocket、Stop/Start sticky；后者通过真实 pi-web bash tool 在
  `/workspace` 生成成果，并验证 Files、持久化、reconciliation、安全与网络隔离。
- polished README 与演示 runbook：明确 preflight、演示路径、验收清单、cleanup 和自动化边界。

Phase 8 验收：

- User A/B 登录、创建/调度、打开 pi-web 和跨用户拒绝均正常；
- 真实 Prompt streaming、Terminal/tool execution 和 pi-web Files 成果查看/下载正常；
- Stop/Start 后文件和 Pi Session 恢复，sticky Worker ID 不改变；
- Worker/Workspace/安全/Runtime capability/Audit 展示与真实状态一致；
- Audit 中没有 Pi conversation、tool stream、credential 或文件正文；
- 根质量门、确定性 E2E、真实 Docker Runtime E2E 通过，并按 runbook 完成人工验收。

---

## Phase 9：User Management Foundation

目标：

> 在不改变 Workspace / Worker / Runtime 主链的前提下，把 Phase 1 的基础本地登录补成可管理的 Platform User 生命周期。

本阶段 **不接 OIDC**。

完成：

- 兼容现有 User schema 的增量 migration
- `user | admin` 保持不变
- User `active | disabled`
- Admin Users 页面
- 创建 Local User
- enable / disable User
- change role
- reset Local User password
- revoke sessions
- 查看用户 Workspace metadata
- 保留至少一个 Local Admin / break-glass 管理入口
- 对 Portal API、Workspace Host session、Gateway/WebSocket 统一执行 disabled-user / revoked-session fail-closed

约束：

- 不实现 User destructive delete
- 不实现复杂 RBAC
- admin 不自动获得用户 Workspace 内容权限
- 不修改 Worker Protocol
- 不修改 Runtime Image
- 不为了用户管理重写既有 session exchange 机制

自动测试至少覆盖：

- 非 admin 访问 `/api/admin/users*` 被拒绝
- admin 可以创建普通 Local User
- 新用户可以登录并只看到自己的 Workspace
- disabled User 不能新登录
- 已登录 User 被 disabled 后，已有 Portal session 与 Workspace Host session 均失效
- revoke sessions 后，既有 Cookie 不能继续使用
- role change 生效且不能通过客户端字段伪造 admin
- password reset 后旧密码失效
- 不能通过用户管理 API 改写其他用户的 Workspace ownership

人工验收：

1. 用现有 admin 登录。
2. 打开 Admin Users，创建 `user-phase9`。
3. 使用新用户登录并创建/打开自己的 Workspace。
4. admin 将该用户 disable。
5. 已打开 Portal 和 Workspace 页面刷新/继续请求均被拒绝。
6. 重新 enable，用户可再次登录，原 Workspace 和数据保持不变。
7. admin reset password，验证旧密码失败、新密码成功。
8. admin revoke sessions，验证当前会话立即失效。
9. 将测试用户 role 改为 admin，再改回 user，验证 Admin 页面权限随服务端 role 变化。
10. 回归 Phase 4/5/6 主链：Gateway、Worker、Runtime、sticky placement、Stop/Start 不受影响。

---

## Phase 10：Generic OIDC

目标：

> 在 Phase 9 的 Platform User / Session 之上增加一个标准 OIDC 登录入口，不改变下游授权模型。

第一版只支持：

```text
1 Generic OIDC Provider
```

Provider 配置优先采用服务端 config / environment，不做 multi-provider Admin UI。

完成：

- OIDC discovery / issuer 配置
- Authorization Code Flow
- PKCE
- `state`
- `nonce`
- ID token 标准校验
- issuer / audience(client_id) 校验
- exact redirect URI
- `user_identities`
- `(provider_id, provider_subject)` 唯一身份
- OIDC callback -> Platform User -> 现有 server-side session
- Login 页面增加 SSO 入口
- unknown identity 默认按 `auto_provision=false` 拒绝
- Local Admin 继续可登录

本阶段默认：

```text
AUTH_OIDC_AUTO_PROVISION=false
```

即管理员必须先准备 Platform User / identity binding，或通过本阶段规定的最小预绑定机制建立关系；不要因为 email 相同就自动绑定。

如果实现时发现“完全不提供任何绑定入口会导致 Phase 10 无法人工验收”，允许实现一个**仅 admin 可用、最小化、明确 subject/provider 的预绑定入口**，但不要提前做 Phase 11 的完整 provisioning UI。

安全要求：

- 不手写 JWT signature / JWK validation
- authorization code 只能在服务端交换
- access/refresh/ID token 原文不进入普通日志/Audit/Browser storage
- External Identity 登录成功后仍检查 User `status`
- External Identity 不自动成为 admin
- OIDC token 不进入 Workspace Container
- callback 不允许 open redirect
- 登录失败返回稳定错误，不回显 provider secret/token 原文

自动测试至少覆盖：

- state mismatch 拒绝
- nonce mismatch 拒绝
- issuer mismatch 拒绝
- audience mismatch 拒绝
- expired/invalid token 拒绝
- unknown identity + auto_provision=false 拒绝
- known active identity 登录成功并得到 Platform session
- known disabled User 即使 IdP 认证成功也拒绝
- 同 email、不同 `(provider, sub)` 不会静默合并
- OIDC User 仍不能访问其他 User Workspace
- Runtime env / managed metadata 中不存在 IdP token/client secret

人工验收建议使用一个可控测试 IdP（例如企业现有 OIDC、Keycloak/Authentik 测试实例或等价标准 Provider）：

1. Local Admin 正常登录。
2. 配置一个 OIDC client 与 callback。
3. 为测试用户建立明确 identity binding。
4. 从 Login 点击 SSO，完成 IdP 登录。
5. 回到 Portal 后显示对应 Platform User。
6. 打开其既有 Workspace，Gateway / WebSocket / Terminal 正常。
7. disable 该 Platform User，再次 SSO 应被拒绝。
8. 暂停/错误配置 OIDC 后，Local Admin 仍能进入平台处理配置。
9. 回归 Local login、Workspace、Worker、Runtime 主链。

---

## Phase 11：Provisioning / Identity Binding / OAuth2 Compatibility

实现状态（2026-09-28）：工程实现、自动验证与人工验收已完成。

目标：

> 在单 OIDC 登录已经稳定后，再补齐账号建立策略和少量企业兼容能力；不把平台扩成通用 IAM。

完成优先级：

### 11.1 Provisioning

支持两种明确模式：

```text
manual provisioning
JIT auto provisioning
```

默认仍建议：

```text
auto_provision=false
```

当开启 JIT：

- 新 External Identity 可创建 Platform User
- 默认 `role=user`
- 不允许 IdP claim 直接授予 admin
- 可选 `allowed_domains` allowlist
- 如实现 group allowlist，只用于“允许登录/创建”这种简单 gate，不实现通用 group policy / RBAC

### 11.2 Identity Binding

Admin 可以查看：

```text
Platform User
  -> External Identities
```

支持明确的 bind / unbind。

约束：

- bind 目标必须由稳定的 provider + subject 标识
- 不允许仅凭 email 自动绑定
- unbind 前确保用户仍有至少一个可用登录方式；尤其不能让最后一个 Local Admin 被锁死
- 所有 bind/unbind 写 Audit

### 11.3 OAuth2 + UserInfo Compatibility（可选）

只有实际企业系统不支持 OIDC 时才实现。

配置概念：

```text
authorization_url
token_url
userinfo_url
userinfo_token_method = bearer | query

subject_field
username_field
email_field
display_name_field
```

`userinfo_token_method` 默认使用标准 Bearer header；`query` 仅用于明确要求
`?access_token=...` 的非标准 profile endpoint，且上游接入层不得记录 query string。

要求：

- 仍然映射为 `External Identity -> Platform User`
- `subject_field` 必须是 Provider 内稳定标识
- 不因 OAuth2 compatibility 降低 OIDC 原有校验
- Provider-specific 字段映射集中在 adapter，不散落到 User / Workspace / Gateway
- access token 仅在 Control Plane 调 UserInfo 所需的最短生命周期内使用，不进入 Runtime

不做：

- LDAP 全量 sync
- SCIM
- Organization / Department hierarchy
- group -> arbitrary RBAC
- Workspace sharing
- 自研 MFA

自动测试至少覆盖：

- manual provisioning
- JIT off / on 两种行为
- JIT User 默认 role=user
- allowed domain 拒绝与允许
- bind/unbind authorization
- 同 email 不自动合并
- 最后可用登录方式保护
- OAuth2 UserInfo 字段缺失/类型错误 fail-closed（如果实现 compatibility）
- OAuth2 token 不进入 Runtime / Audit

人工验收：

1. 验证 manual provisioning 正常。
2. 打开 JIT 后用一个全新 OIDC subject 首次登录，自动产生 `role=user` 的 Platform User。
3. 验证其不能访问 Admin。
4. 验证 allowed domain 策略。
5. 在 Admin Users 查看该用户 identity。
6. 测试 bind / unbind。
7. 如当前企业系统需要 OAuth2 compatibility，再用真实/测试 UserInfo endpoint 联调字段映射；若不需要，本小节可以保持未实现并在 Phase 结果中明确说明。

---

## Phase 12：Authentication Audit / Hardening

实现状态（2026-09-28）：工程实现、自动验证与人工验收已完成。

目标：

> 把 Phase 9–11 的认证功能纳入现有 Platform Audit 与安全回归，使其达到可演示、可运维、可排障状态。

完成：

- Authentication / User Management Audit events
- login success / failure
- logout
- session revoke
- user create / enable / disable
- role change
- password reset（只记动作，不记密码）
- identity bind / unbind
- OIDC/OAuth2 failure 的安全分类日志
- session fixation regression
- CSRF regression
- redirect / callback validation
- Cookie security regression
- disabled user / revoked session regression
- Workspace Host session exchange regression
- WebSocket auth regression
- token / secret redaction test
- README / deployment config / runbook 更新
- OIDC 故障时 Local Admin break-glass runbook

Audit 原则：

- `auth.login_failed` 可以记录 provider、稳定错误类别、request correlation、IP/user-agent 等必要 metadata
- 不记录 password
- 不记录 authorization code
- 不记录 access/refresh/ID token 原文
- 不记录 client secret
- 不把完整 UserInfo response 原样写入 Audit
- 不把 Pi conversation/tool stream 混入认证 Audit

自动测试至少覆盖：

- session fixation：登录前 session id 不可被固定后继续复用为认证 session
- CSRF：Local 与 OIDC 引入后既有 state-changing API 保护不退化
- callback open redirect 被拒绝
- Cookie `HttpOnly` / `Secure`（生产配置）/ `SameSite` / host-only 语义
- logout / disable / revoke 后 Portal + Workspace Host + WebSocket 一致失效
- OIDC/OAuth2 secret redaction
- Audit authorization：普通用户不能读取 admin-only auth events
- Phase 4–8 E2E 全量回归

人工验收：

1. 完成一次 Local login / logout。
2. 完成一次 OIDC login。
3. 故意制造一次 OIDC failure。
4. admin disable / enable 一个用户。
5. change role。
6. reset password。
7. revoke sessions。
8. 检查 Audit：事件完整，但没有任何 credential/token/password/Pi 内容。
9. 验证已有 Workspace HTTP / SSE / WebSocket / Terminal / Files / Stop/Start / recovery 不退化。
10. 按 runbook 模拟 IdP 不可用，Local Admin 仍可进入并排障。

**Phase 12 完成后，Phase 9–12 才视为一个完整的 User Management / Enterprise Authentication 增量里程碑。**

---

# 56. 演示路径（v0.x）

v0.x 的完整演示路径，也可作为主链回归的人工检查顺序。可执行的步骤以 `docs/demo-runbook.md` 为准。

## Step 1

打开 Admin：

```text
worker-a ONLINE
worker-b ONLINE
```

## Step 2

User A 创建：

```text
dev-workspace
```

## Step 3

Scheduler：

```text
-> worker-a
```

## Step 4

Open Workspace。

进入 pi-web。

创建 Pi Session：

```text
请克隆这个 demo repo，运行测试并修复一个问题。
```

Pi：

```text
git
node/python/rust
tests
```

完成。

## Step 5

新建第二个 Pi Session。

原 Workspace 不变。

展示：

> 一个完整 Runtime 可以承载多个长期 Pi Session。

## Step 6

User B 创建 Workspace。

调度到另一台 Worker。

## Step 7

User A 尝试访问 User B URL。

拒绝。

## Step 8

让 Agent 执行：

```text
PDF / Office / ffmpeg / Playwright
```

组合任务。

展示完整 Linux Runtime。

## Step 9

关闭浏览器。

Agent / Workspace 不销毁。

重新打开。

继续 Pi Session。

## Step 10

Stop Workspace。

再次 Start。

文件与 Pi Session 恢复。

企业认证展示：

```text
Local Admin
-> Admin Users
-> OIDC User SSO
-> same Workspace/Gateway/Runtime path
-> disable User
-> access immediately denied
```

重点展示“认证入口可替换，但 Platform User / Workspace ownership / Runtime 主链不变”。

---

# 57. 与 Dify 类系统的区别

对外介绍时客观表达差异，不贬低其他产品：

传统 Web AI 平台更偏：

```text
LLM
+ Tool
+ Workflow
+ Knowledge Base
```

本项目重点：

```text
User
-> Isolated Runtime
-> Full Linux Workspace
-> CLI Agent
```

每个用户获得的是一个长期可用的 Agent Runtime，而不是一次受限的 Tool Invocation。

核心差异：

> **平台管理的是“Agent 计算环境”，而不仅是“Agent 对话”。**

---

# 58. 与直接部署 pi-web 的区别

直接部署 pi-web 适合：

```text
trusted user
single environment
single host
```

本项目增加：

```text
Multi-user
Tenant isolation
Workspace isolation
Worker fleet
Scheduling
Resource limits
Authenticated gateway
Platform lifecycle
```

Phase 9–12 进一步补充：

```text
User lifecycle
OIDC enterprise login
External identity binding
Auth audit
```

因此 pi-web 是底层 Runtime 产品，而不是竞争关系。

---

# 59. 安全边界

v1.0 仍面向：

> 企业内部可信用户 + 相互隔离需求。

Docker 提供：

- namespace
- filesystem
- process
- resource
- network 基础隔离

但不是：

> hostile arbitrary code VM sandbox。

OIDC / OAuth2 提供身份认证入口，但不等于：

> 完整 IAM / Zero Trust Identity Platform。

文档必须准确说明。

---

# 60. 后续方向

v0.x 阶段列出的后续方向已重新分配：

- 进入 v1.0（第 64 节）：egress ACL（Phase 14）、磁盘配额（Phase 15）、central model gateway 与模型
  凭据托管（Phase 16）、可观测性（Phase 17）、空闲回收与 Runtime 镜像升级（Phase 18）、Audit export
  （v0.13 已在 Portal 端实现）、Worker 暂停调度（v0.13 已实现，即 cordon；不含迁移式 drain）。
- 明确不做：平台内 Workspace snapshot / 备份 / 跨 Worker 恢复（由外部备份软件负责，见第 28 节）、计费。
- v1.x 或更后再评估：Human-in-the-loop approval、scheduled task、非交互任务 API、按用户/部门配额、
  Workspace 模板、Workspace migration、NAS / object storage、gVisor / Kata / microVM、Kubernetes
  backend、GPU Worker、LDAP directory sync、SCIM、complex RBAC / organization hierarchy、MCP management、
  Control Plane 多实例。

---

# 61. v0.x Acceptance Checklist（已通过）

以下为 v0.x 已通过的验收清单，是 v1.0 各 Phase 的回归基线。v1.0 的验收见第 64 节各 Phase。

- [ ] 两个用户可以独立登录。
- [ ] User A 不能访问 User B Workspace。
- [ ] 用户可以创建多个 Workspace。
- [ ] 每个 Workspace 对应独立 Docker Container。
- [ ] Runtime 内直接运行 pi-web + pi-agent。
- [ ] pi-web 可以在一个 Workspace 中维护多个 Pi Session。
- [ ] pi-web HTTP 经过 Gateway。
- [ ] pi-web WebSocket 经过 Gateway。
- [ ] 用户不能直接访问 Worker Runtime endpoint。
- [ ] Workspace 通过 `<workspace-id>.agent.example.internal` 一类 subdomain 访问，不依赖 `/w/<id>/` base-path rewrite。
- [ ] pi-web 不启用第二层用户密码认证，用户认证统一由 Platform Gateway 完成。
- [ ] 两个 Worker 可以同时连接。
- [ ] Worker 可以运行在不同主机。
- [ ] Scheduler 可以将不同 Workspace 分配到不同 Worker。
- [ ] Workspace 使用 sticky placement。
- [ ] Worker Offline 后 Workspace 显示 WORKER_OFFLINE。
- [ ] 不发生自动迁移。
- [ ] Container stop/start 后 `/workspace` 数据保留。
- [ ] Pi Session 可以恢复。
- [ ] Agent 可以在 `/workspace` 生成成果，并通过 pi-web 安全查看/下载。
- [ ] 浏览器关闭不会销毁 Workspace。
- [ ] Stop Workspace 后 persistent data 与 Pi Session 保留。
- [ ] Delete Workspace 会永久删除 managed Container、persistent directory 和 metadata。
- [ ] Worker Offline 时 destructive delete 不会被假装成成功。
- [ ] Runtime 没有 Docker socket。
- [ ] Runtime 不是 privileged。
- [ ] Runtime 有 CPU/Memory/PID limit。
- [ ] 每个 Workspace 的网络相互隔离，不能绕过 Gateway 访问其他 Workspace。
- [ ] Runtime 不能访问 Worker/Control Plane management credential 或管理入口。
- [ ] Worker 使用独立 credential，且不能在 hello 中冒充其他 `worker_id`。
- [ ] Portal 到 Workspace Host 使用短时单次 exchange 和 host-only session Cookie。
- [ ] Runtime 有 Python。
- [ ] Runtime 有 Node/pnpm。
- [ ] Runtime 有 Rust。
- [ ] Runtime 有 ffmpeg。
- [ ] Runtime 有 PDF tools。
- [ ] Runtime 有 LibreOffice。
- [ ] 至少一个架构上 Playwright/Chromium 可正常运行。
- [ ] Worker capability 可以反映不同架构能力。
- [ ] Admin 可以查看 Worker 与 Workspace placement。
- [ ] E2E 验证 HTTP + WebSocket proxy。
- [ ] E2E 验证 ownership。
- [ ] README 有单机部署说明。
- [ ] README 有第二台 Worker 接入说明。

## Phase 9–12 Additional Acceptance

- [ ] Admin 可以管理 Local User 的创建、启停、role、password reset 与 session revoke。
- [ ] disabled User 与 revoked session 对 Portal / Workspace Host / WebSocket 一致 fail-closed。
- [ ] 平台保留可用 Local Admin / break-glass 登录。
- [ ] Generic OIDC Authorization Code Flow + PKCE 可用。
- [ ] OIDC `state` / `nonce` / issuer / audience 校验完整。
- [ ] External Identity 使用 `(provider, subject)`，不以 email 自动合并。
- [ ] OIDC/OAuth2 登录最终建立 Platform server-side session，而不是把 IdP token 当内部 bearer token。
- [ ] External User 不会自动获得 admin。
- [ ] manual provisioning / JIT 行为与配置一致。
- [ ] Identity bind/unbind 有 authorization 与 Audit。
- [ ] 如实现 OAuth2 + UserInfo compatibility，Provider adapter 不污染 Workspace / Gateway ownership 模型。
- [ ] IdP credential/token 不进入 Runtime、Artifact、普通 Audit 或 Browser localStorage。
- [ ] Authentication Audit 不包含密码、token、authorization code、client secret、Pi conversation/tool stream。
- [ ] Phase 4–8 的 Gateway / Worker / Runtime / persistence / scheduler E2E 在 Phase 12 后仍通过。

---

# 62. 最小主链

v0.x 首先跑通并始终要保持的主链：

```text
User Login
  -> Create Workspace
  -> Scheduler / Worker
  -> Docker Container
  -> pi-web
  -> pi-agent
  -> Gateway
  -> Browser
```

然后证明：

```text
User A != User B
Workspace A != Workspace B
Worker A != Worker B
```

只要这条主链稳定，后面的 Runtime Toolchain、Artifact、Audit 都可以自然追加。

Phase 9–12 不改变这条主链，只在最前端把：

```text
User Login
```

扩展为：

```text
Local Login
or
External Identity -> Platform User -> Platform Session
```

---

# 63. 最终架构原则

任何实现方案都应尽量保持：

```text
┌──────────────────────────────────────────┐
│ Platform Layer                           │
│ Multi-user / Auth / Scheduler / Gateway  │
│ Worker / Docker / Resource / Lifecycle   │
├──────────────────────────────────────────┤
│ pi-web                                   │
│ Session / Chat / Terminal / Files / UI   │
├──────────────────────────────────────────┤
│ pi-agent                                 │
│ Agent Loop                               │
├──────────────────────────────────────────┤
│ Linux Runtime                            │
│ Python Node Rust ffmpeg Office Browser   │
└──────────────────────────────────────────┘
```

Phase 9–12 只扩展 Platform Layer 的身份入口与用户生命周期：

```text
External IdP
    |
    v
Platform User
    |
    v
Platform Session
    |
    v
Authorization / Gateway
```

Worker、Docker Runtime、pi-web、pi-agent 不认识 OIDC/OAuth2。

项目的主要工程价值仍在第一层和第四层的组织方式：

> 把成熟的 CLI Agent + Web Wrapper 变成一个可以被企业多用户安全共享的分布式 Agent Runtime Platform。

不应通过重写 pi-web 或把平台扩成通用 IAM 来制造不必要的工作量。

---

# 64. v1.0 Phases

总体目标、差距与决策见 `docs/v1-roadmap.md`。每个 Phase 开工时，把本节对应小节扩写为完整设计
（范围、非目标、API/数据模型变化、验收清单、测试计划、待决问题），经负责人确认后再实现。
未扩写的小节只代表已确认的方向，不能当作详细设计直接编码。

## Phase 13：工程基线

状态：**已验收（2026-10-05）**，经 PR #1 合入 master，tag `v1.0.0-alpha.1`。

目标：为后续 Phase 建立可靠的自动验证、可排障的日志和可读的代码结构。**不改变任何对外行为**：API、
数据库 schema、Worker protocol、Portal 行为与 v0.13.0 一致。

### 13.1 持续集成

- 新增 `.github/workflows/ci.yml`，在所有分支 push 与 pull request 上运行，runner 为
  `ubuntu-24.04-arm`（主验证架构；仓库公开，GitHub 托管 ARM64 runner 可用）：
  - `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build:web`；
  - `pnpm test:e2e`；
  - PostgreSQL 17 service 容器上的集成测试（`TEST_DATABASE_URL` 指向 CI 专用库）。
- `runtime-toolchain.yml` 的触发条件增加：master 上 `runtime/**`、`apps/worker/**`、
  `packages/protocol/**` 变化的 push、每周定时、手动触发。保留 amd64 / arm64 矩阵；AMD64 的原生证据
  由此产生，并回填 `docs/runtime-capability-matrix.md`。
- 每个 Phase 通过 pull request 合入 master：CI 必须为绿，负责人人工验收后再合并。

### 13.2 结构化日志

- 新增 `packages/logging`，基于 pino（Fastify 内置的日志库，版本精确 pin），提供
  `createLogger(service)`：JSON 输出到 stdout，`LOG_LEVEL` 控制级别（默认 `info`）。开发时可设
  `LOG_FORMAT=pretty` 输出人类可读格式。
- Control Plane：启用 Fastify logger，沿用现有 request ID；Portal API 请求完成时记录 method、路由模板、
  status、耗时、request ID，已认证时附 user ID。
- Workspace Gateway 与 Worker Gateway：每个请求记录 Workspace ID、method、status、耗时、request ID，
  WebSocket 记录建立与关闭；**只记录路径的第一段**（如 `/api`），因为更深的路径可能包含用户文件名。
- request ID 统一为 UUID（Control Plane 由 Fastify `genReqId` 生成，因此 Audit details 中的
  `requestId` 也变为 UUID 格式）。Control Plane 的 Workspace Gateway 总是自行生成 request ID，以
  `x-platform-request-id` 转发给 Worker Gateway 并覆盖浏览器提供的同名头；Worker Gateway 只接受 UUID
  格式用于日志，并在转发给 pi-web 前删除该头。
- 以下内容**永不进入日志**：Cookie / Set-Cookie、Authorization、`x-csrf-token`、请求与响应 body、
  任何 query string 中的值（OIDC/OAuth2 callback 的 `code`、`state` 等）、password、token、Worker
  credential、exchange code、IdP 响应。通过 pino redaction 与“只记录白名单字段”两层保证。
- 替换现有静默吞掉的错误：Control Plane 周期 offline 检查、Worker 恢复问题、Worker Gateway 上游错误、
  Worker control channel 错误都改为带上下文的 `warn`/`error` 日志；不改变其原有的 fail-closed 行为。
- 现有 `console.*` 输出（`create-user`、`migrate-cli` 等 CLI 的结果提示）保持为面向人的 stdout，不纳入
  结构化日志。

### 13.3 Control Plane 按领域拆分

- `apps/control-plane/src/app.ts` 只保留 `buildControlPlane` 的组装逻辑。共享的认证、Origin/CSRF 校验、
  Worker 命令分发等 helper 集中到一个 route context；路由按领域拆到 `src/routes/`：health、
  local auth、external auth（OIDC/OAuth2）、workspaces、audit、admin users、admin workers/workspaces。
  public 表示层函数与 HTTP 工具（errorBody、cookie）单独成文件。
- `app.test.ts` 同步拆分：共享夹具（`createTestDependencies`、`login`、Worker 响应 helper）移到测试
  支持文件，测试按领域分文件。**只移动，不修改断言**；拆分前后测试条目数与名称一致作为校验。
  `test:e2e` 脚本更新为新文件列表。

### 13.4 数据库 repository 按领域重组

- 以单一的 `createRepository(database, selectWorker)` 取代 `createPhase1Repository` …
  `createPhase12Repository` 的继承链，内部按领域组织：users & sessions、workspaces、workspace
  lifecycle、workers、scheduling、recovery、audit、identities。唯一的同名覆盖 `markWorkersOffline`
  只保留当前生效的版本（同时把 Workspace 置为 `WORKER_OFFLINE` 的实现）。
- `create-user`、`provision-worker` 等 CLI 改用同一个 repository。
- **migration 文件名与 `platform_migrations` 记录保持不变**（它们已写入已部署数据库）。
- 删除应用代码已不再调用、只被旧集成测试使用的 7 个方法（见 13.7 待决问题 Q1）。

### 13.5 仓库整理

- `mock_weaver.py`（手工 OAuth2 + UserInfo 联调用的模拟 IdP）移到 `tools/dev/`，并在
  `docs/authentication-runbook.md` 补充用途与用法；它只用于开发，不进入部署产物。

### 13.6 验收

自动验收：

- CI 在 ARM64 上全绿；runtime-toolchain 的 AMD64 与 ARM64 任务各至少成功一次，capability matrix
  更新为原生证据。
- 拆分前后：Control Plane 测试条目数与名称一致，全部测试、e2e、真实 PostgreSQL 集成测试通过。
- 日志脱敏测试：对登录、OIDC/OAuth2 callback、Workspace open/exchange、Worker 连接等路径发请求，断言
  日志输出中不包含测试用 password、Cookie、CSRF token、authorization code、Worker token、exchange code；
  变异检查：去掉 redaction 时测试应失败。

人工验收步骤在 Phase 完成时随交付说明给出，至少覆盖：GitHub Actions 结果检查、本地启动 Control Plane
与 Worker 后的完整 Portal 回归（登录、创建/启动/打开/停止/删除 Workspace、各 admin 页面、暂停调度）、
检查日志中能按 request ID 追踪一次 Workspace 打开且无凭据、Worker 重启后 reconciliation 正常。

### 13.7 已确认决策

负责人已确认以下四项均按建议执行。

- **Q1**：删除 7 个已无调用方的 repository 方法（`listEligibleWorkerIds`、`listWorkerOfflineWorkspaces`、
  `reconcileWorkerOfflineWorkspace`、`beginWorkspaceStart`、`bindUserIdentity`、`completeOidcLogin`、
  `provisionWorker`），并把只测它们的集成测试改为测当前实际使用的方法？建议删除：它们代表已被取代的
  语义（例如绕过 Scheduler 的启动），保留会误导后续开发。
- **Q2**：`app.test.ts` 是否一并拆分？建议拆分，并以测试条目数与名称不变作为校验。
- **Q3**：每个 Phase 通过 GitHub pull request 合入（CI 记录与验收记录都留在 PR 上）？建议是。
- **Q4**：开发时是否需要 `LOG_FORMAT=pretty`（引入 `pino-pretty` 作为开发依赖）？建议需要，生产默认 JSON。

## Phase 14：Workspace 网络出口控制

状态：**已验收（2026-10-06）**，经 PR #2 合入 master，tag `v1.0.0-alpha.2`（2026-10-05 负责人确认 14.11 全部按建议执行）；运维说明见 `docs/egress-runbook.md`。方向见第 44 节与 `docs/v1-roadmap.md` 决策 D3。

目标：Workspace 默认可以访问公网，但不能访问内网与 Worker 宿主机；内网目标只能由管理员按网段/端口
放行；平台管理地址永远不可放行；规则缺失或无法确认时 fail-closed。

### 14.1 开工环境核查（Q8B，2026-10-05，只读）

| 项 | 结果 | 对设计的影响 |
|---|---|---|
| OS / 内核 | Ubuntu 26.04.1，Linux 7.0.11 aarch64 | nftables interval 拼接集合、`fib` 表达式可用 |
| Docker | 29.8.1（API 1.56），`Firewall Backend: iptables`，userland proxy 开启，无 `daemon.json` | Docker 规则经 `iptables-nft` 写入 nf_tables |
| iptables | 1.8.11 `(nf_tables)`；nft 1.1.6；ufw / firewalld / nftables.service 均未启用 | 平台规则放在独立 nftables 表中，与 Docker 的表并存 |
| sysctl | `ip_forward=1`，IPv6 `forwarding=0`，`bridge-nf-call-iptables=1`，`route_localnet=0` | 宿主机不转发 IPv6 |
| 运行身份 | Worker 以 `radxa`（docker 组，非 root）经 `tsx watch` 运行 | 当前 Worker **没有**写 netfilter 的权限（见 14.4） |
| Workspace 网络 | 每 Workspace 一个 bridge，名称为 Docker 默认的 `br-<id>`；`EnableIPv6=false`，容器内 `eth0` 的 `disable_ipv6=1`；`enable_icc=false`；端口只绑定 `127.0.0.1` | 需要可匹配的固定 bridge 名称（见 14.3） |
| 容器重启策略 | `unless-stopped` | 宿主机重启后 Docker 先于 Worker 拉起容器，**规则必须在 Docker 启动前就位**（见 14.4） |
| 容器 DNS | `127.0.0.11`（Docker 内置 DNS）；容器内 resolv.conf 注释为 `ExtServers: [host(100.100.100.100) host(fd7a:115c:a1e0::53)]`，即 dockerd 在宿主机网络命名空间中向上游转发 | DNS 不经过 Workspace bridge：拒绝宿主机地址与内网不影响解析，即使上游 DNS 位于内网。由特权集成测试确认 |
| Clash Verge | mihomo TUN：`stack: gvisor`、`auto-route`、`strict-route: false`、fake-ip `198.18.0.1/16`、`dns-hijack any:53`；接口 `Meta`；策略路由 `not iif lo → table 2022 (default via Meta)`，非默认路由仍走 `main` | 见 14.8 |
| Tailscale | `tailscale0` 100.112.169.46，路由表 52 | 默认不拦截（D3） |
| 宿主机监听 | Control Plane `0.0.0.0:3000/3001`、Worker Gateway `0.0.0.0:3100`、Clash mixed `*:7897`、Clash DNS `*:53`、ssh 等 | 全部可被 Workspace 通过网关地址访问（下表） |

在现有 Workspace 容器内用 `/dev/tcp` 实测（不改动任何状态）：

| 目标 | 现状 |
|---|---|
| 网关 `172.22.0.1`：Worker Gateway 3100、Control Plane 3000、Clash 7897、Clash DNS 53 | **可连** |
| 宿主机 LAN `192.168.1.124`：3100、22；Tailscale 地址 3000；`docker0` 地址 3000 | **可连** |
| LAN 路由器 `192.168.1.1:80` | **可连** |
| 其他 Workspace 的 pi-web（`172.21.0.2`）、其他 compose 网络的 PostgreSQL 容器 | 不可连（Docker 在 `raw PREROUTING` 按目的容器地址与入口 bridge 丢弃，已有隔离有效） |
| `10.1.2.3:80`（不存在的地址） | **显示可连**：经 TUN 由 gvisor 栈代为完成握手，并非真实可达 |
| 域名解析 | 返回 fake-ip（`198.18.0.x`、`fdfe:dcba:9876::x`） |

结论：G1 属实，并且在开发设备上还会让 Workspace 使用宿主机的 Clash 代理端口。

负责人以 root 导出的规则（`nft list ruleset`、`iptables-save`、`ip6tables-save`、`iptables-legacy-save`）：

- 只有 iptables-nft 管理的表（`ip`/`ip6` 的 `filter`、`nat`、`raw`、`mangle`）；legacy 后端为空；
  不存在其他 `inet` 表。
- `filter FORWARD` / `INPUT` 默认策略均为 `accept`；`DOCKER-USER` 为空。FORWARD 依次跳转
  `ts-forward` → `DOCKER-USER` → `DOCKER-FORWARD`；Workspace bridge 的出站由 `DOCKER-FORWARD` 的
  `iifname "br-…" oifname != "br-…" accept` 放行。
- Tailscale（iptables-nft 模式）写入 `ts-input`、`ts-forward`、`ts-postrouting` 与 `mangle` 中的
  fwmark 规则；`ts-forward` 对 `oifname "tailscale0"` 执行 `accept`。nftables 中 `accept` 只结束本表
  的判定，平台表的 `drop` 仍然生效，因此不冲突。
- mihomo（Clash）没有写入任何 netfilter 规则，只使用 TUN 接口与策略路由。
- Docker 在 `nat PREROUTING` 以 `fib daddr type local` 跳转 DNAT，在 `raw PREROUTING` 为每个容器地址
  做入口 bridge 校验；pi-web 发布端口的 DNAT 只匹配 `ip daddr 127.0.0.1`。

### 14.2 范围与非目标

范围：

- 所有受管 Workspace 的出站流量按 14.3 的规则过滤：拒绝 Worker 宿主机全部地址、RFC1918、管理员追加的
  拒绝网段；平台管理地址始终拒绝；管理员白名单放行内网中的具体网段或网段+协议+端口。
- 默认拒绝 Workspace bridge 上的一切 IPv6 流量（Workspace 网络继续不启用 IPv6）。
- Worker 下发、校验、在漂移时恢复规则；规则无法确认时拒绝启动 Workspace（14.5）。
- 宿主机启动时在 Docker 之前加载规则（14.4）。
- Control Plane：出口规则的数据模型、Admin API、Portal 页面、Audit，以及向 Worker 分发（14.6、14.7）。
- 调度：未确认出口规则生效的 Worker 不接受新的 placement，也不能启动 Workspace。

非目标（v1.0 不做）：

- 域名级策略、HTTP(S) 代理、TLS 检查；DNS 过滤或 DNS 外泄防护（容器仍可经 dockerd 解析内网域名，
  但解析到的内网地址按本节规则拒绝）。
- Workspace 级、用户级的不同策略；入站方向的新控制（入站仍只有经 Gateway 的 pi-web）。
- 带宽限制、连接数限制、出口流量审计（Phase 17 只做指标）。
- 针对 Clash / Tailscale 的默认规则（D3）。
- Workspace IPv6 出网。

### 14.3 规则模型

规则放在平台独占的 nftables 表 `inet agent_runtime` 中，**不修改 Docker 的表和链，也不使用
`DOCKER-USER`**。nftables 中同一 hook 上任何一个表的 `drop` 都是最终结果，因此平台表与 Docker 的规则
（无论 Docker 使用 iptables-nft、iptables-legacy 还是 nftables 后端）独立生效，Docker 重启或重建自身
规则不会清除平台规则。

Workspace bridge 改为固定名称 `arw-<Workspace UUID 去掉连字符后的前 11 个十六进制字符>`（`arw` 取
**a**gent-**r**untime **w**orkspace；共 15 字符，Linux 接口名上限），通过 network option `com.docker.network.bridge.name` 设置。规则用接口名前缀
`arw-*` 匹配，因此**规则本身是静态的、不依赖逐个 Workspace 登记**：新建 bridge 一出现就被覆盖，
宿主机刚启动、Worker 尚未运行时同样生效。`iifname` 由内核根据实际入口接口给出，容器无法伪造。

结构（示意，具体以实现的 JSON 渲染为准）：

```text
table inet agent_runtime {
  set deny_default_v4  { type ipv4_addr; flags interval;   # 静态：RFC1918
                         elements = { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } }
  set deny_extra_v4    { type ipv4_addr; flags interval; }   # 管理员追加的拒绝网段
  set protected_v4     { type ipv4_addr; flags interval; }   # 平台管理地址，永不放行
  set allow_net_v4     { type ipv4_addr; flags interval; }   # 白名单：整个网段
  set allow_svc_v4     { type ipv4_addr . inet_proto . inet_service; flags interval; }  # 白名单：网段+协议+端口

  chain ws_prerouting {                    # hook prerouting，priority -150（conntrack 之后、DNAT 之前）
    iifname != "arw-*" return
    ct direction reply accept              # pi-web 对入站（经 127.0.0.1 发布端口）连接的回包
    meta nfproto ipv6 drop
    fib daddr type { local, broadcast, multicast } drop   # Worker 宿主机全部地址，含 DNAT 之前的目标
  }
  chain ws_forward {                       # hook forward，priority -10
    iifname != "arw-*" return
    ct direction reply accept
    meta nfproto ipv6 drop
    ip daddr @protected_v4 drop            # 先拒绝平台管理地址
    ip daddr . meta l4proto . th dport @allow_svc_v4 accept
    ip daddr @allow_net_v4 accept
    ip daddr @deny_default_v4 drop
    ip daddr @deny_extra_v4 drop
  }                                        # 其余（公网）交给 Docker 自身规则照常放行
}
```

要点：

- **宿主机地址**在 prerouting 用 `fib daddr type local` 判定，覆盖宿主机当前与将来出现的所有地址
  （LAN、Docker 网关、`docker0`、Tailscale、公网 IPv6 对应的 IPv4 等），也覆盖“连宿主机地址上被
  Docker 发布并 DNAT 到其他容器的端口”这条路径。白名单**不能**放行宿主机地址：Worker 宿主机上运行着
  Worker Gateway 与 Docker，按平台管理地址处理。
- 拒绝逐包生效（只豁免 conntrack 的 reply 方向），因此删除白名单或追加拒绝网段会立即切断已建立的
  出站连接，无需清理 conntrack。
- `protected_v4` 由两部分合并：Control Plane 下发的（`PLATFORM_EGRESS_PROTECTED` 显式配置，加上
  `DATABASE_URL` 主机解析出的地址）与 Worker 本地的（`CONTROL_PLANE_URL` 主机解析出的地址，加上
  `WORKER_EGRESS_PROTECTED` 显式配置）。即使 Control Plane 位于公网或 Tailscale 地址，Workspace 也
  无法连接它。主机名解析结果只在每次下发时刻生效，文档建议生产环境显式配置地址。
- 公网目标不在本表中做任何放行动作，仍由 Docker 自身规则与 MASQUERADE 处理。
- 只处理 IPv4 网段；`deny_default_v4` 不包含 `169.254.0.0/16`、`100.64.0.0/10`，按部署环境追加
  （第 44 节）。

### 14.4 特权与启动顺序

写入和读取 netfilter 都需要 `CAP_NET_ADMIN`。当前 Worker 以 docker 组普通用户运行，没有该权限。

建议方案（见 14.11 Q1）：

- **Worker 进程获得 ambient `CAP_NET_ADMIN`**，自身管理 `inet agent_runtime` 表：通过
  `spawn("/usr/sbin/nft", ["-j", "-f", <私有临时文件>])` 提交一个 JSON 原子事务（nft 1.1 之前不接受管道输入；固定 argv、无
  shell、所有元素先经 Zod 校验与规范化），用 `nft -j list table inet agent_runtime` 读回校验。docker 组
  本身已等价于 root，增加 `CAP_NET_ADMIN` 不扩大 Worker 的实际权限面。
  - 生产（Phase 19 的 systemd unit）：`AmbientCapabilities=CAP_NET_ADMIN`、
    `CapabilityBoundingSet=CAP_NET_ADMIN`。
  - 开发：`tools/dev/run-worker-with-egress.sh <env 文件>`，即 `sudo setpriv --reuid --regid --init-groups
    --inh-caps=+net_admin --ambient-caps=+net_admin` 后以原用户运行 `pnpm dev:worker`；不对 node 二进制做
    `setcap`。
- **启动顺序**：新增 root oneshot unit `agent-runtime-egress.service`（`Before=docker.service`，
  `WantedBy=multi-user.target`）。它先加载 Worker 最近一次成功应用后原子写入的快照
  `${WORKER_MANAGED_ROOT}/egress/ruleset.json`；快照缺失或加载失败时加载随仓库发布的基础规则
  `deploy/egress/agent-runtime-egress.nft`（结构相同、动态集合为空，即“拒绝全部内网与宿主机，无
  白名单”）。这样宿主机重启后 Docker 按 `unless-stopped` 拉起的容器从第一个包起就受控。
- Ubuntu 默认 `/etc/nftables.conf` 以 `flush ruleset` 开头；启用 nftables.service 会清掉平台表（以及
  Docker 的规则），由 14.5 的周期校验发现并恢复。runbook 中说明这一点。

被否决的方案：

- 由 root 管理员维护静态规则文件、Worker 只读：白名单无法由 Admin UI 管理，且读取规则同样需要
  `CAP_NET_ADMIN`。
- Worker 用 Docker 启动一个 `--network host --cap-add NET_ADMIN` 的 helper 容器代为执行：违背
  Runtime 安全基线的表述，且需要额外管理并 pin 一个多架构镜像。
- 把 Workspace 网络改为 `Internal: true` 并经 HTTP 代理出网：非 HTTP 流量（git over ssh 等）不可用，
  内部网络也不支持端口发布，属于 v1.x 的域名级策略范畴。

### 14.5 Worker 行为

- **网络**：新建 Workspace 网络带 `com.docker.network.bridge.name=arw-…`；`#verifyManagedNetwork`
  增加检查该 option 与 `EnableIPv6=false`。若该接口名已被非受管接口或网络占用，返回
  `UNMANAGED_NETWORK_CONFLICT`，不复用。
- **存量网络迁移**：已有 Workspace 的 `br-<id>` 网络不满足新校验。Workspace 处于停止状态时，下一次
  `workspace.ensure` / `workspace.start` 由 Worker 原地迁移：断开容器 → 删除旧受管网络 → 以同名、新
  option 重建 → 重新连接（每一步都校验 managed label）。迁移完成前不启动容器。运行中的存量 Workspace
  见 14.11 Q4。
- **出口状态**：Worker 维护 `egress = { enforced: boolean, revision: number | null }`。`enforced=true`
  的条件：表存在、链与 hook/priority/规则结构与期望一致、静态集合元素正确、动态集合内容与最近一次
  应用的策略一致。
- **启动门禁**：`workspace.ensure`（会创建或启动容器时）与 `workspace.start` 在启动容器前同步校验一次；
  `enforced=false` 时返回新的错误码 `EGRESS_UNENFORCED`，不启动。
- **Worker 启动 / 重连**：先校验，缺失或漂移则重新应用（基础规则 + 最近一次策略快照），再发送
  `worker.hello`。
- **周期校验**：随心跳（默认 10s）校验；发现漂移立即重新应用并记 `warn` 日志；重新应用失败时
  `enforced=false`，并对正在运行的受管 Workspace 执行 14.11 Q3 选定的处置。
- **reconciliation**：observed state 中增加网络名称/接口名校验结果；`worker.reconcile` 的完整
  inventory 也校验出口状态，不满足时运行中的 Workspace 不得恢复为 `RUNNING`。
- 没有 `CAP_NET_ADMIN` 时 Worker 仍能启动、注册和上报（`enforced=false`），但不会启动任何 Workspace；
  日志给出明确原因。不提供“关闭出口控制”的开关。

### 14.6 Control Plane：数据模型、API、Portal、Audit

migration `0010_egress_policy`：

```text
egress_rules
  id           uuid primary key (server generated)
  action       text not null check (action in ('allow', 'deny'))
  network      cidr not null check (family(network) = 4)
  protocol     text null check (protocol in ('tcp', 'udp'))
  port_min     integer null, port_max integer null   -- 仅 allow 且指定 protocol 时可用，1..65535，min <= max
  description  text not null default ''              -- <= 200 字符
  created_by   uuid not null references users(id)
  created_at   timestamptz not null default now()
  unique nulls not distinct (action, network, protocol, port_min, port_max)

egress_policy_state                                   -- 单行
  revision     bigint not null                         -- 每次规则变化在同一事务内 +1

workers
  + egress_enforced    boolean not null default false
  + egress_revision    bigint null
  + egress_checked_at  timestamptz null
```

校验（Control Plane，失败返回 400/409 与 error code）：

- `network` 为规范化的 IPv4 CIDR（主机位为 0），前缀长度 ≥ 8；不接受 IPv6。
- `allow` 必须完全落在 RFC1918 ∪ 现有 `deny` 规则之内（放行公网无意义）；不得与 Control Plane 已知的
  protected 地址重叠（Worker 本地 protected 由 nft 规则顺序兜底）。
- 删除一条 `deny` 时，若有 `allow` 依赖它才落在拒绝范围内，返回 409，要求先删除对应 `allow`。
- 规则总数上限 1000。

Admin API（admin role、CSRF、Origin 校验与现有 admin 路由一致）：

- `GET /api/admin/egress`：`{ revision, defaultDeny, protected, rules[], workers[{ id, enforced,
  revision, checkedAt }] }`。
- `POST /api/admin/egress/rules`：`{ action, network, protocol?, portMin?, portMax?, description? }`。
- `DELETE /api/admin/egress/rules/:id`。
- 不提供修改，修改 = 删除 + 新建，便于审计。

Audit：`egress.rule_created`、`egress.rule_deleted`，details 含 action、network、protocol、端口、
description、新 revision 与 request ID；Worker 上报的状态翻转记 `worker.egress_enforced` /
`worker.egress_unenforced`。Worker 上报 `enforced=false` 时，其 `RUNNING` 的 Workspace 在同一事务内置为
`ERROR`（Worker 已按 Q3 停止它们）。Audit 新增类别 `egress`。

错误码：`EGRESS_ALLOW_OUTSIDE_DENY`、`EGRESS_ALLOW_OVERLAPS_PROTECTED`、`EGRESS_RULE_LIMIT`、
`EGRESS_RULE_EXISTS`（409），`EGRESS_RULE_IN_USE`（删除被依赖的 deny，409），`EGRESS_RULE_NOT_FOUND`
（404）。删除时只做依赖检查，不因 protected 配置的后续变化而拒绝删除。

Portal：

- Admin 新增“网络出口”页面：显示默认拒绝网段、平台保护地址（只读）、规则列表、新增/删除，以及各 Worker
  已应用的 revision 与 enforced 状态。
- Admin Workers 页面增加“出口控制”状态列；`enforced=false` 时用告警色。
- Workspace 启动失败为 `EGRESS_UNENFORCED` 时显示中文说明（“Worker 网络出口规则未生效，暂时无法启动”）。

调度：`enforced=false` 或 revision 落后于当前策略的 Worker 不参与新的 placement；对已有 assignment 的
start，Control Plane 先下发策略，仍不满足时返回 `EGRESS_UNENFORCED`，不改 sticky placement。

### 14.7 Worker Protocol

协议版本 `WORKER_PROTOCOL_VERSION` 升到 `2`（schema 均为 strict，Control Plane 与 Worker 同时升级；
Control Plane 对 v1 hello 返回明确的版本错误，见 14.11 Q5）：

- `worker.hello` / `worker.heartbeat` 的 payload 增加 `egress: { enforced: boolean, revision:
  number | null }`。
- 新命令 `worker.egress.apply`：`{ revision, allow: [{ network, protocol?, portMin?, portMax? }],
  denyExtra: [network], protected: [network] }`，数组上限 1000，元素用共享 Zod schema 校验 CIDR。
  Worker 合并本地 protected 后原子应用，成功返回 `{ egress: { enforced, revision } }`；revision 小于已应用值时
  忽略并返回当前状态；应用失败返回 `EGRESS_APPLY_FAILED`（retryable），并继续执行之前的规则。
- Control Plane 在 Worker 每次 authenticated hello 之后、`worker.reconcile` 之前下发当前策略；规则变化
  时向所有在线 Worker 下发。离线 Worker 保留上一次快照（可能比当前策略更宽或更严），重连后立即更新。
- 新错误码 `EGRESS_UNENFORCED`、`EGRESS_NETWORK_LEGACY`、`EGRESS_APPLY_FAILED`。

### 14.8 开发环境：Clash 与 Tailscale

Clash Verge 与 Tailscale 是负责人开发设备上的工具，与业务无关，默认规则不针对它们（D3）。但平台必须在
这些设备上行为正确、可以测试和验收。逐项处理如下：

| 现象 | 平台的处理 |
|---|---|
| Workspace 可连宿主机上的 Clash 代理 `7897`、Clash DNS `53`、Clash 控制端口，以及宿主机的 Tailscale 地址 | 属于“Worker 宿主机地址”，由 prerouting 的 `fib daddr type local` 统一拒绝，无需专门规则 |
| TUN 策略路由把转发流量送往 `Meta` | 平台规则按**入口接口 + 真实目的地址**判定，与路由选择无关：forward hook 在 TUN 之前看到真实目的地址，内网 IP 字面量在进入 TUN 前已被丢弃 |
| Tailscale `ts-forward` 对 `tailscale0` 出口执行 `accept` | 平台表独立，`drop` 为最终结果；若设备接受了 Tailscale subnet route（例如经 `tailscale0` 到达 `10.x`），同样按目的地址拒绝 |
| Tailscale `100.64.0.0/10` 默认不拒绝 | D3 接受。需要在开发设备上验证时，在 Admin 页面追加拒绝网段 `100.64.0.0/10`；DNS 不受影响（dockerd 在宿主机命名空间解析，见 14.1） |
| Control Plane 与 Worker 经 Tailscale 跨主机通信 | Worker 把 `CONTROL_PLANE_URL` 解析出的地址（含 `100.x`）加入 protected，Workspace 无法连接 Control Plane |
| fake-ip：域名解析为 `198.18.x.x`，由 mihomo 在宿主机发起真实连接，平台看不到真实目的地址 | **开发环境的已知限制**，生产环境无 Clash。默认规则不拒绝 `198.18.0.0/15`（否则开发设备上所有域名访问失败）。需要验证“内网域名”场景时，把 mihomo `dns.enhanced-mode` 改为 `redir-host`（DNS 返回真实地址，TUN 照常接管公网流量），或关闭 TUN |
| gvisor 栈为任意经 TUN 的目的地址完成 TCP 握手，“能 connect”不等于可达 | 测试与验收工具只以**应用层响应**判定可达；被平台拒绝的目标表现为超时 |
| 宿主机 resolver 为 Tailscale MagicDNS，DNS 被 `dns-hijack any:53` 接管 | 不影响平台规则（DNS 不经过 Workspace bridge） |

平台为此提供：

- **Worker 启动时的环境诊断日志**（只读、无需 root）：读取 `ip -j rule` / `ip -j route show table all`
  与接口列表，发现“默认路由经 TUN 类接口的策略路由”时记 `warn`（说明域名目标可能经用户态代理绕过出口
  规则，仅影响开发环境）；发现 `tailscale0` 时记 `info`（`100.64.0.0/10` 默认不拒绝，可按需追加）。
  诊断结果只用于提示，不改变 `enforced` 判定，也不新增配置开关。
- **特权集成测试不依赖 TUN 状态**：测试用 network namespace 中的“内网/公网”主机都是直连路由
  （`main` 表中的非默认前缀，Clash 的 `suppress_prefixlength 0` 规则不会把它们送往 `Meta`），并以 HTTP
  响应判定，开启或关闭 TUN 结果一致。
- **开发验收探测工具** `tools/dev/egress-probe.sh`：在指定 Workspace 容器内（`docker exec`）对一组
  `IP:端口` 目标发送请求，输出 `REACHABLE`（收到应用层数据）/ `BLOCKED`（连接失败或超时）/
  `HANDSHAKE_ONLY`（握手成功但无数据，典型为 TUN 代答），避免把 TUN 的假握手误判为可达。

人工验收分两轮：关闭 TUN 做完整一轮；开启 TUN（fake-ip）再做 IP 字面量一轮并确认宿主机端口不可达。

### 14.9 测试计划

单元 / 组件测试（CI 常规任务）：

- 策略校验：CIDR 规范化、前缀长度、IPv6 拒绝、allow 必须落在拒绝范围内、与 protected 重叠拒绝、
  deny 被依赖时删除 409、端口与协议组合、上限。
- nft JSON 渲染：给定策略生成的事务与快照一致；对读回结果的结构比较能识别缺链、缺规则、hook/priority
  不同、集合元素不同。
- 协议 schema：v2 hello/heartbeat/`worker.egress.apply` 的正反例；v1 hello 被拒绝。
- Worker：`enforced=false` 时 ensure/start 返回 `EGRESS_UNENFORCED` 且未调用 Docker 启动；网络 option
  校验；存量网络迁移的调用顺序与 label 校验（fake Docker）。
- Control Plane：Admin API 授权（user 403、未登录 401、CSRF）、Audit 写入、revision 递增、调度排除
  `enforced=false` 或 revision 落后的 Worker、hello 后先 apply 再 reconcile。
- migration 在 `agent_runtime_test` 上验证。

真实内核测试（`pnpm test:egress`）：在非特权 user + network namespace（`unshare --user
--map-root-user --net`）中运行，不需要 root、不需要 Docker、不改动宿主机；CI 在 ARM64 runner 上安装
`nftables` 并放开 AppArmor 的 userns 限制后运行。

- 用 network namespace + veth 模拟“容器”（挂在 `arw-` bridge 上）、非 Workspace bridge 上的对照容器、
  内网主机 `10.99.0.2` 与“公网”主机 `203.0.113.2`（TEST-NET-3），全部是直连路由，因此不受开发设备上
  Clash TUN 与 Tailscale 影响。
- 断言：宿主机全部地址（bridge 网关、其他接口、“公网”侧地址、IPv6）不可达；内网主机不可达；“公网”主机
  可达；非 Workspace bridge 不受影响；宿主机到容器的入站连接（pi-web 路径）正常；`allow_svc` 只放行指定
  端口；protected 优先于 allow；管理员追加的拒绝网段生效；删除白名单后已建立连接被切断；删除平台表后
  `ensure` 恢复规则；随仓库发布的基础规则文件与 Worker 快照都能由 `nft` 加载，并与 Worker 的校验一致。
- 真实 Docker 集成测试（`pnpm test:e2e:runtime`）覆盖 `arw-` bridge 命名与停止状态下的存量网络迁移。
- start 门禁、Gateway 门禁、规则丢失时停止运行中的 Workspace 由 Worker 单元测试覆盖。
- 容器 DNS 在拒绝全部内网时仍可用（dockerd 在宿主机命名空间转发）依赖真实 Docker，放在人工验收中确认。
- **变异检查**（已执行）：去掉 prerouting 的 `fib daddr type local` 规则、去掉 protected 规则、改错
  `iifname` 前缀，真实内核测试分别失败；去掉 Worker start 门禁、Gateway 门禁、Control Plane start 门禁、
  调度器的出口条件，对应单元测试分别失败。

### 14.10 验收

自动验收：上述测试全部通过，CI 绿（含真实内核出口测试）。

人工验收（详细步骤随交付说明给出），至少覆盖：

1. 安装 `agent-runtime-egress.service`，以带 `CAP_NET_ADMIN` 的方式启动 Worker；Admin Workers 页面显示
   出口控制已生效。
2. 关闭 Clash TUN：在 Workspace Terminal 中访问 Worker Gateway、Control Plane、宿主机 ssh、LAN 路由器、
   PostgreSQL 全部失败；访问公网 HTTPS 成功；`git clone`、`pnpm install`、`uv pip install` 正常。
3. 在 Admin 页面添加 `192.168.1.1/32 tcp 80` 白名单：路由器 80 可访问、443 仍不可；尝试添加覆盖
   Control Plane 地址的白名单被拒绝；删除白名单后访问立即失败；Audit 中有对应记录。
4. 存量 Workspace：停止后再启动，网络迁移为 `arw-` bridge，文件与 Pi Session 完整。
5. `sudo nft delete table inet agent_runtime`：Worker 在一个心跳周期内恢复规则并记日志；在恢复失败场景
   （如去掉 `CAP_NET_ADMIN` 重启 Worker）下 Workspace 无法启动，Portal 显示原因。
6. 重启 Worker 宿主机：`agent-runtime-egress.service` 先于 Docker 加载规则；Docker 拉起的 Workspace 在
   Worker 启动前即不可访问内网；Worker 启动后 reconciliation 正常、白名单恢复。
7. 开启 Clash TUN 重复第 2 步的 IP 字面量部分，并确认 `7897`、`53` 等宿主机端口不可达。

### 14.11 已确认决策

负责人已确认 Q1–Q8 全部按建议执行（2026-10-05）。

- **Q1 特权方式**：Worker 进程以 ambient `CAP_NET_ADMIN` 自行管理 nftables 表 + root oneshot unit 在 Docker
  之前加载快照（14.4）？建议采用。
- **Q2 bridge 命名**：改为固定前缀 `arw-` 并按前缀匹配，存量网络在停止状态下迁移？建议采用：这是规则在
  宿主机启动时、Worker 运行前即可覆盖全部 Workspace 的前提。
- **Q3 规则丢失且无法恢复时如何处置运行中的 Workspace**：建议由 Worker 停止这些容器（数据与 Pi Session
  保留），Workspace 进入 `ERROR`（`EGRESS_UNENFORCED`）并记 Audit，规则恢复后由用户重新启动；备选是只
  拒绝新的启动、保持已运行的容器（不满足 fail-closed）。
- **Q4 升级时仍在运行的存量 Workspace**：建议 runbook 要求升级前停止全部 Workspace；若 reconciliation
  发现运行中的存量网络，按 Q3 同样处置（停止并置 `ERROR`），用户再次启动即完成迁移。
- **Q5 协议版本**：升到 v2 且不兼容 v1（Control Plane 与 Worker 必须同时升级）？建议是，与当前单负责人
  部署方式一致，避免为过渡期写兼容分支。
- **Q6 `offline` 模式**：路线图写“预留”。建议本 Phase 不加数据库字段、API 或协议字段，只在文档中保留
  方向；如需要现在实现，代价是一个 `egress_mode` 字段、一个按接口名的 nft 集合和一个 Portal 开关。
- **Q7 拒绝网段的配置位置**：建议追加拒绝网段与白名单一样存在 Control Plane（Admin UI 管理、全局生效、
  记 Audit）；平台保护地址由 `PLATFORM_EGRESS_PROTECTED` / `WORKER_EGRESS_PROTECTED` 环境变量配置，
  不在 UI 中编辑。
- **Q8 白名单是否允许 Worker 宿主机地址**：建议不允许（宿主机即平台管理地址）。如果 Phase 16 的模型网关
  部署在 Worker 宿主机上，届时以“网关推理端口”作为单独、受限的例外设计，而不是开放通用白名单。

## Phase 15：资源与认证防护

状态：**已验收（2026-10-06）**，经 PR #3 合入 master，tag `v1.0.0-alpha.3`；运维见 `docs/storage-runbook.md` 与 `docs/authentication-runbook.md`。方向见 `docs/v1-roadmap.md` Phase 15（G2、G3）。

目标：单个 Workspace 不能写满 Worker 磁盘、耗尽宿主机文件句柄或用日志撑满 Docker 目录；超限只影响该
Workspace 自身；Portal 能看到已用/上限。本地登录与 SSO 入口能抵御暴力破解，失败与锁定可审计，Local Admin
break-glass 不会被外部攻击者锁死。无法确认配额生效时 fail-closed。

### 15.1 开工环境核查（Q8B，2026-10-06，只读）

磁盘与存储：

| 项 | 结果 | 对设计的影响 |
|---|---|---|
| `WORKER_MANAGED_ROOT` | `/var/lib/agent-runtime` 位于根文件系统 `/dev/nvme0n1p3`（ext4，938G，已用 9%），挂载选项 `rw,relatime`，**无 `prjquota`/`usrquota`** | 当前无法做任何目录级配额 |
| 根分区布局 | nvme 只有 `p1`（vfat 16M）、`p2`（ESP 1G）、`p3`（ext4 952.8G，根）三个分区，**无未分配空间、无 LVM** | 不能为数据目录新建分区或 LV；开发设备只能用 loop 镜像承载独立文件系统（15.3） |
| ext4 project quota | 负责人 `dumpe2fs -h` 确认：features 中**没有 `project` 与 `quota`**，inode size 256；启用需要 `tune2fs` 且文件系统**未挂载**（根分区需离线维护） | 不在根分区上启用 |
| 内核 | `CONFIG_QUOTA=y`、`CONFIG_QUOTACTL=y`、`CONFIG_XFS_FS=m`（`xfs.ko.zst` 存在）、`CONFIG_XFS_QUOTA=y`、`CONFIG_BLK_DEV_LOOP=m`、`CONFIG_TMPFS_QUOTA=y`、`CONFIG_DM_THIN_PROVISIONING=m` | XFS project quota 在本机内核可用 |
| 用户态工具 | `xfsprogs`（`mkfs.xfs`、`xfs_quota`）与 `quota` **未安装**（apt 候选 xfsprogs 6.18.0-3）；`losetup`、`chattr/lsattr`、`tune2fs`、`mkfs.btrfs` 已有 | 开发设备需安装 xfsprogs |
| Docker 存储 | Docker 29.8.1，`Driver: overlayfs`，`driver-type: io.containerd.snapshotter.v1`（**containerd image store**），data-root `/var/lib/docker`，快照位于 `/var/lib/containerd/…`，均在根 ext4 上；无 `daemon.json` | `--storage-opt size=` 依赖 overlay2 graph driver + XFS `pquota` 的 data-root，本机两项都不满足。负责人实测 `docker create --storage-opt size=1G …` **被接受且未报错**；底层 ext4 无 project quota，限制无从执行，推断为静默忽略——不能依赖它，也说明“参数被接受”不等于“限制生效” |
| 容器日志 | log driver `json-file`，`LogConfig.Config` 为空（**无大小上限**），位于 `/var/lib/docker/containers/<id>/` | Workspace 的 stdout/stderr 可无限占用根分区 |
| 宿主机 `/tmp` | tmpfs（`usrquota`），与容器无关 | — |
| swap | zram 7.5G；Workspace `MemorySwap` = 8GiB（2×Memory） | tmpfs 页可被换出，tmpfs 不是“纯内存”上限 |

运行中 Workspace（`ebd9d4cb…`）实测：

| 项 | 结果 |
|---|---|
| 挂载 | 只有 `/workspace`、`/agent/pi` 两个 `Binds`（宿主机目录，无配额）；`/`、`/tmp` 都在容器可写层（overlay upper 位于 `/var/lib/containerd/…`）；`/dev/shm` 64M tmpfs |
| 可写层大小 | `docker ps -s` = **1.34GB**：`/home/agent` 990M（其中 `.npm` 944M，另有用户安装到 `~/.claude/skills` 的内容）、`/tmp` 289M（用户 git clone 的仓库等） |
| agent 用户在根文件系统中可写的位置 | `/home/agent`、`/tmp`、`/var/tmp`、`/run/lock`（`/var/lock`）、`/usr/local/rustup/**` 与 `/usr/local/cargo/bin`（上游 rust 镜像 `chmod a+w`）；`/usr/local/cargo` 本身为 root 755，**推断** `cargo` 无法创建 `registry/`（实现时验证） |
| ulimit | `nofile` soft **1024** / hard 524288；`core` **unlimited**；`nproc` unlimited；`memlock` 8MiB；`HostConfig.Ulimits` 为空 |
| 宿主机 | `kernel.core_pattern = core`（core 文件写到进程当前目录，即 `/workspace`）；`fs.inotify.max_user_instances=128`、`max_user_watches=65536`；容器 `agent` 的 UID 1000 与宿主机 `radxa` 相同，未启用 userns-remap |
| 持久目录 | `/var/lib/agent-runtime/workspaces/<id>/{workspace,pi,metadata}`，属主 `radxa`，`0700` |

登录与认证（代码，`master` @ `25829b9`）：

- 本地登录 `POST /api/auth/login`（`routes/auth-local.ts`）：Origin 校验 → Zod 校验（失败记
  `auth.login_failed`/`invalid_request`）→ `findUserByLogin` → 对不存在的用户也用固定假 hash 跑一次
  scrypt（防用户枚举的时间差）→ 失败统一 401 `INVALID_CREDENTIALS` 并记 `auth.login_failed`/
  `invalid_credentials`。**没有任何限速、计数或锁定**；每次请求都执行一次 scrypt（CPU 成本可被滥用）。
- `auth.login_failed` 的 details 只有 protocol、provider、category、requestId、ipAddress、userAgent，
  **不含 login 标识与 user id**（Phase 12 决定）。成功事件为 `auth.login_succeeded`，另有 `auth.logout`、
  `auth.session_revoked`。
- SSO：`GET /auth/oidc/login`、`/auth/oidc/callback`、`/auth/oauth2/login`、`/auth/oauth2/callback`
  （`routes/auth-external.ts`）。失败分类 `provider_unavailable`、`transaction_invalid`、
  `protocol_validation_failed`、`identity_not_bound`、`provisioning_not_allowed`、`user_disabled`。
  transaction 存于进程内 `OidcTransactionStore`/`OAuth2TransactionStore`，上限 10 000 条、TTL 10 分钟，
  满了以后 `/login` 返回 503——**任何人反复请求 `/auth/*/login` 即可在 10 分钟内耗尽容量，阻断正常 SSO 登录**。
- 客户端 IP：`request.ip`，Fastify 未启用 `trustProxy`，即 TCP 对端地址。开发时 Portal 经 Vite proxy
  （`127.0.0.1:5173 → 127.0.0.1:3000`）访问，所有请求的 IP 都是 `127.0.0.1`；Phase 19 的生产反向代理同理。
  按 IP 限速前必须先解决“谁是真实客户端”。
- break-glass：已有“最后一个 active Local Admin 不能被禁用/降级”（advisory lock）。CLI 有
  `user:create`、`worker:*`，没有解锁类命令。

### 15.2 范围与非目标

范围：

- **磁盘配额**：每个 Workspace 的全部可写持久数据（`/workspace`、`/home/agent`、`/tmp`、`/agent/pi`）
  由 XFS project quota 硬限制字节数与 inode 数；容器根文件系统只读，可写层不再增长（15.3、15.4）。
- 容器日志大小上限；`nofile`、`core` ulimit（15.5）。
- Worker 校验配额生效，未生效时 fail-closed；存量容器在停止状态下迁移到新配置（15.6）。
- Control Plane：每 Workspace 的磁盘上限（全局默认 + admin 按 Workspace 调整）、用量上报与 Portal 显示、
  Audit（15.7）。Worker protocol v3（15.8）。
- **登录防护**：可信代理下的客户端 IP 解析；本地登录按“账户+IP”、IP、账户三个维度计数并临时锁定；SSO
  入口按 IP 限速；锁定事件记 Audit；admin 与 CLI 解锁；break-glass 不被锁死（15.9）。

非目标（v1.0 不做）：

- 用户自助选择磁盘规格、按用户/部门的总配额（路线图第 5 节）；按磁盘容量调度与超分控制（只显示，告警留给
  Phase 17）。
- 磁盘 I/O 带宽 / IOPS 限制（`blkio`/`io.max`）；网络带宽限制。
- 平台内清理用户数据（超限时由用户自行删除，或 admin 调高上限）；配额软限制与宽限期。
- 镜像层、Docker build cache、Worker 自身日志的容量管理（宿主机运维范畴）。
- 每 Workspace 的 inotify 实例/监视数隔离：这些是**按宿主机 UID** 计数的全局 sysctl，所有 Workspace 共享
  UID 1000，真正隔离需要 userns-remap（v1.x）。本 Phase 只在 runbook 中给出调高 sysctl 的建议（15.12 Q10）。
- 通用 API 限速、DDoS 防护、WAF；密码复杂度策略、MFA、CAPTCHA；IdP 侧的暴力破解防护（由 IdP 负责）。
- Workspace Host 的 exchange code 限速（60 秒、单次、256-bit 随机，不可暴力枚举）。

### 15.3 磁盘配额机制

**选定：独立的 XFS 文件系统承载 `WORKER_MANAGED_ROOT`，以 `prjquota` 挂载；每个 Workspace 分配 project
ID，对目录树设置硬上限。** 平台持久状态仍全部位于 `WORKER_MANAGED_ROOT`（决策 D5 的备份边界不变）。

- **生产**：`WORKER_MANAGED_ROOT` 使用独立磁盘、分区或 LV，`mkfs.xfs` 后以
  `defaults,prjquota` 挂载（`/etc/fstab` 或 systemd mount unit）。部署文档（Phase 19）给出模板。
- **开发设备（Q8B）**：nvme 无空闲空间，用根分区上的**稀疏镜像文件 + loop 设备**承载 XFS，例如
  `/var/lib/agent-runtime.xfs`（稀疏 300G）挂载到 `/var/lib/agent-runtime`。只用本机 nvme，不涉及 `/mnt`
  下的 NTFS 硬盘。由负责人按 runbook 用 sudo 执行（15.11 第 0 步），步骤包括迁移现有两个 Workspace 的数据。
  loop 镜像会占用根分区的实际写入量，这在开发环境可以接受。
- **v1.0 只支持 XFS**。ext4 project quota 使用相同的内核接口，但需要 `mkfs`/离线 `tune2fs` 启用特性，且
  `xfs_quota` 对 ext4 的“foreign”模式未在本项目验证；在 CI 取得证据前不宣称支持（15.12 Q1）。

**目录与 project 划分**（每个 Workspace 两个 project，15.12 Q4）：

```text
${WORKER_MANAGED_ROOT}/workspaces/<id>/
  metadata/                 # Worker 私有，不计入配额，容器不可见
  workspace/  -> /workspace     ┐
  home/       -> /home/agent    ├ data project：上限 = 该 Workspace 的 diskLimitBytes（admin 可调）
  tmp/        -> /tmp           ┘
  pi/         -> /agent/pi      ─ pi project：上限 = Worker 配置 WORKSPACE_PI_STATE_LIMIT_BYTES（默认 2GiB）
```

- data 与 pi 分开：用户写满 `/workspace` 时，Pi Session 的 JSONL 追加、settings 写入仍然成功，用户仍能在
  pi-web 中对话、用 Terminal 清理文件，避免 Pi Session 因配额写满而写坏（Workspace state 与 Pi Session
  state 分离的不变量在磁盘层面的体现）。
- 设置方式：对上述 4 个目录设置 project ID 与 `PROJINHERIT` 标志（其下新建的文件/目录自动继承），对 project
  设置 `bhard`（字节）与 `ihard`（inode）。`bsoft`/`isoft` 为 0（不使用软限制）。跨 project 的 `rename` 由
  内核返回 `EXDEV`（`mv` 自动退化为复制，按目标 project 计费），硬链接跨 project 被拒绝——这正是期望的隔离。
- **用量读取不需要特权**：对设置了 `PROJINHERIT` 的目录做 `statfs`，XFS 返回该 project 的上限与用量（Node
  `fs.statfs`）。因此容器内 `df -h /workspace` 直接显示配额而不是整块盘，用户体验一致。
- **project ID 分配**：Worker 在 `[WORKER_QUOTA_PROJECT_ID_MIN, +2^20)`（默认起点 `1000000`）内分配，
  写入该 Workspace 的 `metadata/managed.json`（`quota: { dataProjectId, piProjectId }`，Worker 已有的受管
  元数据文件）。分配在 Worker 进程内互斥，分配前扫描全部受管 Workspace 的元数据与 `xfs_quota` 报告中已使用
  的 ID，避免碰撞。目录自身的 project 属性是事实来源，每次启动前读回校验（15.6）。
- **特权**：设置 project 上限（`quotactl Q_XSETQLIM`）需要 `CAP_SYS_ADMIN`；读取 quota state 与 `statfs`
  不需要。建议沿用 Phase 14 的方式：Worker 进程获得 ambient `CAP_SYS_ADMIN`，以固定 argv
  `spawn("/usr/sbin/xfs_quota", ["-x", "-c", <命令>, <挂载点>])` 执行（无 shell；命令字符串只由校验后的
  整数 ID、整数字节数与 Worker 自身构造的受管路径拼成，路径先 `realpath` 并确认位于挂载点内、不是符号链接）。
  理由同 14.4：docker 组已等价于 root，不扩大 Worker 的实际权限面。生产 systemd unit 改为
  `AmbientCapabilities=CAP_NET_ADMIN CAP_SYS_ADMIN`；开发脚本 `tools/dev/run-worker-with-egress.sh` 已改名为
  `run-worker-privileged.sh` 并增加 `+sys_admin`（15.12 Q2）。
- **删除**：`workspace.delete` 删除目录后，把两个 project 的上限清零（`limit -p bhard=0 ihard=0`），ID 可复用。
- **超分**：所有 Workspace 上限之和可以超过文件系统容量（与当前按 assignment 计数的 capacity 一致，不预留
  空间）。Admin Workers 页面显示文件系统容量/已用与“已分配上限之和”，Phase 17 对文件系统剩余空间告警。

被否决的方案：

- **Docker `--storage-opt size=`**：只限制可写层；需要 overlay2 graph driver 且 data-root 位于 XFS
  `pquota`。本机使用 containerd image store，data-root 在 ext4 上。要用它就得更改整台宿主机的 Docker
  存储后端（禁用 containerd snapshotter、迁移 data-root、重新拉取全部镜像），并且仍然管不到 bind mount。
- **Docker local volume 的 `size` 选项**：数据会落在 Docker data-root 之下，违反“全部持久状态位于
  `WORKER_MANAGED_ROOT`”（D5 备份边界），且同样依赖 data-root 的文件系统。
- **每 Workspace 一个 loop 镜像 / LV**：每个 Workspace 都要由 Worker 执行 `mount`（同样需要
  `CAP_SYS_ADMIN`），宿主机重启后要在 Docker 之前挂好 N 个文件系统，扩容需要 `xfs_growfs`/`resize2fs`，
  空间按镜像预占或稀疏后难以回收。project quota 在一个文件系统内完成同样的隔离，调整上限即时生效。
- **在根 ext4 上启用 project quota**：需离线 `tune2fs`（根分区要从其他介质启动维护），且把平台数据与系统
  盘绑在一起；生产也不推荐。
- **定期 `du` 并在超限时停止 Workspace**：事后检测，两次采样之间仍可写满磁盘；大目录树 `du` 成本高。
- **btrfs subvolume qgroup**：内核与 `mkfs.btrfs` 可用，但 qgroup 在大量小文件与快照下有已知的性能与
  一致性问题，且 `statfs` 不反映 qgroup 上限；不作为 v1.0 机制。

### 15.4 容器可写层与 `/tmp`

**选定：容器根文件系统只读（`ReadonlyRootfs: true`），所有可写位置都来自受配额约束的目录或有上限的 tmpfs。**
可写层因此不再增长（Docker 自身写入的 `/etc/hosts` 等由 Docker 以 bind 提供）。

| 容器路径 | 来源 | 说明 |
|---|---|---|
| `/workspace` | bind `workspace/`（data project） | 不变 |
| `/agent/pi` | bind `pi/`（pi project） | 不变 |
| `/home/agent` | bind `home/`（data project） | **新增**。home 从此持久化（容器重建后仍在，为 Phase 18 镜像升级铺路）；新建时用镜像 `/etc/skel` 初始化（`.bashrc`、`.profile`） |
| `/tmp` | bind `tmp/`（data project） | **新增**。由 Worker 在每次自己发起的启动（ensure 创建、start）前清空；Docker 在宿主机重启后自动拉起时不清空（15.12 Q3） |
| `/var/tmp` | tmpfs `size=256m,mode=1777,nosuid,nodev` | 计入容器内存 cgroup |
| `/run` | tmpfs `size=16m,mode=755,nosuid,nodev,noexec`（含 `/run/lock`） | 只读根下必须提供 |
| `/dev/shm` | 现有 64M tmpfs | 不变（Chromium 使用） |

- 挂载方式从 `HostConfig.Binds` 改为 `HostConfig.Mounts`（`Type: bind`）：`Binds` 在源目录缺失时由 Docker
  以 root 自动创建，若 XFS 未挂载，容器会带着根分区上的空目录启动、写入不受配额约束；`Mounts` 在源缺失时
  直接报错。这让“配额文件系统未挂载”在 Docker 层也是 fail-closed（宿主机重启、Worker 尚未运行时同样有效）。
- 只读根带来的行为变化（写入 runbook 与 Portal 帮助）：
  - `rustup toolchain/component/target add` 不再可用（上游镜像把 `/usr/local/rustup` 设为全局可写，此前
    写入的是可写层，容器重建即丢失）。需要额外 Rust 组件时，在 Phase 18 的镜像升级中加入镜像。
  - 容器环境增加 `CARGO_HOME=/home/agent/.cargo`，使 crate 下载与 `cargo install` 写入 home（受配额）；
    `rustc`/`cargo` 仍经 `/usr/local/bin` 的符号链接找到。实现时在真实容器中验证 `cargo build`（含依赖）。
  - `pip install --user`、`uv`、`pnpm`/npm 缓存、Playwright/fontconfig 缓存都在 home 下，不受影响；
    `npm -g` 的前缀本来就是 root 所有，行为不变。
- Runtime 镜像**不变**（不改 tag，不改 Dockerfile），全部变化由 Worker 的容器创建参数实现。
- 定位：Workspace 仍是“一台隔离的计算机”，只读根并不收紧现有权限——agent 本就是非 root、无 sudo、
  `cap-drop ALL`，此前在根文件系统中只能写 home、`/tmp` 等少数位置；本 Phase 让这些位置持久化（home）
  并计入配额。系统级软件由 Runtime 镜像提供，按用户需求更新镜像（15.12 Q7）。

被否决的方案（2026-10-06 与负责人讨论后确认）：

- **可写根 + Docker `--storage-opt size`**：需要整台宿主机的 Docker 关闭 containerd image store、改用
  overlay2 并把 data-root 迁到 XFS `pquota`，影响宿主机上全部镜像与其他容器；containerd 快照器的配额支持
  未经验证；且可写层在容器重建（Phase 18 镜像升级）时丢失，根可写本身并不带来持久的“像主机”能力。
- **给 agent root / sudo（userns-remap 或 Sysbox 一类系统容器运行时）**：改变 `normalUser = agent` 的
  Runtime 不变量与安全模型，属于 v1.x 的独立设计，不在 Phase 15。home 持久化不妨碍将来采用。

### 15.5 ulimit 与容器日志

- `HostConfig.Ulimits`：`nofile` soft = hard = `WORKSPACE_NOFILE_LIMIT`（默认 65536）；`core` soft = hard = 0
  （宿主机 `core_pattern=core` 会把 core 写到 `/workspace`，且 Chromium/Node 崩溃产生的 core 动辄 GB 级）。
- **不设置 `nproc`**：`RLIMIT_NPROC` 按宿主机真实 UID 计数，UID 1000 的全部进程（所有 Workspace 加上宿主机
  `radxa`）共享一个计数，设置后会相互影响。进程数继续由已有的 `PidsLimit`（cgroup pids）限制。
- `HostConfig.LogConfig`：`{ Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } }`，单个
  Workspace 的容器日志最多约 30MB。
- 校验：`#verifyResourceConfiguration` 增加 Ulimits、LogConfig、ReadonlyRootfs、Tmpfs、Mounts 的比较。

### 15.6 Worker 行为与 fail-closed

- **存储状态**：Worker 维护 `storage = { enforced, fsType, totalBytes, freeBytes }`。`enforced=true` 的条件：
  `WORKER_MANAGED_ROOT` 是一个挂载点（不是根文件系统的子目录）、`fsType=xfs`、mountinfo 含 `prjquota`、
  `Q_XGETQSTAT` 显示 project quota **accounting 与 enforcement 均为 ON**、Worker 具备设置上限的能力（启动时
  对保留的探针 project 设置并读回一次上限）。读取状态不需要特权。
- **启动门禁**：`workspace.ensure`（将创建或启动容器时）与 `workspace.start` 在启动容器前同步执行：
  `storage.enforced` 为真 → 读回 4 个目录的 project ID 与 `PROJINHERIT`、读回两个 project 的上限，与元数据
  和请求的 `diskLimitBytes` 一致（不一致则重新设置并读回）→ 清空 `tmp/` → 启动。任一步失败返回
  `STORAGE_QUOTA_UNENFORCED`，不启动。出口门禁（Phase 14）照常先于此执行。
- **周期校验**：随心跳检查 `storage.enforced`；从真变为假（例如被卸载、以无 quota 选项重新挂载）时，按 Phase 14
  Q3 的同一处置：停止运行中的受管 Workspace（数据保留），状态 `ERROR`（`STORAGE_QUOTA_UNENFORCED`），记日志。
- **用量采样**：每 60 秒对每个受管 Workspace 的 `workspace/` 与 `pi/` 做 `statfs`，得到 data/pi 两个 project
  的 used/limit bytes 与 inodes，随下一次心跳上报（15.8）。
- **存量 Workspace 的配额初始化**：元数据中没有 `quota` 的 Workspace（本 Phase 之前创建），在下一次
  ensure/start 时由 Worker 分配 project，对现有目录**递归**设置 project ID（存量文件计入新 project）并设置
  上限。现有数据已超出上限时仍允许启动（实现时调整：拒绝启动会让用户无法登录清理），超出部分的写入失败
  （XFS project quota 报 `ENOSPC`，CI 真实内核测试确认），用户删除文件或 admin 调高上限后恢复。
- **存量容器**（`Binds`、无 home/tmp 挂载、可写根的旧容器，15.12 Q6，方案 B）：
  - Worker **不自动迁移**。ensure/start 遇到旧格式容器时不启动，返回 `STORAGE_MIGRATION_REQUIRED`；
    inspect/stop/delete 照常可用。reconciliation 发现**运行中**的旧容器时按 14.11 Q4 处置（停止并置
    `ERROR`，错误码同上）。旧容器因此不会在无配额的状态下继续运行。
  - 迁移由管理员执行一次性脚本 `tools/dev/migrate-legacy-workspace.sh <workspace-id>`（在 Worker 宿主机上，
    以 Worker 运行用户执行）：
    1. 确认容器带正确 managed label、属于本 Worker、已停止；
    2. `docker cp <容器>:/home/agent/. <WORKER_MANAGED_ROOT>/workspaces/<id>/home/`（目标目录不存在时以
       `0700` 创建，已存在且非空则中止，避免覆盖）；
    3. 复制成功后删除旧容器（不删除网络与持久目录）；任一步失败则停止并保留旧容器。
  - 之后用户正常启动：Worker 完成配额初始化（递归设置 project，home 的内容计入配额）并以新配置创建容器。
  - 旧容器可写层中 `/tmp` 与其他位置（如 `/usr/local/rustup` 的新增内容）**不迁移**，runbook 要求迁移前提醒
    用户自行保存。
  - 理由：需要迁移的只有开发设备上的存量 Workspace（试点在 Phase 15 之后开始）；本 Phase 之后 home 已持久化，
    Phase 18 重建容器无需复制可写层，自动迁移代码只会使用一次。
- 没有 `CAP_SYS_ADMIN` 或文件系统不满足条件时，Worker 仍能启动、注册、上报（`enforced=false`），但不会启动
  任何 Workspace；日志给出明确原因。**不提供关闭配额的开关**（15.12 Q2）。

### 15.7 Control Plane：数据模型、API、Portal、Audit

migration `0011_storage_and_login_guard`（与 15.9 共用一个 migration）：

```text
workspaces
  + disk_limit_bytes     bigint not null          -- 创建时取 WORKSPACE_DISK_LIMIT_BYTES；存量行回填 20GiB（列默认值）
  + disk_used_bytes      bigint null              -- data project，Worker 上报
  + disk_used_inodes     bigint null
  + pi_used_bytes        bigint null              -- pi project
  + pi_limit_bytes       bigint null              -- Worker 上报的实际值
  + disk_usage_at        timestamptz null

workers
  + storage_enforced     boolean not null default false
  + storage_fs_type      text null
  + storage_total_bytes  bigint null
  + storage_free_bytes   bigint null
  + storage_checked_at   timestamptz null
```

配置（Control Plane）：`WORKSPACE_DISK_LIMIT_BYTES`（默认 20GiB）、`WORKSPACE_DISK_LIMIT_MAX_BYTES`
（admin 可设的上限，默认 1TiB）。下限固定 1GiB。

API：

- `GET /api/workspaces`、`GET /api/workspaces/:id`、`GET /api/admin/workspaces`：增加
  `disk: { limitBytes, usedBytes, usedInodes, piUsedBytes, piLimitBytes, sampledAt }`（未采样时为 null）。
  只返回调用者有权看到的 Workspace，不暴露宿主路径、project ID 或 Worker 文件系统信息。
- `PATCH /api/admin/workspaces/:id`：`{ diskLimitBytes }`（admin、Origin、CSRF；strict schema）。先写数据库并
  记 Audit；Workspace 的 Worker 在线时立即下发 `workspace.storage.set`（无论运行与否，上限即时生效，无需
  重启）；离线时在下次 ensure/start 前生效。允许设为低于当前用量（写入会立即失败，Portal 确认弹窗提示）。
- `GET /api/admin/workers`：增加 `storage: { enforced, fsType, totalBytes, freeBytes, checkedAt,
  allocatedLimitBytes }`（`allocatedLimitBytes` 为该 Worker 上全部 Workspace 的 `disk_limit_bytes` 之和）。

Audit：`workspace.storage_limit_changed`（admin，details 含旧值、新值、request ID）、
`worker.storage_enforced` / `worker.storage_unenforced`（状态翻转时）。
Worker 上报 `enforced=false` 时，其 `RUNNING` 的 Workspace 在同一事务内置为 `ERROR`。

调度：`storage.enforced=false` 的 Worker 不参与新的 placement；对已有 assignment 的 start 返回
`STORAGE_QUOTA_UNENFORCED`，不改 sticky placement。

Portal：

- Workspace 卡片/列表显示“磁盘 已用 / 上限”进度条（≥ 90% 告警色，≥ 100% 显示“磁盘已满：请删除文件或联系
  管理员”），以及采样时间；Pi 状态用量只在详情中显示。
- Admin Workspaces 页面可调整上限；Admin Workers 页面增加“磁盘配额”状态列与“容量 / 已分配上限”。
- 中文错误说明：`STORAGE_QUOTA_UNENFORCED`（“Worker 磁盘配额未生效，暂时无法启动”）、
  `STORAGE_MIGRATION_REQUIRED`（“该 Workspace 需要管理员完成存储迁移后才能启动”）。

### 15.8 Worker Protocol

`WORKER_PROTOCOL_VERSION` 升到 `3`，与 v2 不兼容（Control Plane 与 Worker 同时升级，同 14.11 Q5）：

- `worker.hello` / `worker.heartbeat` 增加 `storage: { enforced: boolean, fsType: string | null,
  totalBytes: number | null, freeBytes: number | null }`；heartbeat 增加可选 `workspaceDisk:
  [{ workspaceId, dataUsedBytes, dataLimitBytes, dataUsedInodes, piUsedBytes, piLimitBytes }]`（上限
  10 000 项，只包含本 Worker 受管且元数据有效的 Workspace；Control Plane 只接受 assignment 属于该 Worker 的
  条目，其余丢弃并记 `warn`）。
- `workspace.ensure` payload 增加 `storage: { diskLimitBytes }`（整数，1GiB ≤ x ≤ 2^50）。
- 新命令 `workspace.storage.set`：`{ workspaceId, diskLimitBytes }`，Worker 校验元数据与 label 后设置并读回，
  返回 `{ dataLimitBytes, dataUsedBytes }`；Workspace 目录不存在时返回 `WORKSPACE_NOT_FOUND`。
- 新错误码：`STORAGE_QUOTA_UNENFORCED`、`STORAGE_MIGRATION_REQUIRED`、
  `STORAGE_QUOTA_APPLY_FAILED`（retryable）。

### 15.9 登录防护

**客户端 IP 解析**：新增 `AUTH_TRUSTED_PROXIES`（CIDR 列表，默认空）。TCP 对端地址在该列表内时，从
`X-Forwarded-For` **自右向左**取第一个不在列表内的地址作为客户端 IP；否则使用 TCP 对端地址，忽略
`X-Forwarded-For`（防伪造）。**不启用 Fastify `trustProxy`**：它会同时改变 `request.hostname`/`protocol`，
影响 Host 严格校验的路径。新的解析结果同时用于现有 Audit 的 `ipAddress`。开发配置：Vite proxy 开启
`xfwd`，`.env.example` 设置 `AUTH_TRUSTED_PROXIES=127.0.0.1/32,::1/128`。

**计数与锁定**（存于 PostgreSQL，Control Plane 重启不清零）：

| 维度 | 键 | 计数内容 | 默认阈值 → 锁定 |
|---|---|---|---|
| 账户+IP | HMAC(规范化 login) + 客户端 IP | 本地登录失败 | 15 分钟内 5 次 → 锁 15 分钟 |
| IP | 客户端 IP | 本地登录失败（含格式错误）+ SSO callback 失败 | 15 分钟内 20 次 → 锁 15 分钟 |
| 账户 | HMAC(规范化 login) | 本地登录失败（全部来源） | 1 小时内 50 次 → 锁 1 小时，**来自 `AUTH_TRUSTED_NETWORKS` 的请求不受此项限制** |
| SSO 发起 | 客户端 IP | `/auth/{oidc,oauth2}/login` 请求数 | 10 分钟内 30 次 → 锁 10 分钟 |

- login 先做 trim + 小写规范化，再以 `SESSION_SECRET` 派生的独立 key 做 HMAC-SHA256；数据库**不保存明文
  login**（用户可能把密码误填进用户名栏）。不存在的 login 与存在的 login 走完全相同的计数和响应，不泄露
  账户是否存在。
- 判定顺序：解析 IP → 一次查询三个键的锁定状态 → 任一锁定则直接返回 **429 `AUTH_RATE_LIMITED`** 与
  `Retry-After`（**不执行 scrypt**，也不再计数）→ 否则校验密码 → 失败时用一条 upsert 语句原子地给三个计数
  加一，越过阈值的一行同时写入 `locked_until`，并在同一事务内写 Audit `auth.login_locked`。
- 成功登录只清零“账户+IP”计数；不清零 IP 与账户计数（避免攻击者借合法用户的一次成功重置计数）。
- 响应体对三种锁定一致，不说明是哪个维度。Portal 显示“登录尝试过于频繁，请在 N 分钟后重试”。
- **break-glass**：
  1. 攻击者从外部只能触发“账户+IP”与“IP”锁定，它们不影响管理员从其他地址登录；
  2. 分布式攻击触发的“账户”锁定对 `AUTH_TRUSTED_NETWORKS`（默认 `127.0.0.1/32,::1/128`，生产配置为管理网段）
     不生效，管理员从管理网络仍可用正确密码登录；
  3. 新增 CLI `pnpm auth:unlock login <login> | ip <address> | all`，直接作用于数据库（能登录 Control
     Plane 宿主机即为 break-glass），记 Audit `auth.lock_cleared`（actor 为空、`details.source=cli`）。
- **SSO**：IP 被锁定时 `/auth/*/login` 与 `/auth/*/callback` 返回 429，且 callback 不消费
  transaction；callback 失败计入 IP 计数；不对 SSO 做账户维度锁定（账户由 IdP 认证）。SSO 发起限速让单个来源
  无法再耗尽 10 000 条 transaction 容量。
- **数据库故障**：读取或写入计数失败时登录返回 503，不跳过限速（fail-closed；数据库不可用时 session 也无法
  创建，不额外降低可用性）。
- **清理**：过期且未锁定的计数行由现有的周期任务删除。

数据模型（同 `0011` migration）：

```text
auth_throttle
  id            uuid primary key (server generated)
  scope         text not null check (scope in ('login_ip', 'ip', 'login', 'sso_start'))
  key_hash      text not null                     -- 64 位十六进制 HMAC-SHA256：账户、账户|IP、IP 或 SSO 发起地址
  ip_address    inet null                         -- 仅 login_ip / ip / sso_start，供 admin 查看
  user_id       uuid null references users(id) on delete cascade   -- login 对应现有本地用户时填写，供 admin 查看
  window_start  timestamptz not null
  failures      integer not null
  locked_until  timestamptz null
  unique (scope, key_hash)
```

API 与 Portal：

- `GET /api/admin/auth/locks`：当前生效的锁定 `{ id, scope, ipAddress, user: { id, email } | null,
  failures, lockedUntil }`；不返回 key hash。`DELETE /api/admin/auth/locks/:id` 解锁，记
  `auth.lock_cleared`。admin 重置某用户密码时同时清除该用户的账户与账户+IP 锁定。
- Admin Users 页面增加“登录锁定”区域与“解除”按钮；Login 页面处理 429。
- Audit：`auth.login_locked`（details：scope、until、ipAddress、requestId；能对应到现有用户时
  `owner_user_id` 为该用户，仅 admin 可见）、`auth.lock_cleared`（actor、scope、source）。被锁定期间的每次
  拒绝**不**逐条写 Audit（避免攻击者刷写审计表），只写结构化日志（`info`，不含 login），Phase 17 再做计数指标。

配置：`AUTH_TRUSTED_PROXIES`、`AUTH_TRUSTED_NETWORKS`，以及上表阈值的环境变量
（`AUTH_LOCKOUT_*`，均有上下限校验）。

### 15.10 测试计划

单元 / 组件测试（CI 常规任务）：

- 客户端 IP：不可信对端伪造 `X-Forwarded-For` 被忽略；可信代理链取最右不可信地址；IPv4-mapped IPv6 规范化。
- 登录防护：各维度阈值与窗口滚动；锁定时返回 429 且 **`verifyPassword` 未被调用**；不存在的 login 与存在的
  login 的计数、状态码、响应体一致；成功只清零账户+IP；可信网络只豁免账户维度、不豁免另两项；SSO 发起限速与
  callback 失败计数、锁定时 callback 不消费 transaction；admin 解锁授权（401/403/CSRF）与 Audit；
  `auth.login_locked` 每次锁定只写一条；日志/Audit/数据库中不出现测试用 login 明文与密码（扩展 Phase 13 脱敏
  测试）；计数存储故障时返回 503。
- Worker：容器创建参数（`ReadonlyRootfs`、`Mounts` 而非 `Binds`、home/tmp 挂载、Tmpfs、Ulimits、
  LogConfig、`CARGO_HOME`）与校验能识别每一项偏差；`xfs_quota` argv 渲染（固定 argv、拒绝非受管路径与符号
  链接）；project ID 分配不碰撞；`enforced=false` 时 ensure/start 返回 `STORAGE_QUOTA_UNENFORCED` 且未调用
  Docker 启动；旧格式容器被识别并拒绝启动、运行中的旧容器被停止；存量目录的配额初始化（fake Docker）；用量采样与上报。
- 协议：v3 hello/heartbeat/`workspace.storage.set`/ensure 的正反例；v2 hello 被拒绝。
- Control Plane：`PATCH /api/admin/workspaces/:id` 授权、范围校验、Audit、在线时下发；调度排除
  `storage.enforced=false`；用量只接受属于该 Worker 的 Workspace；普通用户只能看到自己 Workspace 的用量。
- migration 与并发计数（50 个并发失败请求 → 计数精确、只产生一次锁定 Audit）在 `agent_runtime_test` 上验证。

真实内核配额测试（`pnpm test:quota`）：需要挂载 XFS，必须 root。CI 在 ARM64 runner 上用 `sudo` 创建
1GiB 稀疏文件 → `mkfs.xfs` → loop 以 `prjquota` 挂载后运行；本地由负责人在开发 XFS 上以
`run-worker-privileged.sh` 同样的能力运行。断言：

- 写入超过 data 上限失败（`ENOSPC`），pi project 仍可写；inode 上限生效；新建子目录与文件继承 project；
  跨 project `rename` 为 `EXDEV`、硬链接被拒绝；`statfs` 返回 project 上限与用量；调整上限即时生效；删除后
  用量归零、上限清零。
- 状态检测：同一文件系统以无 `prjquota` 挂载、ext4、根文件系统子目录三种情况均判定 `enforced=false`。

真实 Docker 集成测试（`pnpm test:e2e:runtime`，`WORKER_MANAGED_ROOT` 指向 XFS 测试挂载）：容器内向
`/workspace`、`/home/agent`、`/tmp` 写超限失败；向 `/`、`/usr/local/rustup`、`/opt` 写入返回 `EROFS`；
`ulimit -n` 为 65536、`ulimit -c` 为 0；`df /workspace` 显示配额；`cargo build`（含依赖）、`pnpm install`、
`uv pip install`、Chromium 截图正常；迁移脚本（停止检查、目标非空中止、label 校验）执行后 home 内容完整且计入配额；XFS 未挂载时容器无法启动（`Mounts` 源
缺失）。

**变异检查**（实现时执行并在交付说明中记录）：去掉 `ReadonlyRootfs`（写根文件系统的 e2e 断言失败）；`Mounts`
改回 `Binds`（源缺失测试失败）；去掉启动前配额读回（单元测试失败）；去掉调度器的 storage 条件；锁定判断
移到 scrypt 之后（`verifyPassword` 未调用断言失败）；可信网络豁免扩大到全部维度；信任任意来源的
`X-Forwarded-For`；成功登录清零全部计数——对应测试均应失败。

### 15.11 验收

自动验收：上述测试全部通过，CI 绿（含 `test:quota`）。

人工验收（详细步骤随交付说明给出），要点与预期结果：

0. **开发设备准备**（负责人 sudo）：安装 xfsprogs；停止全部 Workspace 与 Worker；创建稀疏镜像并 `mkfs.xfs`；
   以 `loop,prjquota` 写入 fstab 并挂载到 `/var/lib/agent-runtime`（先把现有数据移出再拷回，保留属主与权限）；
   确认 `agent-runtime-egress.service` 读取的快照路径在挂载后可用、`docker.service` 在挂载之后启动。
   预期：`findmnt` 显示 xfs + prjquota；`xfs_quota -x -c 'state -p'` 显示 enforcement ON。
1. 以带 `CAP_NET_ADMIN`+`CAP_SYS_ADMIN` 的方式启动 Worker：Admin Workers 页面“磁盘配额”为已生效，显示容量。
   去掉 `CAP_SYS_ADMIN` 重启：显示未生效，Workspace 无法启动且 Portal 显示原因。
2. 存量 Workspace（升级前在其 `/home/agent` 放一个标记文件）：直接启动被拒绝，Portal 显示需要迁移；停止状态下
   执行 `migrate-legacy-workspace.sh <id>` 后启动成功，home 标记文件、`/workspace` 文件与 Pi Session 完整，
   `df -h /home/agent` 显示配额且已用量包含迁移的 home；`/tmp` 旧内容不存在。
3. 将某 Workspace 上限调为 2GiB：在 Terminal 中 `df -h /workspace` 显示 2G；`fallocate`/`dd` 写超过上限得到
   “No space left on device”（XFS project quota 的 `ENOSPC`）；同一 Worker 上另一 Workspace 写入正常；写满状态下 pi-web 仍能对话、Session 继续保存，
   在 Terminal 删除文件后恢复；Portal 进度条与 `df` 一致（采样延迟 ≤ 70 秒）。
4. `touch /usr/local/x`、`rustup target add …` 失败为只读；`ulimit -n` = 65536；`cargo build`（含依赖）、
   `pnpm install`、`uv pip install`、Playwright 截图正常；`docker inspect` 显示日志 `max-size`。
5. admin 调高上限：无需重启立即可写；Audit 有 `workspace.storage_limit_changed`。
6. 本地登录：对一个账户从同一浏览器连续输错 5 次 → 第 6 次（即使密码正确）返回 429 与剩余时间；从另一台
   设备（不同 IP）用正确密码可以登录；对不存在的账户同样输错 5 次，表现完全一致；Audit 有 `auth.login_locked`，
   其中无 login 明文。
7. break-glass：用脚本从非可信地址对 Local Admin 触发账户维度锁定后，从可信网络（Control Plane 宿主机本地）
   用正确密码登录成功；`pnpm auth:unlock login <admin>` 与 Admin 页面“解除”均可解锁并记 Audit。
8. SSO：短时间内反复打开 `/auth/oidc/login` 超过阈值后返回 429；正常用户从其他 IP 的 OIDC 登录不受影响。
9. 伪造 `X-Forwarded-For` 直接访问 Control Plane 端口：限速仍按真实对端地址计数。
10. 重启 Worker 宿主机：XFS 先于 Docker 挂载，`unless-stopped` 拉起的容器配额生效；卸载 XFS 的情况下容器
    无法启动（而不是在根分区上带空目录启动）。

失败时收集：Worker/Control Plane 日志（按 request ID）、`findmnt -T /var/lib/agent-runtime`、
`sudo xfs_quota -x -c 'state -p' -c 'report -p -b -i' /var/lib/agent-runtime`、`docker inspect <容器>` 的
`HostConfig`、Audit 页面截图。

### 15.12 决策

2026-10-06：Q1、Q7 经讨论确认；Q2–Q5、Q8–Q10 负责人确认按建议执行；Q6 选方案 B。

- **Q1 配额机制与文件系统**（**已确认，2026-10-06**）：`WORKER_MANAGED_ROOT` 为独立 XFS + `prjquota`
  （生产：独立磁盘/分区/LV；Q8B：根分区上的稀疏 loop 镜像），v1.0 只支持 XFS，ext4 project quota 暂不支持。
- **Q2 特权**（**已确认：按建议**）：Worker 增加 ambient `CAP_SYS_ADMIN`（经固定 argv 调用 `xfs_quota`），且不提供关闭配额的开关？
  建议采用，理由同 14.11 Q1。备选是一个 root 所有、只接受“project ID + 字节数 + 受管路径”的最小 helper
  （经 sudoers 或 systemd socket 调用），权限面更窄但多一个需要安装与维护的组件。
- **Q3 `/tmp`**（**已确认：按建议**）：用 data project 内的磁盘目录、在 Worker 发起的每次启动前清空（建议）；备选 tmpfs（更快、
  天然易失，但计入 4GiB 内存上限，大 git clone/构建会挤占内存或触发 OOM）。
- **Q4 两个 project**（**已确认：按建议**）：Pi 状态单独 2GiB project，保证 `/workspace` 写满时 Pi Session 仍可写？建议采用。
- **Q5 默认值**（**已确认：按建议**）：data 20GiB / 2 000 000 inode；pi 2GiB / 200 000 inode；`nofile` 65536；`core` 0；日志
  10MB×3；`/var/tmp` 256MB、`/run` 16MB；admin 可按 Workspace 调整 data 上限（1GiB～1TiB），用户不能自助。
  请确认或给出数值。
- **Q6 存量迁移**（**已确认：方案 B，2026-10-06**）：Worker 只识别旧格式容器并拒绝启动
  （`STORAGE_MIGRATION_REQUIRED`），由管理员用一次性脚本 `migrate-legacy-workspace.sh` 复制 home 并删除旧容器；
  不实现 Worker 内的自动迁移（15.6）。
- **Q7 只读根的副作用**（**已确认，2026-10-06**）：采用只读根（15.4）。`rustup` 组件/target、系统包等
  Runtime 中缺少的工具，由负责人收集用户需求后通过更新 Runtime 镜像提供（Phase 18 的镜像升级机制），
  不在 Workspace 内开放安装；设置 `CARGO_HOME=/home/agent/.cargo`。
- **Q8 登录阈值与可信网络**（**已确认：按建议**）：15.9 表中的阈值；`AUTH_TRUSTED_NETWORKS` 默认仅 loopback；不设永久锁定（全部为
  定时自动解除）？建议采用。
- **Q9 协议 v3**（**已确认：按建议**）：与 v2 不兼容，同时升级？建议是。
- **Q10 inotify**（**已确认：按建议**）：本 Phase 不做隔离，runbook 建议宿主机设置 `fs.inotify.max_user_instances=8192`、
  `max_user_watches=1048576`（所有 Workspace 共享 UID 1000 的计数）？建议采用，隔离留到 v1.x userns-remap。

### 15.13 负责人执行的检查（2026-10-06）

- `sudo dumpe2fs -h /dev/nvme0n1p3`：features 为 `has_journal ext_attr resize_inode dir_index orphan_file
  filetype needs_recovery extent 64bit flex_bg metadata_csum_seed sparse_super large_file huge_file dir_nlink
  extra_isize metadata_csum orphan_present`，无 `project`/`quota`；inode size 256。
- `docker create --name ar-storageopt-probe --storage-opt size=1G agent-runtime:phase7-toolchain true`：创建成功
  （未报错），随后已删除。结论见 15.1。

## Phase 16：模型网关与凭据托管

状态：**已实现，待人工验收（2026-10-08）**，分支 `phase-16-model-gateway`；运维见 `docs/model-gateway-runbook.md`。本 Phase 只接入 DeepSeek，Xiaomi MiMo 延后到 Phase 18（负责人 2026-10-08 决定，16.17）。实现中的调整见 16.16。Q1–Q9 全部确认（Q4 改为“session 撤销不改变 key”，16.14）。方向见第 43.1 节与 `docs/v1-roadmap.md` Phase 16、决策 D4、D7。

目标：用户在 Workspace 中无需自己填写 API Key 即可使用平台提供的模型；真实上游 key 只存在于模型网关；每次调用
按平台用户计量，可设预算；用户禁用、Workspace 删除时对应凭据失效，session 撤销后被撤销者无法再使用该凭据（16.6）；Workspace 无法访问网关的
管理接口。网关采用现成组件，平台只做集成（D4）。

### 16.1 开工环境核查（Q8B，2026-10-06，只读）

**Pi 0.85.1 / pi-web 0.9.0 的模型配置**（从 Runtime 镜像 `agent-runtime:phase7-toolchain` 中的已安装包读取
`docs/models.md`、`docs/providers.md`、`docs/environment-variables.md` 与 `dist/`；pi-web 读取 tag `v0.9.0`
（`0d1df12`）源码）：

| 项 | 结论 | 对设计的影响 |
|---|---|---|
| 配置目录 | `getAgentDir()` = `PI_CODING_AGENT_DIR`（容器内 `/agent/pi`）；`models.json`、`auth.json` 固定为其下文件，没有第二个搜索路径或“系统级”配置文件 | 平台的 provider 只能写进用户自己的 `/agent/pi/models.json`（或经 extension 注册，见 16.5 被否决方案） |
| 自定义 provider | `models.json` 的 `providers.<id>`：`baseUrl`、`api`（`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`）、`apiKey`、`headers`、`authHeader`、`models[]`（`id`、`name`、`reasoning`、`thinkingLevelMap`、`input`、`contextWindow`、`maxTokens`、`cost`、`compat`）；非内置 provider 必须有 `baseUrl` 与 `api` | 平台 provider 需要完整的模型定义（含 `compat`），由平台目录提供（16.5） |
| `apiKey` 取值 | 字面量、`$ENV` / `${ENV}` 插值、`!command`（`models.json` 中**每次请求时**执行）。没有 auth 的模型不会出现在 `/model` 中 | 平台 provider 用固定占位字面量即可（真正的 key 由中继注入，16.4） |
| 内置 provider 改道 | `providers.<内置id>.baseUrl` 可把内置 provider 改到代理，模型与 compat 保留；但认证仍按该 provider 的 `auth.json` / 环境变量解析 | 不采用：会把用户自己保存的上游 key 发给平台网关，且与用户自有配置混在一起 |
| `auth.json` | `{ "<provider>": { "type": "api_key", "key": ... } }`，`0600`；**优先于环境变量**；`!command` 结果在进程生命周期内缓存 | 平台不写 `auth.json` |
| 热加载 | `models.json` 在每次打开 `/model` 时重新读取，无需重启 | 平台在启动前写入即可 |
| pi-web Models 面板 | `GET/PUT /api/models-config` 读写**整个** `models.json`（`writePrivateFileAtomicSync`，`0600`）；`auth.json` 经 `/api/auth/api-key/:provider` 写入 | 用户可以在面板中看到、修改或删除平台 provider 条目；平台每次启动前重新写入该条目（16.5） |

**现有 Workspace 的 `/agent/pi`**（Q8B 上两个 Workspace，只看结构，未输出任何 key）：

- 文件：`auth.json`（`0600`）、`models.json`（`0600`，`providers` 为空）、`models-store.json`（空对象）、
  `settings.json`（`defaultProvider`、`defaultModel`）、`pi-web-session-index.json`、`sessions/`，其中一个另有 `skills/`。
- `auth.json` 中为内置 provider `deepseek`（两个 Workspace）与 `xiaomi`（一个 Workspace）的**字面量 key**；
  `settings.json` 均为 `deepseek / deepseek-v4-flash`。即：当前实际使用的模型服务商是 **DeepSeek** 与
  **Xiaomi MiMo**，key 由用户各自保存在 Workspace 中（G6 属实）。
- Pi 内置目录中二者均为 `openai-completions`：DeepSeek `https://api.deepseek.com`（`deepseek-v4-flash`、
  `deepseek-v4-pro` 等），MiMo `https://api.xiaomimimo.com/v1`（`mimo-v2.5`、`mimo-v2.5-pro` 等）；compat 为
  `thinkingFormat: "deepseek"`、`requiresReasoningContentOnAssistantMessages: true`（DeepSeek 另有
  `maxTokensField: "max_tokens"`、`supportsDeveloperRole: false`）。**网关必须原样透传 `thinking` /
  `reasoning_effort` 请求参数，以及历史 assistant 消息中的 `reasoning_content`**，否则多轮工具调用会被上游以
  400 拒绝。这是选型的硬性验证项（16.3、16.15）。

**候选网关**（2026-10-06 查询 registry manifest 与上游文档/源码）：

| 项 | LiteLLM Proxy | New API（QuantumNous） | One API | Bifrost（Maxim） |
|---|---|---|---|---|
| ARM64 镜像 | `ghcr.io/berriai/litellm-database` 有 `linux/arm64` | `calciumion/new-api` 有 `linux/arm64` | 有 | `maximhq/bifrost` 有 `linux/arm64` |
| 许可证 | 仓库根 MIT；`enterprise/` 目录为商业许可（SSO、部分审计/路由限制等） | **AGPL-3.0** | MIT | 核心 Apache-2.0；SSO、RBAC、审计日志等为企业版；governance 是否全部开源未在文档中明确 |
| 虚拟 key | `/key/generate`（`user_id`、`key_alias`、`models`、`max_budget`、`rpm_limit`/`tpm_limit`、`metadata`、`key_type: "llm_api"` 只允许 LLM API 路由）、`/key/delete`、`/key/block`、`/key/{key}/regenerate`；库中只存 key 的 hash | token 归属于**当前登录用户**（`controller.AddToken` 取 `c.GetInt("id")`），管理员不能代其他用户签发；token 明文可经 `/api/token/:id/key` 取回 | 同 New API 前身 | `/api/governance/virtual-keys` CRUD，按 VK 的预算与限速，customer/team 层级 |
| 按用户计量 | key 归属 `user_id`，按 key / user 汇总 spend 与 token，用户级 `max_budget` + `budget_duration` | 按 New API 用户与 token 计 quota | 同左 | 按 VK / team / customer |
| 管理 API 认证 | master key（`sk-` 开头）或 admin 角色 key | 每个 New API 用户自己的 access token | 同左 | 文档未说明开源版的管理 API 认证 |
| 存储 | PostgreSQL（Prisma，启动时自行迁移），可用现有 PostgreSQL 实例中的**独立数据库** | SQLite / MySQL / PostgreSQL | SQLite / MySQL / PostgreSQL | SQLite / PostgreSQL |
| 推理与管理端口 | **同一端口**（默认 4000），另带 Admin UI | 同一端口 | 同一端口 | 同一端口 |
| DeepSeek / MiMo | 有 `deepseek/` provider；MiMo 走 `openai/` + `api_base`；`reasoning_content` 多轮回传需实测 | 支持 | 支持 | 支持（OpenAI 兼容转换） |
| 其他 | 2026-03-24 PyPI 发布的 1.82.7 / 1.82.8 曾被植入恶意代码（供应链事件，40 分钟后下架）；必须 pin 经核对的版本与镜像 digest | — | 维护明显放缓 | 项目较新 |

与 Phase 14 的关系（代码核对）：Workspace 出站在 `ws_prerouting` 中以 `fib daddr type local` 丢弃一切发往
Worker 宿主机地址的包，在 `ws_forward` 中丢弃 protected、RFC1918 与追加网段；14.11 Q8 已确认白名单不能放行
宿主机地址，网关若在 Worker 宿主机上需要“单独、受限的例外”。Control Plane 启动 Workspace 时总是先
`workspace.ensure` 再 `workspace.start`（`routes/workspaces.ts`）。

### 16.2 范围与非目标

范围：

- 部署 LiteLLM Proxy 作为模型网关（开发 compose、配置模板、pin 版本），真实上游 key 只在网关（16.3）。
- **Worker 模型中继（model relay）**：Workspace 只能经本机 Worker 的中继访问网关推理路由，中继按来源识别
  Workspace 并注入该 Workspace 的虚拟 key；Workspace 网络层面完全不可达网关（16.4）。
- Phase 14 出口规则增加中继端口的受限例外；网关地址自动加入 protected（16.4）。
- Pi 注入：Worker 在启动前把平台 provider 写入 `/agent/pi/models.json`，模型目录由平台配置（16.5）。
- 虚拟 key 的签发、投递、轮换、吊销，以及用户禁用、Workspace 删除时的失效；session 撤销的语义见 16.6。
- 计量与限额：按平台用户的预算与按 key 限速；Portal 显示用量（16.7）。
- Control Plane 数据模型、Admin API、Portal、Audit；Worker protocol v4（16.8、16.9）。

非目标（v1.0 不做）：

- 计费、充值、账单（路线图第 5 节；网关只做计量）。
- 平台内的模型目录编辑 UI、按用户/部门的模型授权（目录为全局配置文件，全部 active 用户可用同一组模型）。
- 读取、迁移或删除用户自己在 `auth.json` / `models.json` 中配置的其他 provider 与 key；禁止用户直连公网模型
  服务（出口策略仍是“允许公网”，见 43.1 最后一段）。
- 提示词/响应内容的记录、审查或 DLP；网关的语义缓存、fallback 路由等高级能力（可由管理员在网关配置中自行开启，
  不在平台验收范围内）。
- Embeddings、图片、语音等非对话接口；Pi 当前用不到。
- 网关高可用与多实例；Prometheus 指标（Phase 17）。
- 升级 Pi / pi-web 或修改 Runtime 镜像（D7；本 Phase 不改镜像）。

### 16.3 选型：LiteLLM Proxy

**选定 LiteLLM Proxy**（`litellm-database` 镜像，pin 到开工 spike 验证过的 `-stable` 版本与 digest；不得是
1.82.7 / 1.82.8）。理由：

- 唯一一个**管理员可以用一个管理凭据为任意平台用户签发、删除虚拟 key** 且 key 只存 hash 的候选；`user_id`
  可直接使用平台 User UUID，计量天然按平台用户汇总；`key_type: "llm_api"` 让虚拟 key 无法调用管理路由。
- MIT 核心满足本 Phase 全部需求，不依赖 `enterprise/` 功能。
- 使用现有 PostgreSQL 实例中的独立数据库 `litellm`（独立 role），与平台库 `agent_runtime` 互不访问；LiteLLM 的
  Prisma 迁移只作用于自己的库。
- ARM64 镜像可用；DeepSeek 与 OpenAI 兼容上游（MiMo）均有现成配置方式。

网关配置要求（写入 `deploy/model-gateway/` 模板并在 16.15 spike 中逐项验证）：

- 上游 key 只经网关容器的环境变量（`DEEPSEEK_API_KEY`、`XIAOMI_API_KEY`，`env_file` 为 `0600`）提供；
  `store_model_in_db: false`，模型只来自 `config.yaml`。
- `master_key` 只提供给 Control Plane；关闭 Admin UI 与匿名遥测；只监听平台受保护网络（开发为 `127.0.0.1:4000`）。
- **不记录 prompt / response 内容**（spend log 只保留用量）；客户端在请求体中传入的 `api_key`、`api_base` /
  `base_url`、`user`、`metadata` 等不得改变上游凭据、上游地址或计量归属（spike 中逐项验证，必要时用网关配置关闭）。
- `thinking`、`reasoning_effort` 与 assistant 消息中的 `reasoning_content` 原样透传；DeepSeek 与 MiMo 的多轮
  工具调用（含思考）可用。**若 spike 证明 LiteLLM 的 pinned 版本做不到且无配置可解决，停止编码并回到选型**
  （备选按顺序为 Bifrost、New API，见 16.14 Q1）。

被否决的方案：

- **New API / One API**：token 只能由其所属用户创建，平台要为每个平台用户维护一个网关账号及其 access token，
  等于在网关里复制一套用户体系；token 明文可取回；New API 为 AGPL-3.0（内部部署不修改源码时义务有限，但会
  增加企业法务评估成本）。
- **Bifrost**：功能匹配度高（VK、预算、PostgreSQL），但项目较新，开源版管理 API 的认证方式与 governance 的
  开源/企业边界在文档中不明确；作为 LiteLLM 未通过 spike 时的第一备选。
- **平台自研计量代理**：违反 D4。
- **每个用户一个真实上游 key**：上游服务商不一定支持子 key，且吊销、计量分散在各服务商控制台。

### 16.4 部署位置与网络：Worker 模型中继

LiteLLM 的推理路由、管理路由与 UI 在同一端口上，不能用 Phase 14 的“IP + 端口”规则只放行推理。**选定：
Workspace 根本不直接连接网关，而是连接本机 Worker 的模型中继**：

```text
Pi（Workspace 容器）
  -> http://<该 Workspace bridge 网关地址>:WORKER_MODEL_RELAY_PORT/v1/chat/completions
     （models.json 中平台 provider 的 baseUrl；apiKey 为占位字面量）
  -> Worker 模型中继（Worker 进程内，宿主机上监听）
       1. 按 TCP 连接的 (本地地址, 对端地址) 识别 Workspace，未知来源直接断开
       2. 只放行目录中 API 类型对应的推理路径
       3. 删除客户端的认证类请求头，注入该 Workspace 的虚拟 key
  -> LiteLLM（WORKER_MODEL_GATEWAY_URL；Worker 宿主机可达、Workspace 不可达的受保护地址）
  -> DeepSeek / MiMo 等上游（真实 key 只在 LiteLLM）
```

性质：

- 虚拟 key **不进入容器**（Agent 读不到），比 43.1 的“注入 Runtime、只具备推理权限”更强；平台的
  provider 条目中只有占位字面量，用户在 pi-web Models 面板或 Terminal 中都看不到可用的凭据。
- 网关（推理与管理）对 Workspace 在网络层面**完全不可达**：网关地址加入 protected（下文），满足“管理接口
  不可达”，与网关部署在哪台主机无关；单机开发与多机生产行为一致。
- 中继是一个只做路径白名单与请求头替换的流式反向代理，与现有 Worker Gateway 同类，不解析或改写请求体，
  不实现计量、路由或模型协议（不违背 D4）。

**来源识别**：Worker 已管理每个 Workspace 的专属 bridge（`arw-…`）与容器。中继维护映射
`(bridge 网关 IPv4, 容器 IPv4) -> workspaceId`，由 Worker 自己对受管网络/容器的 inspect 得到（ensure、start、
reconcile 时刷新，未命中时最多每秒刷新一次）。一个连接只有在本地地址与对端地址同时匹配某个运行中的受管
Workspace 时才被接受；否则立即关闭，不返回任何内容。可靠性依据：

- 容器 `cap-drop ALL`，无 `CAP_NET_RAW` / `CAP_NET_ADMIN`，不能伪造源地址或改自身地址；每个 bridge 只有一个
  容器；Docker 在 `raw PREROUTING` 按入口 bridge 校验容器地址（14.1）。
- 其他主机伪造 `172.x` 源地址无法完成 TCP 握手（回包发往 bridge）；另由下面的 nft 规则在入口直接丢弃。

**中继请求处理**：

- 路径与方法：目录中出现的 API 类型决定白名单——`openai-completions` → `POST /v1/chat/completions`；
  `openai-responses` → `POST /v1/responses`；`anthropic-messages` → `POST /v1/messages`、
  `POST /v1/messages/count_tokens`。精确匹配（不接受 query string、`..`、编码斜杠），其余返回 404。
- 请求头**白名单**转发：`content-type`、`accept`、`user-agent`、`openai-beta`、`anthropic-version`、
  `anthropic-beta`、`x-stainless-*`、`session_id`、`x-client-request-id`、`x-session-affinity`；其余（含
  `authorization`、`x-api-key`、`api-key`、`cookie`、`x-litellm-*`、hop-by-hop 头）一律丢弃，再加
  `Authorization: Bearer <虚拟 key>`。
- 该 Workspace 没有可用 key 时返回 `403`，body 为 OpenAI 风格错误
  `{"error":{"type":"model_access_unavailable","code":"MODEL_KEY_UNAVAILABLE","message":"…"}}`，使 Pi 直接显示原因；
  网关不可达返回 `502` `MODEL_GATEWAY_UNAVAILABLE`。
- 限制：请求体 ≤ `WORKER_MODEL_RELAY_MAX_BODY_BYTES`（默认 32 MiB，图片输入）；每个 Workspace 并发请求 ≤ 16；
  上游连接超时 10 s；**单个请求**的读写空闲超时 600 s——同一个模型请求在客户端与上游之间连续 600 s 没有任何字节
  流动时中止该请求（思考类模型首包可能很慢；流式输出每到一个 token 都会重新计时）。它与用户是否在操作、浏览器
  是否打开无关，也不影响 Workspace 或 Session；无总时长上限。响应（含 SSE）流式回传，不缓冲。
- 浏览器断开、pi-web 停止 Session 不影响中继；Pi 中止请求时中继随之中止上游请求。

**出口规则变化**（在 Phase 14 的 `inet agent_runtime` 表中，由 Worker 渲染并纳入 `enforced` 校验）：

```text
chain ws_prerouting {
  iifname != "arw-*" return
  ct direction reply accept
  meta nfproto ipv6 drop
  fib daddr type local tcp dport <relayPort> accept     # 新增：只放行中继端口，其余宿主机地址照旧丢弃
  fib daddr type { local, broadcast, multicast } drop
}
chain relay_input {                                       # 新增：hook input，priority -10
  tcp dport <relayPort> iifname != "arw-*" drop          # 中继端口只接受来自 Workspace bridge 的连接
}
```

- 只有配置了 `WORKER_MODEL_GATEWAY_URL` 的 Worker 才渲染这两条；端口由 Worker 配置决定（默认 `3101`）。
  随仓库发布的基础规则文件 `deploy/egress/agent-runtime-egress.nft` **不含**例外（Worker 应用前中继不可达，
  属于 fail-closed）。
- 14.11 Q8 所说的“单独、受限的例外”即此：只放行一个端口，且该端口上的服务自身按来源鉴别。
- **网关地址加入 protected**：Control Plane 把 `MODEL_GATEWAY_ADMIN_URL` 主机解析出的地址加入下发的
  protected；Worker 把 `WORKER_MODEL_GATEWAY_URL` 主机解析出的地址加入本地 protected（与 14.3 处理
  `DATABASE_URL` / `CONTROL_PLANE_URL` 的方式相同）。网关位于公网地址时同样不可达。

被否决的方案：

- **Workspace 直连网关推理端口**（在网关前放一个只暴露推理路径的 nginx/Caddy，出口规则为该 `IP:端口` 开例外，
  虚拟 key 以环境变量或文件注入容器）：多一个需要部署与 pin 的组件；网关所在主机若是 Control Plane 或 Worker
  宿主机，例外要穿透 protected 与 `fib daddr type local` 两层规则；虚拟 key 对 Agent 可见；key 轮换需要改写容器
  内文件或重建容器。
- **中继放在 Control Plane**：模型流量经过 Control Plane（单实例），且仍需要 Workspace 能访问 Control Plane 的某个
  端口，与 protected 冲突。
- **把虚拟 key 写进 `auth.json` 或容器环境变量**：Agent 可读；环境变量需要重建容器才能轮换，`auth.json` 的
  `!command` 结果按进程缓存。

### 16.5 Pi 注入：平台 provider 与模型目录

**模型目录**由 Control Plane 配置文件 `MODEL_GATEWAY_CATALOG_FILE`（JSON，启动时 Zod strict 校验，失败则拒绝
启动）提供：

```json
{
  "providerId": "platform",
  "defaultModel": "deepseek-v4-flash",
  "models": [
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "api": "openai-completions",
      "reasoning": true,
      "input": ["text"],
      "contextWindow": 1000000,
      "maxTokens": 384000,
      "cost": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 },
      "compat": {
        "supportsStore": false, "supportsDeveloperRole": false, "maxTokensField": "max_tokens",
        "requiresReasoningContentOnAssistantMessages": true, "thinkingFormat": "deepseek"
      },
      "thinkingLevelMap": { "minimal": null, "low": "low", "medium": null, "high": "high", "max": "max" }
    }
  ]
}
```

- 字段为 Pi 0.85.1 `models.json` 模型定义的子集：`id`（= LiteLLM `model_name`）、`name`、`api`（三种之一）、
  `reasoning`、`thinkingLevelMap`、`input`、`contextWindow`、`maxTokens`、`cost`、`compat`（JSON 对象，序列化后
  ≤ 8 KiB）；模型 ≤ 100 个。示例模板 `deploy/model-gateway/catalog.example.json` 按 Pi 内置目录给出 DeepSeek 的
  定义（MiMo 见 16.17）。
- Control Plane 启动时与之后每 10 分钟用 master key 读取网关的模型列表，目录中有而网关没有的模型记 `warn` 并在
  Admin 页面显示。
- 目录中的全部模型都写进平台 provider 的 `models[]`（每个模型带自己的 `api` 与 `compat`），在 pi-web 模型选择器
  与 Pi `/model` 中以 `platform/<id>` 出现，用户可按 Session 自由切换；虚拟 key 的 `models` 与目录一致，因此网关
  中有而目录中没有的模型不可用。
- 由于目录由平台维护，D7 所说“需要新模型时由用户自行追加 `models.json`”可以改为管理员在网关配置与目录中追加，
  不依赖 Pi 升级。

**Worker 写入 `models.json`**（`workspace.ensure` 中、容器**未运行**时执行；运行中的容器不改写，避免与 pi-web
并发写）：

- 渲染：`providers[<providerId>] = { baseUrl: "http://<bridge 网关地址>:<relayPort>/v1", api: <首个模型的 api>,
  apiKey: "agent-runtime-relay", models: [...] }`。`apiKey` 是占位字面量（中继会丢弃它），只为让 Pi 认为该
  provider 已配置 auth。
- 只替换这一个 provider 条目，其他顶层字段与其他 provider 原样保留（JSON 重新序列化，2 空格缩进，与 pi-web 一致）。
  用户在面板中对该条目的修改会在下次启动时被覆盖；删除也会被恢复（Portal 帮助中说明）。
- 网关未启用（`ensure` 中 `modelGateway` 为 null）或该 Worker 未启用中继时，删除该条目。
- **文件安全**（`/agent/pi` 对 Agent 可写）：Worker 以受管路径打开 `pi/` 目录；读取 `models.json` 使用
  `O_NOFOLLOW` 且要求为普通文件；写入时在同目录以 `O_CREAT|O_EXCL|O_NOFOLLOW`、`0600` 创建随机名临时文件，
  `fsync` 后 `rename` 覆盖（`rename` 替换目录项本身，不跟随符号链接）。`models.json` 是符号链接、不是普通文件或
  JSON 无法解析时**不修改**，`ensure` 结果报告 `modelConfig: "user_config_invalid"`，Workspace 照常启动（平台
  模型不可用，Portal 提示用户修复或删除该文件）。写入失败（例如 Pi 状态配额已满）报告 `"write_failed"`，同样
  照常启动。
- **默认模型**：只在 `settings.json` 不存在时（新 Workspace）写入 `{ "defaultProvider": <providerId>,
  "defaultModel": <defaultModel> }`；已有 `settings.json` 不修改（16.14 Q6）。
- Runtime 镜像、容器创建参数、Env 均不变，因此不需要容器迁移。

被否决的方案：

- **Pi extension（`pi.registerProvider`）**：extension 只从 `/agent/pi/extensions/` 或项目 `.pi/extensions/`
  自动发现，同样要写入用户可写目录，并且是在 Agent 进程内执行的代码，比一个 JSON 条目的维护面更大；pi-web 0.9.0
  通过 SDK 创建 Session，没有可供平台附加 extension 路径的配置项。
- **改道内置 `deepseek` / `xiaomi` provider 的 `baseUrl`**：认证仍取用户 `auth.json` 中的 key，用户自有 key 会被
  发往平台网关；与“用户自有配置不受平台托管”冲突。

### 16.6 虚拟 key 生命周期

**粒度**：每个 Workspace 一个 active 虚拟 key（LiteLLM `user_id` = 平台 User UUID，`key_alias` =
`arw-<workspaceId>-<序号>`，`key_type: "llm_api"`，`models` = 目录中的模型，`metadata` 为
`{ platform_workspace_id }`——字段名不能是 `workspace_id`，见 16.15）。
计量与预算按平台用户（LiteLLM user）汇总；按 Workspace 粒度吊销与限速。

**存放**：明文只在签发响应中出现一次，经 Worker 控制通道（生产为 TLS）送到 Worker，Worker 写入该 Workspace 的
`metadata/model-key.json`（`0600`，容器不可见，不在任何 bind mount 中），并装入中继内存。**Control Plane 数据库
只保存 alias 与状态，不保存明文**；Worker 丢失 key 时由 Control Plane 轮换，而不是重发。

**签发流程**（`ensureWorkspaceModelKey`）：在同一事务中确认 User `active`、Workspace 未在删除、Worker 已启用
中继，插入 `status='issuing'` 的行 → 调网关 `/key/generate`（首次时先确保 LiteLLM user 存在并带上预算）→ 行改为
`active` → 发送 `workspace.model_key.set`。任一步失败：行改为 `revoking`（保证可能已在网关生成的同 alias key 被
删除），Workspace 启动**不受影响**（16.14 Q3），中继对该 Workspace 返回 `MODEL_KEY_UNAVAILABLE`，由后台循环
稍后重试签发。Control Plane 重启时，超过 1 分钟仍为 `issuing` 的行按 `revoking` 处理。

**触发时机**：

| 事件 | 行为 |
|---|---|
| Workspace start（ensure 之后、start 之前） | 没有 active key，或 Worker 报告的 alias 与 active 行不一致时签发 |
| 后台循环（每 30 s） | 对 `RUNNING`、User active、Worker 在线且中继启用、但缺 key 的 Workspace 签发；推进全部 `revoking` 行 |
| Worker 重连 / `worker.reconcile` | inventory 报告每个 Workspace 持有的 alias：不属于 active 行的 → 发 `workspace.model_key.clear`；active 行存在而 Worker 没有（丢失）→ 轮换（旧行 `revoking`，原因 `lost`） |
| Workspace stop | 保留 key（Workspace 仍存在；停止时中继本来就不接受该来源） |
| **Workspace delete** | 在删除事务中把 active 行置 `revoking`（原因 `workspace_deleted`），随后网关删除；Worker 删除目录时一并删除 `model-key.json` 与中继映射 |
| **User disable** | 在禁用事务中把该用户全部 active 行置 `revoking`（原因 `user_disabled`），提交后立即向在线 Worker 发 `workspace.model_key.clear` 并调用网关删除；禁用期间不签发。重新启用后按“后台循环 / start”签发新 key |
| Admin 撤销用户 session / 用户 logout / session 过期 | **key 不变化**（16.14 Q4）：key 从未离开 Worker，被撤销的 session 无法带走它；撤销后该 session 已不能经 Gateway 进入 Workspace（Phase 9–12 的 fail-closed），也就无法再使用中继。浏览器断开不影响 Agent（`AGENTS.md` 第 6 节） |
| 管理员手动轮换 | Admin API 对某 Workspace 或某用户执行轮换（原因 `admin`） |

**吊销的 fail-closed 规则**：

- 吊销以**网关删除成功**为准：只有网关确认删除（或返回 alias 不存在的 404）后行才变为 `revoked`；网关不可达时保持
  `revoking`，后台循环指数退避重试（30 s 起，上限 10 分钟），Admin 页面显示待吊销数量与最近错误，不把未完成的
  吊销显示为已完成。
- 双层切断：Worker 在线时先由 `workspace.model_key.clear` 立即在中继侧停止使用（不等网关）；Worker 离线时，其
  Workspace 不可能运行中继流量，Worker 重连后 reconcile 会清掉不属于 active 行的 key。
- 签发前在事务内检查 User 状态与 Workspace 删除状态，禁用/删除与签发并发时不会产生漏网的 active key
  （`users` 行加锁，与现有禁用事务的锁顺序一致）。
- 网关的 key 只能调用 LLM API 路由；即使 key 泄露，也不能调用管理接口。
- 怀疑 Worker 宿主机或 key 文件泄露时，admin 用“轮换”（16.8）立即作废该用户或该 Workspace 的 key。

### 16.7 计量与限额

- **预算**：LiteLLM user 级 `max_budget`（USD）+ `budget_duration`。默认值来自 `MODEL_GATEWAY_USER_BUDGET_USD`
  （未设置 = 不限额）与 `MODEL_GATEWAY_BUDGET_DURATION`（默认 `30d`）；admin 可按用户覆盖（`users.model_budget_usd`）。
  超出预算时网关拒绝请求，Pi 显示网关的错误信息。预算依赖网关中的模型单价，`deploy/model-gateway/config.yaml`
  模板为 DeepSeek 写明单价。
- **限速**：每个 key 的 `rpm_limit` / `tpm_limit` 取 `MODEL_GATEWAY_KEY_RPM`（默认 60）/ `MODEL_GATEWAY_KEY_TPM`
  （默认不限）。
- **用量查询**：Control Plane 不保存用量（Phase 17 再做指标）；Portal 需要时经网关管理 API 查询该用户的
  spend、请求数与 token 数（按 pinned 版本实际提供的接口实现），缓存 60 s；网关不可达时显示“暂不可用”，不影响
  页面其他部分。
- 网关对每个请求记录 key、user、模型、token、spend，但不记录内容（16.3）。

### 16.8 Control Plane：数据模型、配置、API、Portal、Audit

migration `0012_model_gateway`：

```text
model_keys
  id                   uuid primary key (server generated)
  workspace_id         uuid null references workspaces(id) on delete set null   -- 删除后保留吊销记录
  user_id              uuid not null references users(id)
  key_alias            text not null unique                 -- arw-<workspaceId>-<n>，网关侧定位依据
  status               text not null check (status in ('issuing', 'active', 'revoking', 'revoked'))
  issue_reason         text not null check (issue_reason in ('start', 'reissue', 'rotation'))
  revoke_reason        text null check (revoke_reason in
                         ('workspace_deleted', 'user_disabled', 'lost', 'admin', 'issue_failed'))
  created_at           timestamptz not null default now()
  revoke_requested_at  timestamptz null
  revoked_at           timestamptz null
  revoke_attempts      integer not null default 0
  next_attempt_at      timestamptz null                     -- 吊销重试：30 s 起倍增，最长 10 分钟
  last_error_code      text null
  unique (workspace_id) where status in ('issuing', 'active')
  check (workspace_id is not null or status in ('revoking', 'revoked'))   -- 可用的 key 必有 Workspace

触发器（任何代码路径都覆盖）：
  workspaces BEFORE DELETE         -> 该 Workspace 的 issuing/active key 置 revoking（workspace_deleted）
  users AFTER UPDATE OF status     -> 变为 disabled 时该用户全部 issuing/active key 置 revoking（user_disabled）
  两者都写 Audit model.key_revoke_requested

users
  + model_budget_usd   numeric(12, 2) null                  -- null = 使用全局默认

workers
  + model_relay_enabled    boolean not null default false
  + model_relay_port       integer null
  + model_relay_listening  boolean not null default false
```

配置（Control Plane；`MODEL_GATEWAY_ADMIN_URL` 未设置即整体关闭，部分设置则启动失败）：
`MODEL_GATEWAY_ADMIN_URL`、`MODEL_GATEWAY_MASTER_KEY`（加入日志 redaction）、`MODEL_GATEWAY_CATALOG_FILE`、
`MODEL_GATEWAY_USER_BUDGET_USD`、`MODEL_GATEWAY_BUDGET_DURATION`、`MODEL_GATEWAY_KEY_RPM`、`MODEL_GATEWAY_KEY_TPM`。
Worker：`WORKER_MODEL_GATEWAY_URL`（未设置即不启用中继）、`WORKER_MODEL_RELAY_PORT`（默认 3101）、
`WORKER_MODEL_RELAY_MAX_BODY_BYTES`。这些不是安全开关：关闭只意味着没有平台模型，出口与隔离规则不变。

API：

- `GET /api/workspaces`、`GET /api/workspaces/:id`（及创建/启动/停止的返回）：增加 `modelAccess: { status:
  "available" | "pending" | "unavailable" | "disabled", reason: string | null }`（`pending` = 未运行且尚无 key，
  启动时签发）（`reason` 为 `MODEL_KEY_PENDING`、`MODEL_RELAY_DISABLED`、
  `USER_CONFIG_INVALID` 等稳定码），不返回 alias。
- `GET /api/me/model-usage`：当前用户的用量与预算（16.7）。
- `GET /api/admin/model-gateway`：`{ enabled, reachable, providerId, catalog: [{ id, name, presentInGateway }],
  pendingRevocations, oldestPendingAt, lastErrorCode, activeKeys }`；各 Worker 的中继状态在
  `GET /api/admin/workers` 的 `modelRelay` 字段中。
- `GET /api/admin/users/:id/model-usage`（`{ budgetUsd, available, usage }`）；
  `PUT /api/admin/users/:id/model-budget`：`{ budgetUsd: number | null }`（`null` 恢复默认，0～1 000 000，最多两位小数），
  先写数据库与 Audit，再同步到网关（`appliedToGateway` 表示是否已同步）。网关未配置时这些 admin 路由返回
  404 `MODEL_GATEWAY_DISABLED`。
- `POST /api/admin/users/:id/model-keys/rotate`、`POST /api/admin/workspaces/:id/model-key/rotate`。
- 全部 admin 路由沿用 admin role、Origin、CSRF 校验；普通用户只能看到自己的 Workspace 与用量。

Audit（新类别 `model`，按 `event_type` 前缀筛选）：`model.key_issued`（keyAlias、reason）、
`model.key_revoke_requested`（keyAlias、reason；admin 轮换时 actor 为该 admin）、`model.key_revoked`、
`model.budget_changed`（fromUsd、toUsd）。details 永不包含 key 明文；`owner_user_id` 为 key 所属用户。

Portal：

- Workspace 卡片显示“平台模型：可用 / 启动后可用 / 暂不可用（原因）”；页面说明行显示本周期用量与预算。
- Admin Users：用户“管理”展开后的“平台模型”区域：本周期用量、预算编辑、“轮换模型凭据…”。
- Admin Workers：页首“模型网关”面板（可达性、目录与网关的差异、有效凭据数、待吊销数量与最近错误），Worker
  详情中的“模型中继”。
- 中文错误说明：`MODEL_KEY_UNAVAILABLE`、`MODEL_GATEWAY_UNAVAILABLE`、`USER_CONFIG_INVALID`
  （“models.json 格式错误，平台模型未注入，请修复或删除该文件后重启 Workspace”）。

### 16.9 Worker Protocol

`WORKER_PROTOCOL_VERSION` 升到 `4`，与 v3 不兼容（同 14.11 Q5、15.12 Q9）：

- `worker.hello` / `worker.heartbeat` 增加 `modelRelay: { enabled: boolean, port: number | null, listening:
  boolean }`。
- `worker.reconcile` 的报告增加顶层 `modelKeys: [{ workspaceId, keyAlias }]`（Worker 持有的全部 key；不改动
  各命令共用的 observation 结构）。
- `workspace.ensure` payload 增加 `modelGateway: { providerId, defaultModel, models: [...] } | null`（模型定义
  schema 与 16.5 共享）；结果增加 `modelConfig: "applied" | "removed" | "unchanged_running" |
  "user_config_invalid" | "write_failed"`。
- 新命令 `workspace.model_key.set`：`{ workspaceId, keyAlias, secret }`（`secret` 为 16～512 个可打印 ASCII
  字符）。Worker 校验 managed label 与元数据后原子写入 `model-key.json` 并替换中继中的 key，返回 `{ keyAlias }`；
  Workspace 不存在返回 `WORKSPACE_NOT_FOUND`；写入失败返回 `MODEL_KEY_STORE_FAILED`（retryable）。
- 新命令 `workspace.model_key.clear`：`{ workspaceId, keyAlias }`，幂等；**只清除该 alias**，Worker 当前持有的
  是更新的 key 时保持不变（避免轮换后迟到的 clear 删掉新 key），返回仍持有的 alias。
- Worker 未启用中继时 `workspace.model_key.set` 返回 `MODEL_RELAY_DISABLED`；Control Plane 也不会为这类 Worker
  上的 Workspace 签发 key。
- 协议层与两端日志对 `secret` 字段做 redaction（扩展 Phase 13 的脱敏测试）。

### 16.10 Worker 行为

- 启动时若配置了 `WORKER_MODEL_GATEWAY_URL`：解析其主机地址加入本地 protected，渲染出口规则中的中继例外，
  加载各 Workspace 的 `model-key.json`，在 `0.0.0.0:<relayPort>` 监听（只接受 16.4 识别通过的连接）。监听失败时
  `modelRelay.listening=false`，记 `error`，其余功能不受影响。
- 出口 `enforced` 校验包含中继规则：配置了中继而规则缺失，与其他规则缺失同样处理（Phase 14 fail-closed）。
- `workspace.ensure`：在 Phase 14/15 的门禁之后、启动容器之前写 `models.json`（16.5）。
- `workspace.delete`：删除目录前清除中继映射与 key。
- 中继日志：每个请求记 workspaceId、方法、路径第一段（`/v1`）、状态码、耗时、上下行字节数；不记录请求头、
  body、key、上游响应内容。

### 16.11 部署产物

- `deploy/model-gateway/compose.yml`：pinned `litellm-database` 镜像（tag + digest）；连接现有开发 PostgreSQL
  中的 `litellm` 库；端口只发布到 `127.0.0.1:4000`；`env_file` 引用负责人本机的 `0600` 文件（仓库只提供
  `litellm.env.example`，不含真实 key）。
- `deploy/model-gateway/config.yaml`：DeepSeek 模型（`litellm_proxy/` 路由，16.16）、单价、16.3 的安全配置。
- `deploy/model-gateway/catalog.example.json`：与 `config.yaml` 一致的平台目录。
- `tools/dev/init-litellm-db.sh`：在开发 PostgreSQL 中创建 `litellm` role 与库（幂等）。
- `docs/model-gateway-runbook.md`：部署、上游 key 更换、版本升级（核对 changelog 与 digest）、待吊销排查、
  网关地址与 protected 的关系。生产模板留给 Phase 19。

### 16.12 测试计划

单元 / 组件测试（CI 常规任务）：

- 中继：来源识别（本地地址与对端地址必须同时匹配、Workspace 非运行时拒绝、未知来源断开且无响应）；路径白名单
  （query、`..`、编码斜杠、未启用的 API 类型均拒绝）；请求头白名单（客户端 `authorization`、`x-api-key`、
  `x-litellm-api-key`、`cookie` 不会到达上游，上游收到的 `Authorization` 恰为该 Workspace 的 key）；无 key 时 403
  且未连接上游；SSE 流式转发与中止传播；body 上限；并发上限；日志中不出现 key 与 body。
- `models.json` 写入：只替换平台条目、保留其他内容；符号链接、目录、非法 JSON 时不修改且报告
  `user_config_invalid`；临时文件 `O_EXCL|O_NOFOLLOW`；运行中不写；网关关闭时删除条目；`settings.json` 只在不存在时写入。
- 出口渲染：配置中继时多出两条规则、未配置时与 Phase 14 完全一致；校验能识别中继规则缺失或端口不符。
- Control Plane（fake 网关客户端）：start 时签发并先于 start 推送；User 禁用后全部 key 进入 `revoking`、Worker 收到
  clear、网关删除成功才变 `revoked`；网关故障时保持 `revoking` 并重试、不显示为已吊销；禁用与签发并发不产生
  active key；撤销 session 与 logout 不改变 key、被撤销的 session 无法经 Gateway 使用中继；admin 手动轮换后旧 key 立即失效；Workspace 删除吊销；reconcile 清除多余 key、对丢失
  key 轮换；签发失败不阻止启动；Admin API 授权（401/403/CSRF）与 Audit；普通用户看不到他人用量；数据库、日志、
  Audit 中不出现 key 明文与 master key。
- 协议 schema：v4 各消息正反例；v3 hello 被拒绝；`secret` redaction。
- migration 在 `agent_runtime_test` 上验证。

真实内核测试（扩展 `pnpm test:egress`，非特权 user+net namespace）：`arw-` 侧可连宿主机的中继端口，宿主机其他
端口仍不可达；非 `arw-` 接口连中继端口被丢弃；网关地址在 protected 中时不可达。

网关集成测试（`pnpm test:model-gateway`，需要 Docker 与 pinned LiteLLM 镜像，在本机运行；CI 是否运行见 16.14 Q8）：
LiteLLM + 测试库 + **mock 上游**（本地 HTTP 服务，记录收到的请求并返回脚本化的 SSE），不需要真实上游 key：

- `/key/generate` 的 `llm_api` key 调用 `/key/generate`、`/user/list`、`/model/info` 被拒绝；删除后立即 401。
- mock 上游收到的请求体保留 `thinking`、`reasoning_effort` 与 assistant 消息的 `reasoning_content`；
  客户端请求体中的 `api_key`、`api_base` 不改变上游地址与凭据；mock 上游收到的是网关配置的上游 key，而不是虚拟 key。
- 用量按 `user_id` 汇总；预算超出后拒绝。
- 真实 Docker 端到端：Worker 中继 + 真实 Workspace 容器中的 Pi 经 mock 上游完成一次带工具调用的对话；容器内
  `env`、`/agent/pi` 与进程列表中找不到虚拟 key。

**变异检查**（实现时执行并记录）：去掉中继的来源校验；只校验对端地址不校验本地地址；去掉请求头白名单（转发客户端
`authorization`）；去掉路径白名单；`models.json` 写入去掉 `O_NOFOLLOW`；禁用用户时不吊销；吊销在网关失败时仍标记
`revoked`；签发前不检查用户状态；去掉 `relay_input` 规则或 `fib daddr type local` 例外改为不限端口——对应测试均应失败。

### 16.13 验收

自动验收：上述测试全部通过，CI 绿。

人工验收（详细步骤随交付说明给出），要点与预期结果：

0. **准备**（负责人）：在本机 `0600` 文件中填入 DeepSeek 的真实 key；`tools/dev/init-litellm-db.sh`；
   `docker compose -f deploy/model-gateway/compose.yml up -d`；Control Plane 与 Worker 配置网关变量后重启。
   预期：Admin“模型网关”显示可达、目录与网关一致；Admin Workers 显示中继已启用；`nft list table inet agent_runtime`
   含中继规则。
1. 新建 Workspace 并打开 pi-web：模型列表中出现平台 provider 的 DeepSeek 模型，默认选中目录默认模型；
   **不在 `auth.json` 中填写任何 key** 即可对话，并完成一次带思考的多轮工具调用（例如让 Agent 读写文件），
   deepseek-v4-flash 与 deepseek-v4-pro 各一次。
2. 在 Terminal 中：`env`、`cat /agent/pi/models.json /agent/pi/auth.json`、`ps -ef` 中找不到虚拟 key 与上游 key；
   `curl` 中继的非白名单路径（如 `/key/generate`、`/v1/models`、`/ui`）返回 404；带伪造 `Authorization` 访问
   白名单路径仍按本 Workspace 计量；直接访问网关地址（开发为 `:4400`）、宿主机其他端口不可达。
3. 存量 Workspace（已有自有 deepseek key）：停止再启动后，原有 `auth.json`、`settings.json` 与自有 provider 不变，
   同时多出平台 provider；两种方式都可用。
4. 计量：Portal 显示本用户的用量，与网关管理端一致；admin 把该用户预算调到极低值后，下一次请求被拒绝并在 pi-web
   中显示原因；恢复后可用；Audit 有 `model.budget_changed`。
5. 吊销：(a) 禁用用户 → 浏览器中的 pi-web 立即断开（Phase 9–12 的 fail-closed，预期现象）；在宿主机上
   `docker exec agent-runtime-<workspaceId> curl -s -X POST http://<bridge 网关>:3101/v1/chat/completions -d '{}'`
   返回 403 `MODEL_KEY_UNAVAILABLE`，`model_keys` 中该用户的 key 为 `revoked`（`user_disabled`），Audit 有
   `model.key_revoke_requested` / `model.key_revoked`；重新启用后 30 秒内签发新 key，再次可用。(b) admin 撤销该用户 session → 浏览器立即失去 Workspace 访问，正在运行的
   Agent 任务继续可用，key 不变；admin 执行“轮换模型凭据” → 网关中旧 key 删除、新 key 生效，Agent 任务继续可用。
   (c) 删除 Workspace → 对应 key 删除。Audit 均有记录。
6. 网关不可用：`docker compose stop`，启动 Workspace 仍成功、Portal 显示平台模型暂不可用；此时禁用一个用户，Admin
   页面显示待吊销；网关恢复后在重试周期内完成吊销与签发。
7. Worker 重启：中继恢复，运行中 Workspace 的 key 从 `model-key.json` 恢复；手动删除某 Workspace 的
   `model-key.json` 后重启 Worker → reconcile 触发轮换，旧 key 在网关中删除。
8. 用户把 `/agent/pi/models.json` 换成指向其他文件的符号链接后重启 Workspace：目标文件不被修改，Portal 显示
   `USER_CONFIG_INVALID`。
9. 开启 Clash TUN 重复第 1、2 步：中继与网关之间的流量走宿主机路由，不受影响；Workspace 仍不可达网关。

失败时收集：Control Plane / Worker 日志（按 request ID 与 workspaceId）、`docker logs` 网关容器（确认不含 prompt）、
`nft list table inet agent_runtime`、Admin“模型网关”页面截图、`model_keys` 表中相关行（不含明文）。

### 16.14 待决问题

2026-10-08：Q1–Q3、Q5–Q9 负责人确认按建议执行；Q4 按负责人提出的问题重新评估后改为“不改变 key”，负责人已确认。

- **Q1 网关选型**（**已确认：按建议**）：采用 LiteLLM Proxy（16.3），以 16.15 spike 通过为前提；不通过时依次评估
  Bifrost、New API。
- **Q2 接入方式**（**已确认：按建议**）：采用 Worker 模型中继（16.4），虚拟 key 不进入容器，网关对 Workspace 完全
  不可达；第 43.1、44 节已同步修改。
- **Q3 网关不可用时的启动行为**（**已确认：按建议**）：Workspace 照常启动、平台模型暂不可用。**吊销**始终 fail-closed（16.6）。
- **Q4 session 撤销的语义**（**已确认，2026-10-08：key 不变化**）：原建议是“admin 撤销 session 时轮换 key”。
  在 Q2 的中继方案下，key 从不出现在容器、浏览器或 Control Plane 数据库中，持有被撤销 session 的人无法带走它；
  撤销后该 session 已无法经 Gateway 进入 Workspace，也就无法再使用中继。轮换不再增加任何保护，反而增加一条
  需要测试的状态路径，因此删除。保留 admin 手动轮换，用于怀疑 Worker 宿主机或 key 文件泄露的场景。路线图中
  “session 撤销时虚拟 key 失效”这一条的目的（撤销后不能再用平台模型）由 Gateway 的 session fail-closed 达成。
- **Q5 默认值**（**已确认：按建议**）：每用户预算默认不限额、周期 `30d`；每 key 60 RPM、TPM 不限；中继端口 3101、
  body 32 MiB、每 Workspace 并发 16、单个请求的空闲超时 600 s（含义见 16.4）。
- **Q6 Pi 默认模型**（**已确认：按建议**）：只对新 Workspace（无 `settings.json`）写入平台默认模型。
- **Q7 provider 名称**（**已确认：按建议**）：默认 `platform`，可由目录的 `providerId` 配置。
- **Q8 网关集成测试**（**已确认：按建议**）：只在 `runtime-toolchain.yml`（master push / 每周）运行，PR 上跑单元测试
  与 mock 测试。
- **Q9 用户自有 key**（**已确认：按建议**）：不触碰用户 `auth.json` 中的自有 key，不做提示或自动删除。

### 16.15 开工 spike（编码前，需要负责人参与）

目的：在写平台代码之前，用真实上游确认 LiteLLM pinned 版本满足 16.3 的硬性要求。需要外部网络与真实 key，
key 只写入负责人本机的 `0600` 文件，不进入仓库、对话或日志。步骤：

1. 选定 LiteLLM 版本，拉取 `ghcr.io/berriai/litellm-database:<版本>`，记录 digest；核对其 changelog 与 2026-03
   供应链事件的公告，确认镜像不含 1.82.7 / 1.82.8。**已完成（2026-10-08）**：`1.104.1`，
   `sha256:e187eea4b0bbc94c57b93d7dffcd3ce403f17375398a54539a4369cbf8a0e160`（`linux/arm64`，Chainguard wolfi-base，
   Python 3.13.16）；包内 `litellm` 元数据版本 1.104.1，`site-packages` 中无 `litellm_init.pth`。负责人本机的
   `~/.config/agent-runtime/litellm.env`（`0600`）含 `DEEPSEEK_API_KEY`、`XIAOMI_API_KEY`、`LITELLM_MASTER_KEY`。
2. 在开发 PostgreSQL 中创建 `litellm` role 与库；以临时 `config.yaml`（DeepSeek、MiMo、16.3 的安全配置）启动，
   只发布到 `127.0.0.1:4000`。
3. 用 master key 创建 user 与 `key_type: "llm_api"` 的 key；验证该 key 调用管理路由被拒绝、删除后 401。
4. 用该 key 对 `deepseek-v4-flash` 与 `mimo-v2.5-pro` 各做一次 **带 `thinking` 的两轮工具调用**（第二轮在 assistant
   消息中回传 `reasoning_content`），确认成功；确认请求体中的 `api_base` / `api_key` 不生效；确认 spend log 中没有
   prompt 与响应内容；确认 `/user/info`（或 pinned 版本的等价接口）能返回该用户的 spend 与 token。
5. 结论与版本、digest 写入本节；不通过则按 Q1 回到选型。

**spike 结论（2026-10-08，`tools/dev/model-gateway-spike.py`，31/31 通过）**：LiteLLM 1.104.1 满足 16.3 的全部
硬性要求，选型确定。

- 开发网关监听 `127.0.0.1:4400`（Q8B 的 4000 端口已被宿主机上与本项目无关的进程占用）；`litellm` role 与库由
  `tools/dev/init-litellm-db.sh` 创建，网关经 compose 网络 `agent-runtime-platform_default` 连接开发 PostgreSQL。
- `deepseek-v4-flash`、`mimo-v2.5`、`mimo-v2.5-pro`：按 Pi 0.85.1 的请求形态（`thinking: {type: "enabled"}`、
  `reasoning_effort`、tools、流式 + `include_usage`）完成两轮工具调用，第二轮回传 `reasoning_content` 成功；
  流式 usage 带 `cost`。
- （被后续 mock 测试推翻，见 16.16）当时以为 MiMo 可以用 `deepseek/` provider + MiMo 的 `api_base`：`openai/`
  拒绝 `thinking`（`UnsupportedParamsError`；加 `allowed_openai_params` 后 OpenAI SDK 报未知参数），内置
  `xiaomi_mimo/` 拒绝 `tools`、`thinking`、`reasoning_effort`。`drop_params: false` 保证参数不被静默丢弃。
- `key_type: "llm_api"` 的 key 调用 `/key/generate`、`/key/list`、`/key/delete`、`/user/list`、`/user/new`、
  `/user/info`、`/model/new`、`/spend/logs`、`/global/spend` 均为 403。仍可访问的只读路由：`/v1/models`、
  `/model/info`（只列该 key 可用的模型，`api_key` 为空，MiMo 显示公开的 `api_base`）、`/openapi.json`；
  `/ui` 在 `DISABLE_ADMIN_UI=True` 时仍返回静态前端外壳（登录受保护）；`/config/yaml` 对任何 key 都先报请求体
  校验错误 422。中继的路径白名单不转发这些路由（16.4），Workspace 在网络层面也无法到达网关。
- 请求体中的 `api_base` / `base_url` / `api_key` 被拒绝（401，`allow_client_side_credentials: false` 为默认）。
  **key 的 `metadata` 不能用 `workspace_id` 作为字段名**：LiteLLM 把它当作客户端传入的 provider 参数拒绝签发；
  平台使用 `platform_workspace_id`。
- spend 按 `user_id` 汇总（`/user/info` 的 `spend`）；`LiteLLM_SpendLogs` 39 行中没有任何 prompt 或响应内容；
  容器日志中没有 key、数据库 URL 或 prompt。删除后的 key 立即 401；删除不存在的 alias 返回 404
  （`No keys found`），平台把它视为“已删除”。

### 16.16 实现中的调整（2026-10-08）

相对 16.1–16.15 的设计，实现时做了以下调整（均已反映在上文对应小节或下列说明中）：

- **网关路由改为 `litellm_proxy/`**：`pnpm test:model-gateway`（真实 LiteLLM + mock 上游）发现 `deepseek/` provider
  在带 `thinking` 时**丢弃 `reasoning_effort`**（LiteLLM 把它只当作开关），Pi 的 low/high/max 强度因此无法到达上游。
  对比 `deepseek/`、`openai/`（含 `allowed_openai_params`）、`hosted_vllm/`、`litellm_proxy/`：只有 `litellm_proxy/`
  原样转发 `thinking`、`reasoning_effort`、`tools`、`max_tokens` 与回传的 `reasoning_content`。该路由没有内置单价，
  `config.yaml` 在 `model_info` 中写明单价（沿用 LiteLLM 价目表的 DeepSeek 值）。真实上游复验：spike 31/31
  （含 `--effort max`），`model-relay-smoke.ts` 中真实 Pi 0.85.1 经中继完成带工具调用的对话（deepseek-v4-flash、
  deepseek-v4-pro）。
- **目录 compat 必须显式写全**：Pi 按 provider id 或 `deepseek.com` 域名推断 DeepSeek 的 compat；平台 provider 的
  baseUrl 是中继地址，推断不生效，目录写明 `supportsStore: false`、`supportsDeveloperRole: false`、
  `maxTokensField: "max_tokens"`、`requiresReasoningContentOnAssistantMessages: true`、`thinkingFormat: "deepseek"`。
- **同一目录不能混用 OpenAI 与 Anthropic 类 API**：Anthropic SDK 自己拼 `/v1/messages`，OpenAI SDK 只拼
  `/chat/completions`，provider 级 baseUrl 无法同时满足（schema 拒绝）。中继的路径白名单是三种 API 类型推理路径的
  并集，而不是按目录推导。
- **Worker 记住写入的 provider id**（Workspace 元数据 `modelProviderId`）：网关整体关闭（ensure 中
  `modelGateway: null`）或 provider id 改名时据此删除旧条目。
- **吊销由数据库触发器兜底**（16.8），`beginWorkspaceDelete` 在同一事务中也立即发起吊销；签发事务按“用户行
  `FOR SHARE` → Workspace 行 `FOR SHARE` → 插入（冲突即返回 `ALREADY_LIVE`）”加锁，禁用/删除与签发并发时不会留下
  可用 key（真实 PostgreSQL 并发测试覆盖）。网关调用期间被吊销的 key 不会交给 Worker。
- **网关不可用时不堆积 key**：后台处理在本轮发现网关不可达后跳过补签；处理过程中的失败不会再触发新一轮（修复了
  一个会导致忙循环的设计缺陷，有回归测试）。超过 1 分钟仍为 `issuing` 的行按 `issue_failed` 吊销。
- **预算接口**改为 `PUT /api/admin/users/:id/model-budget`（不扩展用户 PATCH，16.8）。
- **LiteLLM 行为**：`/user/update` 对不存在的用户会静默创建一个无角色用户，平台先 `/user/new`（`internal_user_viewer`），
  409 时再 update；删除不存在的 alias 返回 404，视为已删除；预算超出返回 422 `budget_exceeded`。
- **CI**：`pnpm test:model-gateway` 加入 `runtime-toolchain.yml`（拉取 pinned 镜像）；PR 上运行其余单元、mock 与
  PostgreSQL 集成测试；真实内核出口测试（`pnpm test:egress`）覆盖中继例外。
- **变异检查（已执行，全部被测试发现）**：中继接受未知来源；只校验对端地址；转发客户端请求头；转发任意路径；
  无 key 时仍转发；`models.json` 读取跟随符号链接；运行中改写 `models.json`；中继端点不校验 label；Worker 清除任意
  alias；出口例外不限端口（单元与真实内核两层）；去掉 `relay_input`；去掉禁用触发器；签发不检查用户状态；激活不检查
  吊销；网关删除失败仍标记 `revoked`；网关调用期间被吊销仍交付；禁用后不触发吊销；key 在 start 之后才签发。

### 16.17 Xiaomi MiMo 延后到 Phase 18

负责人 2026-10-08 决定：本 Phase 只交付 DeepSeek；MiMo 在 Phase 18 升级 Pi / pi-web 之后再接入与验收。已获得的
事实供 Phase 18 使用：MiMo 同样必须走 `litellm_proxy/` + `api_base: https://api.xiaomimimo.com/v1`；
`reasoning_effort` 只接受 `low` / `medium` / `high`（`minimal` / `xhigh` / `max` 返回 400），目录需用
`thinkingLevelMap` 把这三档设为 `null`；在此配置下 mimo-v2.5 与 mimo-v2.5-pro 的真实 Pi 冒烟测试已通过（2026-10-08）。

## Phase 17：可观测性

状态：待开工设计。

- Prometheus 指标（Workspace 状态、Worker 心跳、Gateway 请求/延迟/错误、命令超时、容器 CPU/内存/磁盘）、
  Portal 实际用量、示例告警与面板。
- 验收要点：制造 Worker 离线与磁盘接近上限时告警触发；Portal 数字与 `docker stats` 一致。

## Phase 18：生命周期运维

状态：待开工设计。

- 空闲回收（第 41 节，默认关闭）。
- Runtime 镜像升级与回滚：停止状态下重建容器、保留持久目录。
- 以 pi-web 0.9.0 → 0.10.x、Pi 0.85.1 → 1.0.x 作为首次真实升级（含 default-cwd patch 重写与 MCP、
  project-trust 行为验证），见 `docs/v1-roadmap.md` 决策 D7。
- 修复 `enabled=false` 时 Workspace 未置为 `WORKER_OFFLINE` 的不一致，提供 `worker:disable` 运维命令。
- 验收要点：空闲 Workspace 按规则停止且数据完整、有计算活动的不被停止；升级后 Pi Session 与文件完整；
  回滚可用。

## Phase 19：生产部署与 v1.0 发布

状态：待开工设计。

- 生产镜像或 systemd unit、部署模板（ARM64 优先）、TLS/wildcard 与反向代理文档（含 SPA fallback 与
  WebSocket 超时）、升级与回滚流程、外部备份说明（第 28 节）。
- 验收要点：按文档在全新设备上从零部署成功；从 v0.13 升级到 v1.0 数据完整；完整回归通过。

---

# 65. Phase 开发流程

适用于 Phase 13 起的全部开发：

1. **开工设计**：扩写第 64 节对应小节，核对 pinned upstream，列出待决问题；负责人确认后再编码。
2. **分支**：在 `phase-NN-<name>` 分支开发；master 始终是已验收状态。
3. **自动验证**：新增能力必须有测试；安全相关判断做变异检查；migration 在真实 PostgreSQL 的独立测试库
   上验证，不使用开发库。
4. **文档同步**：本文件、`docs/progress.md`、README 与相关 runbook 随代码更新。
5. **交付说明**：Phase 完成时输出变更总结，并附逐步可执行的**人工验收步骤**：前置条件、操作步骤、预期
   结果，以及失败时需要收集的信息（日志位置、命令输出）。
6. **人工验收**：负责人在真实环境按步骤验证；环境级问题按 `AGENTS.md` 第 15 节协同排查。
7. **合入与标记**：验收通过后合入 master，打 `v1.0.0-alpha.N` tag；Phase 19 完成后依次打
   `v1.0.0-rc.1`、`v1.0.0`。
