# AGENTS.md

## 0. 项目定位

本仓库实现：

# 面向企业私有环境的容器化安全隔离智能体任务执行平台

英文工作名：**Containerized Agent Runtime Platform**

核心不是重写 Chat UI 或 Agent Loop，而是在 **pi-web + pi-agent** 之上补齐企业多用户运行基础设施：

- Multi-user / Authentication / Authorization
- Workspace 隔离与生命周期
- Docker Runtime
- 多主机 Worker 与调度
- 资源限制
- 安全访问代理
- 基础审计与运行状态

核心理念：

> 不是给大模型挂几个工具，而是给智能体提供一台隔离的计算机。

---

## 1. 文档职责与事实优先级

- `AGENTS.md`：长期有效的工程规则、架构不变量、安全边界和开发行为约束。
- `specs.md`：产品规范、系统设计、Phase scope 与验收标准。
- 代码、测试、配置：已经实现的真实行为。
- upstream 源码/文档：pi-web、pi-agent 等外部依赖的协议和路径事实。

若这些来源发生实质冲突：

1. 不要靠猜测自行折中；
2. 先验证代码、测试、配置和当前 pinned upstream；
3. 明确报告冲突；
4. 在本次改动范围内同步更新已经过期的文档。

不要把聊天历史当作唯一事实来源。

---

## 2. 第一原则：优先复用 pi-web

本项目优先复用：

- pi-web: `https://github.com/agegr/pi-web`
- pi-agent / Pi Coding Agent

**不要在没有必要的情况下重新实现 pi-web 已经解决的问题。**

原则上 pi-web 负责：

- Pi Session 管理与恢复
- Chat / streaming / thinking / Tool Call 展示
- Prompt / abort 等交互
- Terminal / Files / Git
- Pi 与前端之间的 RPC / streaming
- 模型和 Agent 配置
- pi-web 已实现的其他 Web Wrapper 能力

平台层负责：

- 用户与权限
- Workspace
- Worker / Scheduler
- Docker Runtime
- 生命周期
- Gateway
- 资源限制
- 平台级审计与状态

如需改变 pi-web，按以下优先级：

1. 配置
2. Gateway / reverse proxy 适配
3. 小型 patch
4. 必须 fork 时保持改动最少

除非检查当前 pinned upstream 后确认无法满足需求，否则不要自研替代：

- Chat 页面
- Pi RPC parser / message schema
- Pi Session picker
- Tool renderer
- Terminal frontend
- 文件浏览器
- Git UI
- streaming bridge

---

## 3. 核心抽象与架构不变量

MVP：

```text
User
  └── Workspace
        ├── 1 persistent filesystem
        ├── 1 Docker Container allocation
        ├── 1 pi-web instance
        └── N Pi Sessions
```

必须保持：

> **Platform Workspace != Pi Session**

不要把一次聊天映射成一个 Docker Container。

核心调用链：

```text
Browser
  -> Control Plane / Gateway
  -> Worker
  -> Docker Workspace
  -> pi-web
  -> pi-agent
```

层次职责不得重新揉成一个巨型应用：

- Platform：多用户、隔离、调度、生命周期、安全访问
- pi-web：Web Agent 交互
- pi-agent：Agent Loop
- Runtime：完整 Linux 工作环境

---

## 4. Runtime 与数据不变量

Workspace Container 默认：

```text
privileged = false
hostNetwork = false
dockerSocket = none
normalUser = agent
```

禁止：

- `/var/run/docker.sock`
- arbitrary host bind mount
- host root filesystem
- `--privileged`
- 用户输入直接变成 host path
- Browser 直接访问 Worker control API
- 暴露 Docker Remote TCP API

只允许平台管理的持久目录。

Canonical workspace data 必须位于平台管理的持久目录，不得依赖 Container writable layer。

Pi/pi-web 的实际状态路径必须根据**当前 pinned version**源码和文档确认，不要猜路径。当前设计应优先通过 `PI_CODING_AGENT_DIR` 显式指定 Pi state 目录；只有 upstream 确认存在额外必须持久化的 pi-web state 时才新增独立目录。

Container stop/start、Worker restart 后，Workspace 文件和 Pi Session 必须可恢复。

---

## 5. Worker 与 Control Plane 边界

Control Plane 负责：

- Auth / Authorization
- User / Workspace API
- Workspace -> Worker 调度
- Worker Registry / Heartbeat
- Workspace 生命周期与状态
- HTTP + WebSocket Gateway
- Admin UI
- 基础 Audit

Control Plane **不理解 Pi 内部 Session 协议，不直接实现 Pi RPC**。

Worker：

- 主动连接 Control Plane
- 只管理本机 Docker
- 创建/启动/停止/删除本系统 Workspace Container
- 管理平台持久目录
- 设置 CPU / Memory / PID limit
- 上报状态与 capability
- restart 后 reconciliation

Worker 只能修改带正确 managed label 的本系统 Container，不得因为 Control Plane 传来 container id 就无条件操作。

Control Plane 发送业务命令，Worker 自己翻译为 Docker Engine API 操作；不要发送 `exec: "docker run ..."` 一类任意 shell 命令。

MVP 跨主机数据通道固定采用：

```text
Browser
  -> Control Plane / Gateway
  -> authenticated Worker Gateway
  -> 127.0.0.1:<workspace-port>
  -> pi-web
```

Worker Gateway 只应暴露给 Control Plane 可达的受保护网络，不作为用户入口。MVP 不实现基于 Worker persistent WebSocket 的通用 HTTP/WebSocket byte tunnel。

---

## 6. 调度与生命周期不变量

Phase 边界必须保持清晰：

- Phase 3/4：如果系统中只有一个 eligible Worker，可直接将首次启动的 Workspace 自动绑定到该 Worker；这只是最小可运行绑定逻辑，不算完整 Scheduler。
- Phase 5：再实现多 Worker 的 capacity / capability / architecture / runtime compatibility 筛选与负载评分。
- 不要为了完成 Phase 3/4 提前实现 Phase 5 的完整调度策略。

MVP 使用 sticky placement：

> Workspace 一旦分配到 Worker，默认保持固定。

Worker Offline：

- Workspace -> `WORKER_OFFLINE`
- 不自动在其他 Worker 创建副本
- MVP 不做 Live Migration / Distributed Filesystem / State Replication

Workspace state 与 Pi Session state 必须分离。

浏览器断开：

- 不删除 Workspace
- 不停止 Container
- 不停止 pi-web
- 不主动 abort Pi

Session continuity 交给 pi-web / Pi。

Workspace 操作语义必须明确区分：

- `stop`：停止 Runtime，但保留所有 persistent Workspace / Pi Session 数据与 metadata。
- `delete`：永久删除 Workspace；删除 managed Container、该 Workspace 的 managed persistent directory 和平台 metadata。
- Worker Offline 时，如果平台无法确认并完成底层数据删除，不得把 destructive delete 假装成成功。

---

## 7. Authentication / Authorization

MVP role：

```text
user | admin
```

所有 Gateway 请求必须做 authentication + Workspace ownership check。

MVP 用户入口固定采用 Workspace subdomain：

```text
https://<workspace-id>.agent.example.internal/
```

不要把 `/w/<workspace-id>/...` 作为主访问方案；避免为 pi-web 强行引入复杂 base-path rewrite。

UUID 只是 locator，不是 credential。

Runtime 内的 pi-web 不启用第二层用户密码认证。用户身份与 Workspace ownership 统一由 Platform Gateway 负责；这一前提成立的条件是 pi-web endpoint 不能被最终用户直接访问。

用户不得：

- 访问其他用户 Workspace
- 通过猜 UUID 绕过授权
- 获取 Worker Docker 信息
- 指定任意 container id / host path

尤其测试 HTTP proxy 与已经建立的 WebSocket 都不能切换到其他用户 Workspace。

---

## 8. Worker Protocol

协议必须：

- versioned
- typed
- runtime validated
- 网络输入全部验证
- 推荐共享 Zod schema

最小业务命令参考 `specs.md`。

`workspace.ensure` 必须 idempotent。

Infrastructure command 不使用 shell string interpolation；优先 Docker Engine API。

---

## 9. Runtime Image 原则

Runtime Image 是产品组成部分，不是普通依赖。

最终目标包含：

- 常用 Base CLI / Build 工具
- Python + uv
- Node + pnpm
- Rust
- PDF / Office
- ffmpeg
- Playwright / Chromium
- pi-web + pi-agent

但各 Phase 的具体范围和验收以 `specs.md` 为准，**不要提前把后续 Phase 的完整 Toolchain 塞进前置 Phase**。

目标架构：

```text
linux/amd64
linux/arm64
```

capability 必须以实际测试为准。某架构不可用就上报 `false`，不要通过文档假装支持。

pi-web、Pi、Node major、Playwright 等 drift-prone 依赖必须 pin 到经过测试的版本/commit。

---

## 10. 开发与测试规则

修改代码前：

1. 阅读本文件。
2. 阅读 `specs.md` 中当前 Phase、相关架构与验收部分。
3. 检查 repo / branch / working tree。
4. 对涉及 pi-web/Pi 的行为检查当前 pinned upstream。
5. 先判断需求是否已由 pi-web 实现。

开发模式即使只有一台机器，也保持：

```text
Control Plane
Worker
PostgreSQL
Workspace Container
```

不要为了方便绕过 Worker 直接创建 Runtime。

每次改动：

- 只做当前 scope 所需工作
- 不做无关大重构
- 不覆盖用户已有修改
- TypeScript strict
- 不用 `any` 绕过协议
- proxy route 先 authorize
- server-generated UUID
- pi-web-specific adapter 尽量集中

测试必须优先覆盖：

- ownership
- HTTP / WebSocket Gateway
- Worker auth / heartbeat / labels / resource limits
- persistence / reconciliation
- Runtime capability
- pi-web 集成边界

不要为了“让测试绿”而降低原本应保证的安全或语义要求。

---

## 11. Git 安全规则

除非用户明确要求，不要执行破坏性或大范围 staging 操作：

```text
git reset --hard
git clean -fd
git checkout .
git add .
git add -A
```

提交时只选择明确文件，保持 cohesive change，不覆盖用户已有修改。

---

## 12. MVP 明确不做

MVP 完成前不要自行扩展到：

- Multi-Agent / Agent Team / Supervisor / Workflow DAG
- Kubernetes / Docker Swarm
- Workspace 热迁移
- Distributed Filesystem
- GPU Scheduler / Autoscaling
- 企业 SSO / 复杂 RBAC / 计费
- VM / microVM / gVisor / Kata
- 完整零信任网络隔离
- Plugin Marketplace
- 自研 Pi Agent Loop
- 自研 pi-web 替代品

研究重点是 **Agent Runtime Infrastructure**，不是 Multi-Agent。

---

## 13. Artifact 边界

MVP 必须证明 Agent 能在 `/workspace` 生成一个真实成果，并由用户通过 pi-web 的现有文件能力安全查看/下载。

平台级 Artifact registry / Artifact 页面不是核心主链；只有 `specs.md` 对后续 Phase 明确要求时再实现。

如果平台层保存 Artifact path：

- 只允许 Workspace root 下的 relative path
- 禁止 `..`
- 禁止 absolute path
- 防 symlink escape
- 下载时重新做 ownership check

---

## 14. 安全表述

可以描述：

- Docker-based isolation
- per-user Workspace isolation
- filesystem / process / resource isolation
- authenticated reverse proxy
- no remote Docker socket exposure
- application authorization

不能宣称：

- VM-grade isolation
- hostile-code absolute security
- zero-trust sandbox
- 防全部 container escape
- production-ready arbitrary-code execution cloud

MVP 面向可信企业内部用户之间的隔离需求。

---

## 15. 人机协同调试原则

遇到以下问题，不要长时间盲目试错或大范围改代码：

- 网络、DNS、Proxy、VPN、TUN、路由
- Docker networking / Container DNS / 端口
- HTTP / WebSocket reverse proxy
- pi-web base path / proxy compatibility
- Worker 与 Control Plane 跨主机通信
- Host / Container UID/GID、volume / bind mount
- Playwright / Chromium 环境
- AMD64 / ARM64 差异
- TLS / Certificate / Cookie / CSP
- iptables / nftables / 防火墙
- 外部模型 API、npm/pypi/crates.io 可达性

同一问题连续尝试 3 种明显不同的修复方案仍无进展时，应暂停继续试错，整理证据并请求人类协助，向人类报告：

1. 当前现象；
2. 已验证正常的部分；
3. 已排除的原因；
4. 最怀疑的 2～3 个原因；
5. 希望人类执行或确认的具体命令/环境信息。

环境级问题优先请求环境级验证，不要连续数小时修改应用代码。

调试过程中不得通过降低既定安全边界来“临时解决”问题，例如：
- 暴露 Docker Remote API
- 将 Docker socket 挂入 Workspace
- 使用 --privileged
- 关闭 Authorization
- 将 pi-web 裸端口暴露给用户
- 使用 host network 绕过网络问题

如确需临时诊断，必须明确标记为 DEBUG ONLY，且不得作为最终实现提交。
