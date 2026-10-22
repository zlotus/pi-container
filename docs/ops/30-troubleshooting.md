# 30 排障

先看现象表；对不上时按第 3 节收集信息。网络、证书、DNS、代理类问题多数是环境问题，先确认环境再改配置。

## 1. 按现象

| 现象 | 最可能的原因 | 检查 |
|---|---|---|
| 浏览器打不开 `https://portal.<域>` | DNS 未解析、Clash fake-ip、防火墙 | 客户端 `dig portal.<域>`；`curl -v --resolve portal.<域>:443:<地址> https://portal.<域>/`；[02](02-tls-and-dns.md) 第 7 节 |
| 证书警告 | 客户端未信任根证书（Linux 上 Firefox 用自己的证书库） | [02](02-tls-and-dns.md) 第 4 节 |
| 登录后马上又要求登录 | `PORTAL_ORIGIN` 与浏览器地址不一致；`SESSION_COOKIE_SECURE=true` 但用 HTTP 访问 | `control-plane.env`；浏览器开发者工具中 Set-Cookie |
| “账户已锁定” | 连续失败触发登录防护 | `agent-runtime-ctl auth:unlock login <账户>` |
| Control Plane 起不来（`activating` 反复重启） | 配置校验失败、待执行 migration、数据库来自更新版本 | `journalctl -u agent-runtime-control-plane -n 50`；`agent-runtime-ctl db:status`；[20](20-upgrade.md) 第 4.3 节 |
| Worker 一直离线 | `CONTROL_PLANE_URL`、证书信任、`worker-allow.conf`、token；协议版本不同（日志 `protocol version … unsupported`） | `journalctl -u agent-runtime-worker -n 50` 中的 `control channel closed` / `error` |
| Worker 在线但“出口控制未生效” | 缺 `CAP_NET_ADMIN`、nftables 被别的服务清空（发行版 `nftables.service`） | `sudo nft list table inet agent_runtime`；[egress-runbook](../egress-runbook.md) 第 7 节 |
| Worker 在线但“磁盘配额未生效” | 受管根不是 XFS `prjquota`、缺 `CAP_SYS_ADMIN` | `findmnt -T /var/lib/agent-runtime`；[storage-runbook](../storage-runbook.md) 第 7 节 |
| 新建 Workspace 报“没有可用 Worker” | 全部 Worker 暂停调度、满额、离线、未生效，或不提供默认镜像 | Portal「Worker」；告警 `AgentRuntimeDefaultRuntimeImageMissing` |
| 启动报 `STORAGE_MIGRATION_REQUIRED` | v0.13 旧格式容器 | [20](20-upgrade.md) 第 5 节第 8 步 |
| 启动报 `RUNTIME_IMAGE_UNAVAILABLE` | Workspace 的镜像已从该 Worker 的 `RUNTIME_IMAGES` 移除，或 tag 被改指向别的内容 | `agent-runtime-image verify <镜像>`；恢复该项或把 Workspace 切到其他镜像 |
| 打开 Workspace 显示 `UPSTREAM_UNAVAILABLE` | Control Plane 访问 Worker Gateway 失败：地址、TLS 证书 SAN、`internal-ca.crt`、`WORKER_GATEWAY_TOKENS_JSON` | Control Plane 主机：`curl --cacert /etc/agent-runtime/tls/internal-ca.crt https://<Worker>:3100/`（应为 401） |
| 打开 Workspace 显示 `WORKSPACE_NOT_FOUND` / 404 | Host 不匹配 `WORKSPACE_BASE_URL`（代理未原样转发 Host） | [01](01-planning.md) 第 5 节 |
| Workspace 内访问内网服务失败 | 出口策略默认拒绝内网 | Portal「网络出口」添加白名单 |
| 平台模型不可用 / 401 | LiteLLM 未运行、上游 key 错误、预算用尽、key 已吊销、Worker 未配置中继 | Portal「Worker」模型网关面板；`docker logs ar-platform-litellm-1`；[model-gateway-runbook](../model-gateway-runbook.md) 第 5 节 |
| Workspace 写入报 “No space left on device” | 达到配额 | 用户删除文件或管理员调高上限 |
| Workspace 被自动停止 | 空闲回收 | 审计 `workspace.idle_stopped`；[10](10-operations.md) 第 3 节 |
| Workspace 为 `ERROR`，容器不存在 | Docker 数据丢失、恢复备份后 | 在 Portal 启动即重建（[21](21-backup-restore.md) 第 3.3 节） |
| 日志中 `worker recovery issue … MANAGED_ORPHAN` | 数据库比 Worker 数据旧（恢复备份后） | [21](21-backup-restore.md) 第 4 节 |
| 日志中 `UNKNOWN_RESOURCE` 反复出现 | 有名字以 `agent-runtime-` 开头、但不属于平台的容器或网络 | `docker ps -a --format '{{.Names}}' \| grep ^agent-runtime-`；改名其他项目 |
| 重启后 Workspace 不在 | 受管根未挂载（容器因 bind 源缺失而启动失败，属预期的 fail-closed） | `findmnt -T /var/lib/agent-runtime`；`/etc/fstab` |

## 2. 常用检查命令

```bash
sudo /opt/agent-runtime/current/deploy/scripts/audit-host.sh
sudo agent-runtime-ctl version; sudo agent-runtime-ctl db:status
curl -s http://127.0.0.1:3000/ready
sudo docker compose -p ar-platform -f /etc/agent-runtime/compose.yml ps
journalctl -u agent-runtime-control-plane --since -30min -o cat | jq -c 'select(.level >= 40)'
journalctl -u agent-runtime-worker --since -30min -o cat | jq -c 'select(.level >= 40)'
openssl s_client -connect <主机>:<端口> -servername <名字> </dev/null | openssl x509 -noout -subject -ext subjectAltName -enddate
```

## 3. 求助时收集

1. 现象、时间、受影响的用户/Workspace ID、浏览器开发者工具中失败请求的状态码与响应体（**不要**附 Cookie 值）。
2. `agent-runtime-ctl version`、`release.sh list`、`audit-host.sh` 输出（每台相关主机）。
3. `journalctl -u agent-runtime-control-plane --since <时间>` 与相关 Worker 的 `journalctl -u agent-runtime-worker --since <时间>`。
4. 相关 Workspace：Worker 主机上 `docker inspect agent-runtime-<id>`（`.State`、`.Image`）、`docker logs --tail 100 agent-runtime-<id>`、
   `sudo cat /var/lib/agent-runtime/workspaces/<id>/metadata/managed.json`。
5. Portal「Worker」与「全部 Workspace」截图。

日志与这些输出不含密钥；`/etc/agent-runtime` 下的 env 文件与 `metadata/model-key.json` 含密钥，不要附上。
