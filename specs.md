# specs.md

# 面向企业私有环境的容器化安全隔离智能体任务执行平台

**Prototype Product & Technical Specification**

版本：`0.2 MVP`
状态：原型设计稿
核心依赖：`pi-web + pi-agent + Docker`

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

镜像体积较大。

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

## 9.2 多机比赛 Demo

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
- 当前 Control Plane 上存在 authenticated control channel
- heartbeat 未超过 offline threshold
- 未超容量
- architecture compatible
- runtime image compatible
- capability compatible

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
在保留默认 outbound Internet 的同时，宿主机发布的 pi-web 端口必须只绑定
`127.0.0.1`，并测试 Workspace A 无法连接 Workspace B 的 pi-web、宿主机 loopback
upstream 或 Worker Gateway 管理入口。

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

如比赛以后要做：

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

这在 MVP 可接受。

---

# 29. 用户与权限

MVP：

```text
User
Admin
```

User：

- 管理自己的 Workspace
- 访问自己的 pi-web
- 启动/停止自己的 Runtime

Admin：

- 查看 Worker
- 查看 Workspace placement
- disable Worker scheduling

Admin 不必默认访问用户 Workspace 内容。

---

# 30. Authentication

MVP 可本地账户：

```text
email / username
password
```

要求：

- modern password hash
- HTTP-only cookie
- HTTPS 时 Secure
- CSRF 策略与选用 Auth 方式匹配
- Server-side ownership check

由于 Portal 与 `<workspace-id>.agent.example.internal` 分属不同 Host，MVP 不依赖一个
宽域 `Domain=.agent.example.internal` Cookie 覆盖所有 Workspace。固定采用：

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
6. 平台 state-changing API 校验 CSRF token 与 `Origin`，WebSocket upgrade 校验
   session、`Origin`、Host 与 Workspace ownership。

服务端注销或失效 session 后，Portal 和各 Workspace Host 的 Cookie 即使仍存在也不得
继续获得访问权限。

Runtime 内 pi-web 的 `PI_WEB_PASSWORD` 在 MVP 默认不启用。平台用户只登录一次，由 Control Plane / Gateway 完成身份认证和 Workspace ownership 授权。

该设计依赖网络边界：用户不能直接访问 pi-web，也不能绕过 Control Plane 直接访问 Worker Gateway。

未来再加：

- OIDC
- LDAP
- 企业 SSO

---

# 31. 数据模型

## users

```text
id uuid
email text
password_hash text
role text
created_at
```

## workers

```text
id text
hostname text
architecture text
status text
enabled bool
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

仅保存追加式平台基础设施事件：

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

例如：

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

Workspace/Worker 的数据库生命周期事件与状态变更在同一事务追加，避免状态已经生效但 Audit 漏记。
Workspace 删除后 Audit 仍保留，因此 subject ID 不作为级联删除外键。普通用户只能查询
`owner_user_id` 为自己的事件；admin 可以查看平台事件。`details` 只允许平台控制的结构化 metadata，
不得保存 Cookie、session exchange code、credential、Prompt、Pi message/tool stream 或文件内容。

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

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/me
```

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
GET /api/admin/workspaces
```

## Audit

```text
GET /api/audit-events?limit=30&before=<event-id>
```

返回倒序、cursor pagination 的结构化平台事件。普通用户只看到自己的 Workspace 事件；admin 可看到
全平台 Workspace/Worker 事件。响应禁止缓存，不提供 Pi conversation 或 tool stream 导出。

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

Worker Gateway 的监听地址、TLS/认证方式必须配置化，并在真实多主机环境中验证。比赛/开发环境可使用受保护内网，但不得让最终用户绕过 Control Plane 直接访问。

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

MVP 可简单：

```text
never auto-stop
```

或：

```text
idle N hours -> stop container
```

但不要删数据。

比赛 Demo 建议关闭 auto-stop，避免干扰。

未来：

- cost control
- resource reclaim

再加复杂策略。

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

管理员可能配置：

- model API key
- internal API key

MVP：

- 不进 browser localStorage
- 不写 `/workspace`
- 不打 log
- 不进入 Artifact
- Runtime 按需注入

这里约束的是平台自身的存储与日志行为，不代表可以向有 shell 权限的 Agent 隐藏已经
注入 Runtime 的 secret。Agent 进程原则上能够读取自身环境和 Pi credential store；
因此 MVP 只面向已声明的可信内部用户边界，不能宣称 secret 对 Workspace 内代码不可见。
用户通过 pi-web 配置的模型凭据可能由 Pi 持久化到 `/agent/pi`，该目录必须按 Workspace
隔离、不得进入 Artifact，并以当前 pinned Pi 的实际格式为准。

未来再做 per-user Secret。

---

# 44. Network

MVP 默认允许 outbound Internet：

因为 Agent 可能需要：

- Git clone
- package install
- model API
- Playwright
- download

但文档必须写清楚：

> 当前只实现 Container / filesystem / process 基础隔离，尚未实现完整 egress policy。

“允许 outbound Internet”不等于允许访问平台 management plane 或其他 Workspace。
即使完整域名/IP egress ACL 延后，MVP 仍必须保持第 25、37 节的租户网络隔离和
Worker Gateway 强认证；Runtime 不得获得 control/gateway credential。

未来可加：

```text
open
restricted
offline
```

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

# 53. MVP UI

平台自己的 UI 不要和 pi-web 重复。

平台只需要：

## Login

```text
username
password
```

## Workspace List

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

点击 Open 后进入：

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

# 55. 原型开发阶段

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

## Phase 8：比赛展示增强

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
- polished README 与比赛 runbook：明确 preflight、演示路径、验收清单、cleanup 和自动化边界。

Phase 8 验收：

- User A/B 登录、创建/调度、打开 pi-web 和跨用户拒绝均正常；
- 真实 Prompt streaming、Terminal/tool execution 和 pi-web Files 成果查看/下载正常；
- Stop/Start 后文件和 Pi Session 恢复，sticky Worker ID 不改变；
- Worker/Workspace/安全/Runtime capability/Audit 展示与真实状态一致；
- Audit 中没有 Pi conversation、tool stream、credential 或文件正文；
- 根质量门、确定性 E2E、真实 Docker Runtime E2E 通过，并按 runbook 完成人工验收。

---

# 56. 比赛 Demo

推荐完整演示：

## Step 1

打开 Admin：

```text
worker-amd64-01 ONLINE
worker-arm64-01 ONLINE
```

## Step 2

User A 创建：

```text
dev-workspace
```

## Step 3

Scheduler：

```text
-> worker-amd64-01
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

---

# 57. 与 Dify 类系统的区别

答辩时不要攻击其他产品。

可以客观表达：

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

因此 pi-web 是底层 Runtime 产品，而不是竞争关系。

---

# 59. 安全边界

MVP 面向：

> 企业内部可信用户 + 相互隔离需求。

Docker 提供：

- namespace
- filesystem
- process
- resource
- network 基础隔离

但不是：

> hostile arbitrary code VM sandbox。

文档必须准确说明。

---

# 60. 后续方向

MVP 后再考虑：

- Human-in-the-loop approval
- egress ACL
- Workspace snapshot
- Workspace migration
- NAS / object storage
- Worker drain
- Kubernetes backend
- gVisor
- Kata
- microVM
- OIDC
- per-user Secret
- GPU Worker
- quota
- scheduled task
- MCP management
- central model gateway
- Audit export

---

# 61. MVP Acceptance Checklist

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

---

# 62. 第一阶段真正要跑通的最小主链

不要被完整清单带偏。

第一轮编码真正只需要跑通：

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

项目的主要工程价值在第一层和第四层的组织方式：

> 把成熟的 CLI Agent + Web Wrapper 变成一个可以被企业多用户安全共享的分布式 Agent Runtime Platform。

不应通过重写 pi-web 来制造不必要的工作量。
