# 运维手册

面向**部署和运维平台的人**：在企业内网部署、升级、备份、排障 Containerized Agent Runtime Platform。只做部署与运维时，读这一套就够了；
仓库根目录的 `README.md`、`specs.md` 与 `docs/` 下的其他文档是开发与设计资料，排查深层问题时才需要（各章会给出链接）。

适用版本：v1.0（发布包 `agent-runtime-<版本>-linux-<arch>.tar.gz`）。

## 怎么读

| 场景 | 按顺序读 |
|---|---|
| 第一次部署 | [00](00-overview.md) → [01](01-planning.md) → [02](02-tls-and-dns.md) → [03](03-control-plane-host.md) → [04](04-worker-host.md) → [05](05-first-run.md) |
| 日常管理（用户、Worker、镜像、配额、出口、模型、监控） | [10](10-operations.md) |
| 升级平台 / 回滚 | [20](20-upgrade.md) |
| 备份与恢复 | [21](21-backup-restore.md) |
| 纯内网（无互联网）环境 | [22](22-offline-deployment.md)（介质准备）+ 01～05 |
| 自己构建发布包与 Runtime 镜像 | [23](23-build-from-source.md) |
| 下线一台主机 | [24](24-uninstall.md) |
| 出问题了 | [30](30-troubleshooting.md) |
| 安全边界、复查清单、漏洞扫描 | [31](31-security.md) |
| 查某个配置项、命令、端口、文件 | [90](90-reference.md) |

## 章节

| 编号 | 文档 | 内容 |
|---|---|---|
| 00 | [功能总览](00-overview.md) | 平台能做什么、每项功能的默认值与开关在哪里 |
| 01 | [规划](01-planning.md) | 架构与端口、主机要求、开发与生产的区别、发布物、接入已有反向代理 |
| 02 | [TLS 与 DNS](02-tls-and-dns.md) | 哪些链路加密、内部 CA、客户端信任、dnsmasq、Clash、AD DNS |
| 03 | [部署 Control Plane 主机](03-control-plane-host.md) | 发布包、配置、密钥、PostgreSQL、LiteLLM、nginx、systemd |
| 04 | [部署 Worker 主机](04-worker-host.md) | XFS、出口规则、Runtime 镜像、注册与启动、单机形态 |
| 05 | [首次启动与验收](05-first-run.md) | 管理员、第一个 Workspace、验收清单、开机顺序 |
| 10 | [日常运维](10-operations.md) | 用户与登录、Workspace、Worker、Runtime 镜像、出口、模型、空闲回收、监控、日志、审计 |
| 20 | [升级与回滚](20-upgrade.md) | 常规升级、协议与数据库迁移、回滚、从 v0.13 升级 |
| 21 | [备份与恢复](21-backup-restore.md) | 备份对象、一致性、恢复语义 |
| 22 | [离线部署](22-offline-deployment.md) | 纯内网介质准备（AMD64，待实机验证） |
| 23 | [从源码构建](23-build-from-source.md) | 发布包与 Runtime 镜像（AMD64，待实机验证） |
| 24 | [卸载与清理](24-uninstall.md) | 删除一台主机上的平台 |
| 30 | [排障](30-troubleshooting.md) | 按现象查原因、要收集的信息 |
| 31 | [安全](31-security.md) | 安全边界、发布前复查清单、漏洞扫描结论、已知限制 |
| 90 | [参考](90-reference.md) | 全部配置项、运维命令、文件与端口、systemd unit |

## 约定

- 命令以有 sudo 权限的管理员在对应主机上执行；`/opt/agent-runtime/current` 是当前激活的发布，`/etc/agent-runtime` 是配置。
- 示例环境：Control Plane `portal.ar.internal`（用户入口 `192.168.1.124`，内部入口 `100.112.169.46`），Worker `worker-c`
  （`100.115.94.58`）。替换为你的名字与地址。
- 配置文件格式：每行 `KEY=value`，不加引号、不加行尾注释（systemd 与 Node 共同支持的写法）。
