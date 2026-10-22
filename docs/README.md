# 文档

文档分两套，按读者区分：

| 你是 | 从这里开始 |
|---|---|
| 部署、运维平台的人 | **[运维手册 `docs/ops/`](ops/README.md)**：带编号的章节，部署按 00→05 顺序读，之后按场景查 10～90。只做运维时只需要这一套 |
| 开发平台本身的人 | 仓库根目录 `README.md`（开发环境）、`AGENTS.md`（工程与安全规则）、`specs.md`（规范与各 Phase 验收），以及下面的开发资料 |

## 开发资料

运维手册在需要深入原理或排障时会链接到这里。

| 文档 | 内容 |
|---|---|
| [context.md](context.md) | 稳定的产品定位、边界和术语导航 |
| [progress.md](progress.md) | 当前 Phase、已实现基线、下一步和真实验证结果 |
| [v1-roadmap.md](v1-roadmap.md) | v0.13 之后到 v1.0 的差距、Phase 13～19 顺序与已确认决策 |
| [runtime-capability-matrix.md](runtime-capability-matrix.md) | AMD64 / ARM64 原生验证证据与边界 |
| [demo-runbook.md](demo-runbook.md) | 开发环境自动 E2E、主链演示与人工验收清单 |
| [authentication-runbook.md](authentication-runbook.md) | 认证审计、登录防护、Local Admin break-glass 与 IdP 故障 |
| [egress-runbook.md](egress-runbook.md) | Workspace 出口控制的原理、规则与排障 |
| [storage-runbook.md](storage-runbook.md) | XFS 配额、容器资源限制与排障 |
| [model-gateway-runbook.md](model-gateway-runbook.md) | 模型网关（LiteLLM）集成、模型目录、虚拟 key |
| [observability-runbook.md](observability-runbook.md) | 指标、告警规则与面板 |
| [lifecycle-runbook.md](lifecycle-runbook.md) | Runtime 镜像升级与回滚、Worker 吊销、空闲回收 |

`AGENTS.md` 是长期工程与安全规则，`specs.md` 是产品和分阶段验收规范；代码、测试和配置描述当前真实实现。若它们冲突，应先验证，
不以本目录覆盖规范事实。
