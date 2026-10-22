# 24 卸载与清理

删除一台主机上的平台。**不可恢复**，先按 21 备份需要的数据。

## 1. 卸载与清理

```bash
# Worker 主机
sudo systemctl disable --now agent-runtime-worker agent-runtime-egress
docker rm -f $(docker ps -aq --filter label=app=agent-runtime-platform)
docker network rm $(docker network ls -q --filter label=app=agent-runtime-platform)
sudo nft delete table inet agent_runtime
sudo find /var/lib/agent-runtime -mindepth 1 -maxdepth 1 -exec rm -rf {} +      # Workspace 数据
# Control Plane 主机
sudo systemctl disable --now agent-runtime-control-plane agent-runtime-platform
sudo docker compose -p ar-platform -f /etc/agent-runtime/compose.yml down
sudo rm -rf /var/lib/agent-runtime-postgres                                   # 平台与网关数据库
# 两者
sudo rm -f /etc/systemd/system/agent-runtime-*.service && sudo systemctl daemon-reload
sudo rm -rf /opt/agent-runtime /etc/agent-runtime
sudo userdel agent-runtime 2>/dev/null; sudo userdel agent-runtime-cp 2>/dev/null
```

在 Control Plane 中删除一台已清理的 Worker：`sudo WORKER_ID=<id> agent-runtime-ctl worker:disable`，其 Workspace 删除后
`worker:delete`（[lifecycle-runbook.md](../lifecycle-runbook.md)）。
