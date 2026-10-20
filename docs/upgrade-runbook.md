# 升级与回滚

`specs.md` 19.9。适用于按 [deployment.md](deployment.md) 部署的生产形态。Runtime 镜像的升级与回滚是另一套流程，见
[lifecycle-runbook.md](lifecycle-runbook.md)；两者互不依赖。

## 1. 先看发布说明

每个发布包的 `release.json` 写明：

```bash
tar -xzf agent-runtime-<版本>-linux-arm64.tar.gz agent-runtime-<版本>/release.json -O | jq '{version, protocolVersion, migrations, defaultRuntimeImage}'
sudo agent-runtime-ctl version | jq '{version, protocolVersion, migrations}'      # 当前版本
```

| 对比项 | 影响 |
|---|---|
| `migrations` 多了新条目 | **必须先备份数据库**（第 2 步）；回滚需要恢复备份（第 4.2 节） |
| `protocolVersion` 不同 | Control Plane 与所有 Worker 必须一起升级；先升级的一方会拒绝另一方，Worker 在升级前显示离线（容器照常运行） |
| `defaultRuntimeImage` 不同 | 先让所有可调度 Worker 提供新镜像（lifecycle-runbook 1.3），再改 `DEFAULT_RUNTIME_IMAGE` |

## 2. 常规升级（版本 X → Y）

1. **安装**（所有主机，不激活）：
   ```bash
   sudo /opt/agent-runtime/current/deploy/scripts/release.sh install ~/release/agent-runtime-Y-linux-arm64.tar.gz
   ```
2. **备份**（Y 带新 migration 时必须）：按 [backup-runbook.md](backup-runbook.md) 第 2.1 节导出 `agent_runtime` 与 `litellm`。
3. **Control Plane 主机**：
   ```bash
   sudo agent-runtime-ctl --release Y db:status            # pending 列出 Y 要执行的 migration
   sudo systemctl stop agent-runtime-control-plane
   sudo agent-runtime-ctl --release Y db:migrate           # 只有 Y 带新 migration 时才有事可做；单事务，失败则整体不生效
   sudo /opt/agent-runtime/current/deploy/scripts/release.sh activate Y
   sudo systemctl start agent-runtime-control-plane
   sudo docker compose -p ar-platform -f /etc/agent-runtime/compose.yml restart nginx     # nginx 读取新版本的模板与 Portal
   curl -s http://127.0.0.1:3000/ready && journalctl -u agent-runtime-control-plane -n 20 -o cat
   ```
   若 Y 改了 `deploy/compose.yml` 或 systemd unit，按发布说明重新安装这些文件（`/etc` 中的是安装时的副本）。
4. **Worker 主机**（协议版本变化时紧接着逐台进行；否则可以滚动进行）：
   ```bash
   sudo /opt/agent-runtime/current/deploy/scripts/release.sh activate Y && sudo systemctl restart agent-runtime-worker
   ```
5. **验证**：Portal → Worker：全部在线、版本为 Y、出口与配额已生效；打开一个 Workspace，Prompt、Terminal、Files 正常；
   `sudo /opt/agent-runtime/current/deploy/scripts/audit-host.sh`。旧版本保留到确认无误（`release.sh list`、`release.sh prune X`）。

**对用户的影响**（2026-10-20 演练实测）：Workspace 容器在 Control Plane 与 Worker 重启期间**一直运行**（容器启动时间不变）；
Control Plane 停止 0.1 秒、重新就绪约 1 秒，期间浏览器到 Workspace 的连接中断，刷新即可（Pi 会话由 pi-web 恢复）；Worker
重启期间该 Worker 的 Workspace 短暂显示离线，reconcile 后恢复原状态。

## 3. 只升级 Worker 或只换配置

- 只改 `worker.env` 或证书：`sudo systemctl restart agent-runtime-worker`。
- 只改 `control-plane.env` / `control-plane.secrets.env`：`sudo systemctl restart agent-runtime-control-plane`（所有 Worker 自动重连，
  并重新下发出口规则）。
- 只改 `nginx.env`、证书或 `worker-allow.conf`：`sudo docker compose -p ar-platform -f /etc/agent-runtime/compose.yml restart nginx`
  （`worker-allow.conf` 也可 `exec nginx nginx -s reload`）。
- 只改 `model-gateway/config.yaml`：`sudo docker compose -p ar-platform -f /etc/agent-runtime/compose.yml restart litellm`。

## 4. 回滚

### 4.1 Y 没有新 migration

```bash
sudo /opt/agent-runtime/current/deploy/scripts/release.sh activate X       # 每台主机
sudo systemctl restart agent-runtime-control-plane      # Control Plane 主机，再重启 nginx（同 2.3）
sudo systemctl restart agent-runtime-worker             # 每台 Worker
```

协议版本变化时两边终态一致即可，顺序不影响数据。

### 4.2 Y 有新 migration

数据库没有向下迁移。X 的程序在被 Y 迁移过的数据库上**拒绝启动**（日志 `DatabaseNewerThanBuildError`，`agent-runtime-ctl db:status`
以退出码 3 报告 `unknown`），所以必须恢复第 2 步的备份：

```bash
sudo systemctl stop agent-runtime-control-plane
# 恢复 agent_runtime 与 litellm：backup-runbook.md 第 3.2 节
sudo /opt/agent-runtime/current/deploy/scripts/release.sh activate X
sudo systemctl start agent-runtime-control-plane       # 然后 nginx 与各 Worker 同 4.1
```

**代价**：升级之后在平台里产生的变化随数据库一起回到备份时刻——新用户、新 Workspace、Audit、配置变化都会丢失。Worker 上的数据
不回退，因此会出现 [backup-runbook.md](backup-runbook.md) 第 4 节描述的不一致（升级后新建的 Workspace 成为孤儿、升级后删除的
重新出现）。回滚应在升级后的验证阶段尽快决定。

### 4.3 拒绝启动时 systemd 的表现

数据库不匹配或有待执行 migration 时，Control Plane 每 5 秒重启一次并立即退出（`systemctl status` 为 `activating`），不会在不匹配的
数据库上运行。修好原因后 `sudo systemctl reset-failed agent-runtime-control-plane && sudo systemctl start agent-runtime-control-plane`。

## 5. 失败时收集

`agent-runtime-ctl version` 与 `db:status`、`release.sh list`、`journalctl -u agent-runtime-control-plane -n 200`、每台 Worker 的
`journalctl -u agent-runtime-worker -n 200`、Portal → Worker 截图、`audit-host.sh` 输出。
