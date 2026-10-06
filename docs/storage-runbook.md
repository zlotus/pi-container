# Workspace Storage Runbook

Phase 15（`specs.md` 第 64 节 Phase 15）的运维说明：每个 Workspace 的可写数据有硬上限，容器根文件系统只读，
单个 Workspace 写满只影响它自己。配额无法确认生效时 fail-closed：Worker 不启动 Workspace、关闭 Gateway、
停止正在运行的 Workspace（数据保留）。平台不做备份（决策 D5），备份对象仍是 `WORKER_MANAGED_ROOT` 与 PostgreSQL。

## 1. 组成

| 项 | 说明 |
|---|---|
| 配额文件系统 | `WORKER_MANAGED_ROOT` 必须是**单独挂载的 XFS**，挂载选项含 `prjquota`。v1.0 只支持 XFS |
| data project | `workspace/`（→ `/workspace`）、`home/`（→ `/home/agent`）、`tmp/`（→ `/tmp`）共用一个上限，默认 20 GiB / 200 万 inode；上限由 Control Plane 决定，管理员可按 Workspace 调整 |
| pi project | `pi/`（→ `/agent/pi`）单独 2 GiB / 20 万 inode。`/workspace` 写满时 Pi Session 仍能保存 |
| project ID | 每个 Worker 从 `WORKER_QUOTA_PROJECT_ID_MIN`（默认 1000000）起分配；第一个 ID 留给能力探针（`${WORKER_MANAGED_ROOT}/quota-probe`）；每个 Workspace 的 ID 记在 `workspaces/<id>/metadata/managed.json` 的 `quota` 字段 |
| 容器 | 根文件系统只读；可写位置只有上面四个 bind 挂载与 tmpfs `/run`（16 MiB）、`/run/lock`（1 MiB）、`/var/tmp`（256 MiB，计入内存上限）、`/dev/shm`（64 MiB） |
| ulimit 与日志 | `nofile` 65536、`core` 0（不产生 core 文件）；容器日志 `json-file` 10 MiB × 3 |
| `/tmp` | 每次由 Worker 启动容器前清空；Docker 在宿主机重启后自动拉起时不清空 |
| home | 持久化（容器重建后仍在），首次创建时从镜像的 `/etc/skel` 复制 `.bashrc`、`.profile`（在无网络、只读根的沙箱容器中完成，不覆盖已有文件） |

只读根带来的变化：`rustup` 不能安装新的组件或 target，系统包不能安装（agent 本来就不是 root）。需要新工具
时收集需求、更新 Runtime 镜像（Phase 18 的镜像升级）。`cargo` 的 `CARGO_HOME` 设为 `/home/agent/.cargo`，
`pip --user`、`uv`、npm/pnpm 缓存等都在 home 中，计入配额。

所有 Workspace 的上限之和可以超过磁盘容量（不预留空间）。Admin“Worker”页显示可用空间与“已分配上限”，
Phase 17 再提供告警。

## 2. 权限

设置配额上限需要 `CAP_SYS_ADMIN`（读取状态、`statfs` 用量不需要）。Worker 以固定参数调用 `xfs_quota` 与
`lsattr`，不经 shell；路径只能是 Worker 自己构造的受管路径（`WORKER_MANAGED_ROOT` 因此只允许字母、数字、
`.`、`_`、`-`、`/`）。

- 生产（Phase 19 的 systemd unit）：`AmbientCapabilities=CAP_NET_ADMIN CAP_SYS_ADMIN`，
  `CapabilityBoundingSet=CAP_NET_ADMIN CAP_SYS_ADMIN`。若 Worker 的运行用户与 `WORKSPACE_UID` 不同，还需要
  `CAP_FOWNER`（给 Workspace 用户的文件打 project 标记）。
- 开发：`tools/dev/run-worker-privileged.sh <worker env 文件>`（原 `run-worker-with-egress.sh`），以当前用户
  运行 Worker，只附加 `CAP_NET_ADMIN` 与 `CAP_SYS_ADMIN`。

没有 `CAP_SYS_ADMIN`、`WORKER_MANAGED_ROOT` 不是挂载点、不是 XFS、没有 `prjquota` 或只有记账（`pqnoenforce`）
时，Worker 仍然注册和上报，但“磁盘配额”为未生效，不会被调度、不会启动任何 Workspace。没有关闭配额的开关。

## 3. 生产环境：独立磁盘、分区或 LV

```bash
sudo apt-get install -y xfsprogs
sudo mkfs.xfs /dev/<设备>                       # 例如 /dev/vg0/agent-runtime
sudo mkdir -p /var/lib/agent-runtime
# /etc/fstab
UUID=<blkid 给出的 UUID>  /var/lib/agent-runtime  xfs  defaults,prjquota,x-systemd.before=docker.service  0  2
sudo systemctl daemon-reload && sudo mount /var/lib/agent-runtime
sudo chown <worker 用户>:<worker 组> /var/lib/agent-runtime && sudo chmod 0755 /var/lib/agent-runtime
```

挂载必须早于 Docker 与 `agent-runtime-egress.service`（它从这里读取出口规则快照；它排在 `local-fs.target`
之后）。容器使用 `Mounts` 绑定：如果配额文件系统没挂上，容器会**启动失败**，而不是在根分区上带着空目录启动。

## 4. 开发设备（Q8B）：根分区上的 loop 镜像

nvme 已全部分给根分区，因此用稀疏镜像文件承载 XFS。只用本机 nvme，不要使用 `/mnt` 下的 NTFS 硬盘。
镜像是稀疏的：写多少占多少，上限为镜像大小；在 XFS 中删除文件后，`fstrim` 会把空间还给根分区。

需要停机的步骤（约 10 分钟；以下命令需要 sudo）：

```bash
# 0. 在 Portal 停止全部 Workspace，然后停止 Worker（Ctrl-C）。Control Plane 可以保持运行。
sudo apt-get install -y xfsprogs

# 1. 把现有数据移开，建立空挂载点
sudo mv /var/lib/agent-runtime /var/lib/agent-runtime.pre-xfs
sudo mkdir /var/lib/agent-runtime

# 2. 创建 300G 稀疏镜像并格式化
sudo truncate -s 300G /var/lib/agent-runtime.xfs
sudo mkfs.xfs -q /var/lib/agent-runtime.xfs

# 3. 开机自动挂载（loop + prjquota，早于 Docker）
echo '/var/lib/agent-runtime.xfs /var/lib/agent-runtime xfs loop,prjquota,discard,nofail,x-systemd.before=docker.service 0 0' \
  | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount /var/lib/agent-runtime

# 4. 拷回数据（保留属主、权限、时间），根目录交给 Worker 用户
sudo cp -a /var/lib/agent-runtime.pre-xfs/. /var/lib/agent-runtime/
sudo chown radxa:radxa /var/lib/agent-runtime && sudo chmod 0755 /var/lib/agent-runtime

# 5. 确认
findmnt -T /var/lib/agent-runtime                       # FSTYPE xfs，OPTIONS 含 prjquota
sudo xfs_quota -x -c 'state -p' /var/lib/agent-runtime  # Accounting: ON / Enforcement: ON
ls /var/lib/agent-runtime                               # egress  workspaces
```

然后以 `tools/dev/run-worker-privileged.sh .data/worker-a.env` 启动 Worker；Admin“Worker”页的“磁盘配额”
应为“已生效”。确认全部 Workspace 正常后再删除 `/var/lib/agent-runtime.pre-xfs`。

扩容（在线）：`sudo truncate -s 500G /var/lib/agent-runtime.xfs && sudo losetup -c <loop 设备> && sudo xfs_growfs /var/lib/agent-runtime`。

## 5. 升级：Phase 15 之前创建的 Workspace

旧容器根文件系统可写，home 只存在于容器可写层。Worker 不会自动迁移（`specs.md` 15.12 Q6，方案 B）：启动这类
Workspace 返回 `STORAGE_MIGRATION_REQUIRED`，Portal 提示需要管理员迁移；仍在运行的旧容器会在 reconciliation
时被停止（数据保留）。

迁移前提醒用户：旧容器 `/tmp` 与其他可写层位置（如 `/usr/local/rustup` 中自装的组件）的内容**不会保留**；
需要的请先移到 `/workspace`。

对每个旧 Workspace（必须已停止），在 Worker 宿主机上以 Worker 用户执行：

```bash
WORKER_ID=worker-a tools/dev/migrate-legacy-workspace.sh <workspace-id>
```

脚本只处理带本 Worker managed label 的旧格式容器；把 `/home/agent` 复制到 `workspaces/<id>/home/`（目标
已存在且非空时拒绝），复制成功后才删除旧容器（不动网络和持久目录）。之后在 Portal 正常启动：Worker 为
现有目录打上 project 标记（home 计入配额）并按新配置创建容器。

## 6. 日常运维

```bash
# 全部 project 的用量与上限（ID 与 Workspace 的对应见各自 metadata/managed.json）
sudo xfs_quota -x -c 'report -p -b -i -h' /var/lib/agent-runtime
# 某个目录的 project 标记（P = 新文件继承）
lsattr -pd /var/lib/agent-runtime/workspaces/<id>/workspace
# 容器内用户看到的是配额而不是整块盘
docker exec agent-runtime-<id> df -h /workspace /agent/pi
```

- Workspace 写满：容器内写入报 “No space left on device”（XFS project quota 用 `ENOSPC`，不是
  “Disk quota exceeded”），`df -h /workspace` 显示 100%。用户在 Terminal 删除文件即可恢复；或管理员在“全部 Workspace”页调高上限（立即生效，不需要
  重启）。上限调到低于当前用量时，写入会立即失败。
- Portal 显示的用量由 Worker 每 60 秒采样一次，可能比 `df` 晚约一分钟。
- inotify：实例数与监视数按宿主机 UID 计数，所有 Workspace 共用 UID 1000，本 Phase 不隔离。建议在 Worker
  宿主机上调高：

  ```bash
  echo -e 'fs.inotify.max_user_instances=8192\nfs.inotify.max_user_watches=1048576' \
    | sudo tee /etc/sysctl.d/60-agent-runtime-inotify.conf && sudo sysctl --system
  ```

## 7. 排障

| 现象 | 检查 |
|---|---|
| “磁盘配额”未生效 | Worker 日志 `disk quotas are not enforced` 的 `reason`；`findmnt -T $WORKER_MANAGED_ROOT`；`sudo xfs_quota -x -c 'state -p' $WORKER_MANAGED_ROOT`；Worker 进程是否带 `CAP_SYS_ADMIN`（`grep Cap /proc/<pid>/status`） |
| 启动报 `STORAGE_QUOTA_APPLY_FAILED` | Worker 日志；`lsattr -pd` 四个目录；`xfs_quota report` 中对应 project 的上限 |
| 启动报 `STORAGE_MIGRATION_REQUIRED` | 按第 5 节迁移 |
| 宿主机重启后 Workspace 不在 | `findmnt` 是否已挂载；`docker inspect` 的错误应为 bind 源不存在（预期的 fail-closed） |

失败时请收集：Worker 与 Control Plane 日志（按 request ID）、`findmnt -T /var/lib/agent-runtime`、
`sudo xfs_quota -x -c 'state -p' -c 'report -p -b -i' /var/lib/agent-runtime`、`docker inspect <容器>` 的
`HostConfig`。

## 8. 真实内核测试

`pnpm test:quota` 在 `TEST_XFS_ROOT` 指向的 `prjquota` XFS 挂载上验证：超额写入失败（XFS project quota 报 `ENOSPC`）、Pi project 独立、
inode 上限、继承、跨 project 的 rename/硬链接被拒、符号链接不被跟随、即时调整与释放、非挂载点判定为未生效。
需要 root；CI 在 loop 设备上运行。本地可在开发 XFS 上建一个测试挂载：

```bash
truncate -s 512M /tmp/quota-test.xfs && mkfs.xfs -q /tmp/quota-test.xfs
sudo mkdir -p /mnt/agent-runtime-quota-test
sudo mount -o loop,prjquota /tmp/quota-test.xfs /mnt/agent-runtime-quota-test
# 以 root 直接运行 vitest（经 pnpm 会以 root 重新检查并改写 node_modules）
(cd apps/worker && sudo env "PATH=$PATH" TEST_XFS_ROOT=/mnt/agent-runtime-quota-test \
  ../../node_modules/.bin/vitest run src/storage/quota.xfs.test.ts)
sudo umount /mnt/agent-runtime-quota-test && rm /tmp/quota-test.xfs
```
