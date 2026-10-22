# 外部备份与恢复

`specs.md` 第 28 节、19.10，决策 D5：**平台不执行、不调度任何备份**。本文说明需要由虚拟化平台、操作系统或备份软件保护的数据、
一致性注意事项，以及恢复到“原 Worker 的原路径”之后平台怎样接管。步骤均于 2026-10-20 在两台 Worker 的部署上演练过。

## 1. 备份什么

| 对象 | 位置 | 方法 |
|---|---|---|
| 平台数据库 `agent_runtime` | Control Plane 主机 PostgreSQL（数据目录 `/var/lib/agent-runtime-postgres`） | `pg_dump -Fc`（运行中可做，库内一致）；或停 PostgreSQL 后对数据目录做快照 |
| 网关数据库 `litellm` | 同上 | 与平台库**紧接着**导出 |
| Worker 受管根 | 每台 Worker 的 `/var/lib/agent-runtime`（独立 XFS） | 块设备/LVM/虚拟机磁盘快照（先 `xfs_freeze -f`），或文件级备份（保留数值属主、权限、硬链接、xattr） |
| 配置与密钥 | 每台主机的 `/etc/agent-runtime/`（含内部 CA 私钥 `ca/ca.key`） | 单独备份并加密 |

**不需要备份**：`/opt/agent-runtime`（发布包可重新安装）、Docker 容器与网络（容器只读根，不含状态，启动时按配置重建）、Runtime 镜像
（保留镜像**归档**及其 `.sha256`，至少覆盖仍在使用的版本）。

**备份含敏感数据**：数据库中有口令与会话哈希、Audit；`litellm` 库中有虚拟 key 记录与用量；受管根中有用户文件与各 Workspace 的
`metadata/model-key.json`（虚拟 key 明文）。备份必须加密并限制访问。

## 2. 备份步骤（示例）

### 2.1 数据库（Control Plane 主机）

```bash
sudo install -d -m 0700 /var/backups/agent-runtime
for db in agent_runtime litellm; do
  sudo docker compose -p ar-platform -f /etc/agent-runtime/compose.yml exec -T postgres \
    sh -c "pg_dump -U \"\$POSTGRES_USER\" -Fc $db" | sudo sh -c "umask 077; cat > /var/backups/agent-runtime/$db.dump"
done
```

### 2.2 Worker 受管根（每台 Worker）

要求一致时先在 Portal 停止该 Worker 上的 Workspace（运行中的 Workspace 可能被拍到写了一半的文件；Pi 会话是追加写入的 JSONL，通常
可用）。文件级示例：

```bash
sudo install -d -m 0700 /var/backups/agent-runtime
sudo tar -C /var/lib --numeric-owner --xattrs --acls -cf - agent-runtime | zstd -q -T0 -o /var/backups/agent-runtime/managed-root.tar.zst
```

块级示例（LVM）：`sudo xfs_freeze -f /var/lib/agent-runtime && sudo lvcreate -s -n ar-snap -L 10G vg0/agent-runtime; sudo xfs_freeze -u /var/lib/agent-runtime`。
XFS project 配额标记只有块级快照会保留；文件级恢复后由 Worker 在 Workspace 下次启动前重新设置（3.3）。

## 3. 恢复（原 Worker、原路径）

“原 Worker”指同一个 `WORKER_ID`、凭据、`WORKER_MANAGED_ROOT` 与 Runtime 镜像；更换硬件时满足这些条件即可。**不支持**把一台 Worker 的
数据恢复到另一台 Worker（平台会把它识别为别的 Worker 的资源，只告警）。

### 3.1 Worker 受管根

```bash
sudo systemctl stop agent-runtime-worker
docker rm -f $(docker ps -aq --filter label=app=agent-runtime-platform) 2>/dev/null          # 旧容器（若还在）
docker network rm $(docker network ls -q --filter label=app=agent-runtime-platform) 2>/dev/null
sudo find /var/lib/agent-runtime -mindepth 1 -maxdepth 1 -exec rm -rf {} +
zstd -dc /var/backups/agent-runtime/managed-root.tar.zst | sudo tar -C /var/lib --numeric-owner --xattrs --acls -xpf -
```

### 3.2 数据库（Control Plane 主机）

```bash
sudo systemctl stop agent-runtime-control-plane
DC="sudo docker compose -p ar-platform -f /etc/agent-runtime/compose.yml"
$DC stop litellm
for db in agent_runtime litellm; do
  $DC exec -T postgres sh -c "dropdb -U \"\$POSTGRES_USER\" --force $db && createdb -U \"\$POSTGRES_USER\" -O $db $db"
  sudo cat /var/backups/agent-runtime/$db.dump | $DC exec -T postgres \
    sh -c "pg_restore -U \"\$POSTGRES_USER\" -d $db --no-owner --role=$db --exit-on-error"
done
$DC start litellm
```

### 3.3 启动与接管

先启动 Control Plane（`sudo systemctl start agent-runtime-control-plane`），再启动各 Worker。Worker 连接后做 reconcile：

| 情况 | 结果 | 操作 |
|---|---|---|
| 容器在、状态与期望一致 | 原状态（`RUNNING`/`STOPPED`） | 无 |
| 容器不在（Docker 数据丢失、换了硬件、按 3.1 清理过） | `ERROR` | 用户在 Portal 点“启动”：按当前配置重建容器，文件、home、Pi 会话为备份时的内容，配额重新设置 |

演练结果：清空容器与受管根后按 3.1、3.2 恢复，两个 Workspace 都进入 `ERROR`，启动后 `/workspace`、`/home/agent` 的内容为备份时刻，
`df /workspace` 显示 20 GiB 配额，平台模型的虚拟 key 继续有效。

## 4. 数据库与受管根来自不同时间点

两者分属不同主机，无法原子备份。恢复后可能出现：

| 情况 | 平台表现 | 处理 |
|---|---|---|
| Workspace 在数据库备份之后创建 | Worker 上的容器、网络、目录被报告为 `MANAGED_ORPHAN`（Control Plane 日志 `worker recovery issue`），**不会被删除** | 确认不需要后在该 Worker 上：`docker rm -f agent-runtime-<id>; docker network rm agent-runtime-<id>; sudo rm -rf /var/lib/agent-runtime/workspaces/<id>`；需要其数据时先拷出 `workspace/`、`home/` |
| Workspace 在数据库备份之后被删除 | 数据库中重新出现；受管根中已没有数据时为 `ERROR` | 用户或管理员在 Portal 删除 |
| Workspace 在备份后停止/启动过 | 期望状态与实际相反时为 `ERROR`（例：备份时停止、现在运行） | 在 Portal 停止或启动一次即恢复 |
| 模型 key | `model_keys` 与 `litellm` 库一起恢复，彼此一致；Worker 上更新的 key 文件只属于孤儿 Workspace | 无 |

演练（数据库恢复到较早时间点，受管根保持较新）：备份后新建的 Workspace 被报告为容器、目录、网络三项 `MANAGED_ORPHAN`；备份时停止、
之后启动过的 Workspace 为 `ERROR`；数据库中仍为运行、容器也仍在的 Workspace 恢复为 `RUNNING`。

## 5. 恢复演练建议

每季度在非生产环境（或一台测试 Worker）上按第 3 节恢复一次最近的备份，确认能打开 Workspace、看到预期的文件与会话。恢复演练本身
不需要平台停机，但被恢复的 Worker 上的 Workspace 在演练期间不可用。
