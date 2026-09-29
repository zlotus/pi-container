import { Fragment, useCallback, useEffect, useState } from "react";

import { api } from "../api.js";
import { ConfirmDialog } from "../components/Modal.js";
import { RelativeTime } from "../components/RelativeTime.js";
import { workerStatusLabel } from "../labels.js";
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

export function beginWorkerPolling(
  refresh: () => void,
  schedule: (callback: () => void, delay: number) => number,
  cancel: (timer: number) => void,
): () => void {
  const timer = schedule(refresh, 5_000);
  return () => cancel(timer);
}

export function AdminWorkersPage({ session }: { session: SessionResponse }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [schedulingTarget, setSchedulingTarget] = useState<Worker | null>(null);
  const [schedulingPending, setSchedulingPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedWorkerId, setExpandedWorkerId] = useState<string | null>(null);

  const refreshWorkers = useCallback(async () => {
    try {
      const result = await api<{ workers: Worker[] }>("/api/admin/workers");
      setWorkers(result.workers);
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
          <p>Worker 状态、Workspace 容量与运行环境信息，每 5 秒自动更新。</p>
        </div>
        <button className="secondary" onClick={() => void refreshWorkers()}>刷新</button>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      <section className="worker-panel" aria-label="Worker 列表">
        {loading ? (
          <p className="muted">正在载入 Worker…</p>
        ) : workers.length === 0 ? (
          <p className="muted">尚未预注册 Worker。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Worker</th><th>状态</th><th>架构</th><th>Workspace 容量</th><th>主机资源</th><th>最后心跳</th><th>操作</th></tr>
              </thead>
              <tbody>
                {workers.map((worker) => (
                  <Fragment key={worker.id}>
                    <tr>
                      <td><strong>{worker.id}</strong><small>{worker.hostname ?? "尚未连接"}</small></td>
                      <td>
                        <span className="state-group">
                          <span className={`state worker-${worker.status.toLowerCase()}`}>{workerStatusLabel(worker.status)}</span>
                          {worker.schedulable ? null : <span className="state worker-paused" title="不再分配新的 Workspace，已有 Workspace 不受影响">暂停调度</span>}
                        </span>
                      </td>
                      <td><strong>{worker.architecture ?? "—"}</strong></td>
                      <td title="当前已分配的 Workspace 数量和容量上限">
                        <strong>{worker.assignedWorkspaces}/{worker.maxWorkspaces ?? "—"}</strong>
                        <span className="capacity-track" aria-label="Workspace 容量使用情况"><i style={{ width: `${worker.maxWorkspaces === null || worker.maxWorkspaces === 0 ? 0 : Math.min(100, worker.assignedWorkspaces / worker.maxWorkspaces * 100)}%` }} /></span>
                      </td>
                      <td>{worker.systemResources.logicalCpuCount ?? "—"} vCPU · {formatBytes(worker.systemResources.memoryBytes)}</td>
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
                        <td colSpan={7}>
                          <dl className="worker-details">
                            <div><dt>运行环境版本</dt><dd>{worker.runtimeVersion ?? "—"}</dd></div>
                            <div><dt>运行环境镜像</dt><dd>{worker.runtimeImage ?? "尚未上报"}</dd></div>
                            <div><dt>Worker 上报的 Workspace</dt><dd>{worker.allocatedWorkspaces}</dd></div>
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
