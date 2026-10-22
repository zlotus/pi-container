import { Fragment, useCallback, useEffect, useState } from "react";

import { api } from "../api.js";
import { ConfirmDialog } from "../components/Modal.js";
import { ModelGatewayPanel } from "../components/ModelGatewayPanel.js";
import { RelativeTime } from "../components/RelativeTime.js";
import { formatBytes as formatSize, formatCores, runtimeLabel, workerStatusLabel } from "../labels.js";
import type { SessionResponse, Worker } from "../types.js";

const CAPABILITY_LABELS: Record<string, string> = {
  browser: "Browser",
  office: "Office",
  ffmpeg: "Media",
  python: "Python",
  node: "Node",
  rust: "Rust",
};

function formatBytes(value: number | null): string {
  if (value === null) return "—";
  return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GiB`;
}

/**
 * Host capacity, plus observed usage while the Worker reports it (specs.md Phase 17.7):
 * host CPU busy share, available memory and the Workspaces' combined CPU and memory.
 */
export function hostResourcesText(worker: Pick<Worker, "systemResources" | "usage">): {
  summary: string;
  detail: string | null;
} {
  const capacity = `${worker.systemResources.logicalCpuCount ?? "—"} vCPU · ${formatBytes(worker.systemResources.memoryBytes)}`;
  const usage = worker.usage;
  if (usage === undefined || usage === null) return { summary: capacity, detail: null };
  const cpu = usage.hostCpuUtilization === null ? "—" : `${Math.round(usage.hostCpuUtilization * 100)}%`;
  return {
    summary: `CPU ${cpu} · 可用内存 ${formatSize(usage.hostMemoryAvailableBytes)} / ${formatSize(usage.hostMemoryTotalBytes)}`,
    detail: `${capacity}；${usage.runningWorkspaces} 个运行中的 Workspace 合计 CPU ${formatCores(usage.workspaceCpuCores)} 核、内存 ${formatSize(usage.workspaceMemoryBytes)}；负载 ${usage.load1.toFixed(2)}`,
  };
}

function HostResources({ worker }: { worker: Worker }) {
  const text = hostResourcesText(worker);
  return (
    <span title={text.detail ?? "Worker 未上报实际用量"}>
      {text.summary}
      {text.detail === null ? null : <small>{text.detail}</small>}
    </span>
  );
}

/** The Worker's model relay state (Phase 16.4). */
export function modelRelayText(worker: Pick<Worker, "modelRelay">): string {
  if (!worker.modelRelay.enabled) return "未启用";
  return worker.modelRelay.listening ? `已监听端口 ${worker.modelRelay.port ?? "—"}` : "已配置但未监听，请查看 Worker 日志";
}

export function beginWorkerPolling(
  refresh: () => void,
  schedule: (callback: () => void, delay: number) => number,
  cancel: (timer: number) => void,
): () => void {
  const timer = schedule(refresh, 5_000);
  return () => cancel(timer);
}

export interface LifecyclePolicy {
  idle: { enabled: boolean; stopAfterHours: number | null; cpuThresholdCores: number | null };
  defaultRuntimeImage: string;
}

export interface ControlPlaneVersion {
  version: string;
  protocolVersion: number;
}

/**
 * A Worker's software version next to the Control Plane's (Phase 19.8). A different version
 * is expected only during an upgrade; the protocol version is what actually gates a Worker.
 */
export function workerVersionText(
  worker: Pick<Worker, "workerVersion">,
  controlPlane: ControlPlaneVersion | null,
): { text: string; differs: boolean } {
  if (worker.workerVersion === null) return { text: "版本未知", differs: false };
  const differs = controlPlane !== null && worker.workerVersion !== controlPlane.version;
  return { text: `版本 ${worker.workerVersion}`, differs };
}

/** The idle stop policy as one sentence for the page heading (Phase 18.8). */
export function idlePolicyText(policy: LifecyclePolicy): string {
  const idle = policy.idle;
  return idle.enabled
    ? `空闲回收：已启用，无连接、无访问且 CPU 低于 ${idle.cpuThresholdCores} 核持续 ${idle.stopAfterHours} 小时后停止（不删除数据）。`
    : "空闲回收：未启用。";
}

export function AdminWorkersPage({ session }: { session: SessionResponse }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [schedulingTarget, setSchedulingTarget] = useState<Worker | null>(null);
  const [schedulingPending, setSchedulingPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedWorkerId, setExpandedWorkerId] = useState<string | null>(null);
  const [defaultRuntimeImage, setDefaultRuntimeImage] = useState<string | null>(null);
  const [controlPlane, setControlPlane] = useState<ControlPlaneVersion | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecyclePolicy | null>(null);

  useEffect(() => {
    void api<LifecyclePolicy>("/api/admin/lifecycle").then(setLifecycle).catch(() => undefined);
  }, []);

  const refreshWorkers = useCallback(async () => {
    try {
      const result = await api<{
        workers: Worker[];
        defaultRuntimeImage?: string;
        controlPlane?: ControlPlaneVersion;
      }>("/api/admin/workers");
      setWorkers(result.workers);
      setDefaultRuntimeImage(result.defaultRuntimeImage ?? null);
      setControlPlane(result.controlPlane ?? null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法载入 Worker");
    } finally {
      setLoading(false);
    }
  }, []);

  async function changeScheduling(worker: Worker, schedulable: boolean) {
    setSchedulingPending(true);
    try {
      const result = await api<{ worker: Worker }>(`/api/admin/workers/${worker.id}`, {
        method: "PATCH",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ schedulable }),
      });
      setWorkers((current) =>
        current.map((candidate) => candidate.id === result.worker.id ? result.worker : candidate),
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法更新 Worker 调度状态");
    } finally {
      setSchedulingPending(false);
      setSchedulingTarget(null);
    }
  }

  useEffect(() => {
    void refreshWorkers();
    return beginWorkerPolling(
      () => void refreshWorkers(),
      (callback, delay) => window.setInterval(callback, delay),
      (timer) => window.clearInterval(timer),
    );
  }, [refreshWorkers]);

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Worker</h1>
          <p>
            Worker 状态、Workspace 容量与运行环境信息，每 5 秒自动更新。
            {controlPlane === null ? null : ` 平台版本 ${controlPlane.version}（Worker 协议 v${controlPlane.protocolVersion}）。`}
            {lifecycle === null ? null : ` ${idlePolicyText(lifecycle)}`}
          </p>
        </div>
        <button className="secondary" onClick={() => void refreshWorkers()}>刷新</button>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      <ModelGatewayPanel />
      <section className="worker-panel" aria-label="Worker 列表">
        {loading ? (
          <p className="muted">正在载入 Worker…</p>
        ) : workers.length === 0 ? (
          <p className="muted">尚未预注册 Worker。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Worker</th><th>状态</th><th>出口控制</th><th>磁盘配额</th><th>架构</th><th>Workspace 容量</th><th>主机资源</th><th>最后心跳</th><th>操作</th></tr>
              </thead>
              <tbody>
                {workers.map((worker) => (
                  <Fragment key={worker.id}>
                    <tr>
                      <td>
                        <strong>{worker.id}</strong>
                        <small>{worker.hostname ?? "尚未连接"}</small>
                        {(() => {
                          const version = workerVersionText(worker, controlPlane);
                          return (
                            <small title={version.differs ? "与 Control Plane 版本不同：升级尚未完成时属正常，完成后应一致" : undefined}>
                              {version.text}{version.differs ? "（与平台不同）" : null}
                            </small>
                          );
                        })()}
                      </td>
                      <td>
                        <span className="state-group">
                          <span className={`state worker-${worker.status.toLowerCase()}`}>{workerStatusLabel(worker.status)}</span>
                          {worker.schedulable ? null : <span className="state worker-paused" title="不再分配新的 Workspace，已有 Workspace 不受影响">暂停调度</span>}
                          {worker.defaultImageAvailable === false ? <span className="state worker-offline" title="该 Worker 未提供平台默认 Runtime，新 Workspace 不会分配到这里">缺少默认 Runtime</span> : null}
                        </span>
                      </td>
                      <td>
                        {worker.egress.enforced ? (
                          <span className="state worker-online" title={`已应用策略版本 ${worker.egress.revision ?? "基础规则"}`}>已生效</span>
                        ) : (
                          <span className="state worker-offline" title="该 Worker 不会启动任何 Workspace，直到出口规则生效">未生效</span>
                        )}
                      </td>
                      <td title={worker.storage.enforced ? "所有 Workspace 上限之和可以超过磁盘容量（不预留空间）" : "该 Worker 不会启动任何 Workspace，直到磁盘配额生效"}>
                        {worker.storage.enforced ? (
                          <span className="state worker-online">已生效</span>
                        ) : (
                          <span className="state worker-offline">未生效</span>
                        )}
                        <small>
                          {worker.storage.totalBytes === null
                            ? worker.storage.fsType ?? "尚未上报"
                            : `可用 ${formatSize(worker.storage.freeBytes)} / ${formatSize(worker.storage.totalBytes)} · 已分配上限 ${formatSize(worker.storage.allocatedLimitBytes)}`}
                        </small>
                      </td>
                      <td><strong>{worker.architecture ?? "—"}</strong></td>
                      <td title="当前已分配的 Workspace 数量和容量上限">
                        <strong>{worker.assignedWorkspaces}/{worker.maxWorkspaces ?? "—"}</strong>
                        <span className="capacity-track" aria-label="Workspace 容量使用情况"><i style={{ width: `${worker.maxWorkspaces === null || worker.maxWorkspaces === 0 ? 0 : Math.min(100, worker.assignedWorkspaces / worker.maxWorkspaces * 100)}%` }} /></span>
                      </td>
                      <td><HostResources worker={worker} /></td>
                      <td><RelativeTime value={worker.lastHeartbeatAt} /></td>
                      <td>
                        <span className="row-actions">
                          {worker.schedulable ? (
                            <button className="secondary compact-button" onClick={() => setSchedulingTarget(worker)}>暂停调度</button>
                          ) : (
                            <button className="secondary compact-button" disabled={schedulingPending} onClick={() => void changeScheduling(worker, true)}>恢复调度</button>
                          )}
                          <button className="secondary compact-button" aria-expanded={expandedWorkerId === worker.id} onClick={() => setExpandedWorkerId(expandedWorkerId === worker.id ? null : worker.id)}>{expandedWorkerId === worker.id ? "收起" : "详情"}</button>
                        </span>
                      </td>
                    </tr>
                    {expandedWorkerId === worker.id ? (
                      <tr className="metadata-row">
                        <td colSpan={9}>
                          <dl className="worker-details">
                            <div><dt>Runtime 镜像</dt><dd>{worker.runtimeImages.length === 0 ? "尚未上报" : (
                              <ul className="runtime-image-list">
                                {worker.runtimeImages.map((image) => (
                                  <li key={image.image} title={image.image}>
                                    <strong>{runtimeLabel(image)}</strong> · {image.workspaces} 个 Workspace
                                    {image.image === defaultRuntimeImage ? <small>（平台默认）</small> : null}
                                  </li>
                                ))}
                              </ul>
                            )}{worker.unofferedWorkspaces > 0 ? <small className="error">另有 {worker.unofferedWorkspaces} 个 Workspace 使用的镜像已不再提供，无法启动</small> : null}</dd></div>
                            <div><dt>Worker 上报的 Workspace</dt><dd>{worker.allocatedWorkspaces}</dd></div>
                            <div><dt>模型中继</dt><dd>{modelRelayText(worker)}</dd></div>
                            <div><dt>可用能力</dt><dd><span className="capability-list">{Object.entries(CAPABILITY_LABELS).map(([key, label]) => <span className={worker.capabilities[key] ? "capability pass" : "capability fail"} key={key}>{label}</span>)}</span></dd></div>
                          </dl>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ConfirmDialog
        open={schedulingTarget !== null}
        title="暂停 Worker 调度"
        confirmLabel="暂停调度"
        pending={schedulingPending}
        tone="primary"
        onConfirm={() => {
          if (schedulingTarget !== null) void changeScheduling(schedulingTarget, false);
        }}
        onCancel={() => setSchedulingTarget(null)}
      >
        <p>
          暂停后，新的 Workspace 不会再分配到 <strong>{schedulingTarget?.id}</strong>。
        </p>
        <p>
          已分配在该 Worker 上的 {schedulingTarget?.assignedWorkspaces ?? 0} 个 Workspace
          不受影响，可以照常启动、停止和打开。随时可以恢复调度。
        </p>
      </ConfirmDialog>
    </>
  );
}
