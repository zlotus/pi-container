# 从源码构建（AMD64）

> **状态：未经真实 AMD64 设备验证**（`specs.md` 19.15 Q4，决策 D2）。CI 在 GitHub 的 AMD64 runner 上构建并冒烟测试同样的发布包，
> Runtime 镜像在 AMD64 上的原生构建与验证也由 CI（`runtime-toolchain.yml`）每周运行；本文的手工步骤在负责人取得 AMD64 主机实测后
> 去掉此标注。ARM64 的步骤完全相同，只是产物名中的架构不同。

不依赖 CI，在一台联网的 x86_64 主机上构建平台发布包与 Runtime 镜像归档，供 [运维手册](README.md) 或
[22 离线部署](22-offline-运维手册) 使用。**不要交叉构建**（例如在 ARM64 上用 QEMU 构建 AMD64）：发布包中的 Node、Runtime
镜像中的 Chromium 等都必须在目标架构上原生构建并验证。

## 1. 构建主机

| 项 | 要求 |
|---|---|
| 系统 | Ubuntu 22.04 或 24.04（x86_64），可访问 GitHub、npm、nodejs.org、Debian 与 Docker Hub 镜像源 |
| 软件 | `git`、`curl`、`jq`、`zstd`、`openssl`、Docker Engine 24+（含 buildx） |
| Node | 24.22.0（与发布包相同的版本；`nvm install 24.22.0`），`corepack enable` 后 pnpm 由仓库的 `packageManager` 固定为 11.24.0 |
| 磁盘 | 约 30 GB 空闲（Runtime 镜像构建缓存） |

## 2. 平台发布包

```bash
git clone https://github.com/zlotus/pi-container.git && cd pi-container
git checkout v1.0.0                       # 或要构建的 tag
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test  # 可选，与 CI 的质量门相同
pnpm release:build                        # 输出 dist/release/agent-runtime-<版本>-linux-amd64.tar.gz 与 SHA256SUMS-<版本>-amd64
```

`release:build` 只在工作区干净时运行（防止把未提交的改动打进发布包），版本取当前 commit 上的 tag（`v1.0.0` → `1.0.0`），没有 tag 时为
`0.0.0-<commit>`。它会从 nodejs.org 下载 `node-v24.22.0-linux-x64.tar.xz` 并按脚本中 pin 的 SHA-256 校验，校验失败即中止。

冒烟检查（与 `release.yml` 相同的要点）：

```bash
cd dist/release && sha256sum --check SHA256SUMS-*-amd64
mkdir -p /tmp/ar && tar -xzf agent-runtime-*-linux-amd64.tar.gz -C /tmp/ar
R=$(echo /tmp/ar/agent-runtime-*)
$R/bin/node --version                                   # v24.22.0
file $R/bin/node | grep -q x86-64 && echo arch-ok
$R/bin/agent-runtime-ctl version | jq '{version, architecture, protocolVersion}'
```

## 3. Runtime 镜像

```bash
# 在同一 checkout 中；tag 即 runtime version，已存在的 tag 永不重建（lifecycle-runbook 1.2）
deploy/production/scripts/build-runtime-image.sh 2026.10-pi1.1
# -> dist/runtime-images/agent-runtime_2026.10-pi1.1_linux-amd64.tar.zst (+ .sha256、.manifest.txt)
```

脚本依次：原生构建（Node、Rust、uv、Playwright 与 Chromium、Office 等，20～60 分钟，取决于网络）→ 在无网络、非 root、去掉全部 capability
的容器中运行 `verify-image.sh`（含真实启动 Chromium）→ 写构建清单（全部 Debian 包与 Node 包版本、基础镜像 digest）→ 导出归档并计算
SHA-256。任一步失败即中止，不产生归档。

**多架构说明**：同一个 tag（例如 `agent-runtime:2026.10-pi1.1`）在 ARM64 与 AMD64 上是两个不同的镜像、两个不同的 digest。每台 Worker
加载**自己架构**的归档，并在 `RUNTIME_IMAGES` 中写自己看到的 digest；`DEFAULT_RUNTIME_IMAGE` 只写名字，混合架构的 Worker 可以共用。

可选：在 AMD64 主机上运行 Worker 的真实 Docker 回归（需要 root 以便 chown 受管目录）：

```bash
sudo -E env "PATH=$PATH" TEST_DOCKER_RUNTIME=1 TEST_RUNTIME_IMAGE=agent-runtime:2026.10-pi1.1 pnpm --filter @agent-runtime/worker test
```

## 4. 产物清单

| 文件 | 用途 |
|---|---|
| `agent-runtime-<版本>-linux-amd64.tar.gz`、`SHA256SUMS-<版本>-amd64` | 每台主机安装（`release.sh install`） |
| `agent-runtime_<tag>_linux-amd64.tar.zst`、`.sha256` | 每台 AMD64 Worker 加载（`agent-runtime-image load`） |
| `agent-runtime_<tag>_linux-amd64.manifest.txt` | 构建清单，审计“镜像里到底是什么版本” |

AMD64 实测后请记录：主机型号与系统、`release:build` 与镜像构建是否成功、`verify-image.sh` 输出、按 运维手册 部署后的
`audit-host.sh` 结果，并更新 `docs/runtime-capability-matrix.md`。
