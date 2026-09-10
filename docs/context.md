# Project Context

## Purpose

本项目在 pi-web 与 Pi Coding Agent 之上构建企业私有环境可用的多用户、
多 Workspace、容器化 Agent Runtime 平台。核心对象是持久 Workspace，不是聊天会话。

## Source Of Truth

- [AGENTS.md](../AGENTS.md)：长期架构不变量、安全边界和开发规则。
- [specs.md](../specs.md)：产品设计、Phase scope 和验收标准。
- 代码、测试和配置：已经实现的真实行为。
- 当前 pinned upstream：pi-web/Pi 的协议、启动参数和状态路径事实。

## Stable Boundaries

- Platform Workspace 与 Pi Session 分离；一个 Workspace 承载一个 pi-web 和多个 Pi Session。
- 浏览器经认证的 Control Plane/Gateway 和 Worker Gateway 访问 Runtime。
- Control Plane 不解析或重写 Pi RPC；交互能力优先复用 pi-web。
- Workspace Container 不使用 privileged、host network 或 Docker socket，并以普通用户运行。
- Canonical Workspace 与 Pi state 位于 Worker 管理的持久目录。
- MVP 使用 sticky placement，不承诺热迁移、分布式文件系统或 VM 级隔离。

## Terminology

- **Workspace**：平台管理的持久文件系统、Container allocation 和 pi-web 实例。
- **Pi Session**：由 pi-web/Pi 管理的会话；不是平台 Workspace，也不独占 Container。
- **Control channel**：Worker 主动连接 Control Plane 的 versioned、typed 业务命令通道。
- **Data path**：浏览器流量经 Control Plane/Gateway、Worker Gateway 到 pi-web 的 HTTP/WebSocket 链路。
