import { Fragment, useCallback, useEffect, useState } from "react";

import { api } from "../api.js";
import type { Worker } from "../types.js";

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

export function AdminWorkersPage() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedWorkerId, setExpandedWorkerId] = useState<string | null>(null);

  const refreshWorkers = useCallback(async () => {
    try {
      const result = await api<{ workers: Worker[] }>("/api/admin/workers");
      setWorkers(result.workers);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load Workers");
    } finally {
      setLoading(false);
    }
  }, []);

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
          <p className="eyebrow">ADMIN</p>
          <h1>Workers</h1>
          <p>查看 Worker 在线状态、架构与 authoritative assignment capacity。</p>
        </div>
        <button className="secondary" onClick={() => void refreshWorkers()}>刷新</button>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      <section className="worker-panel" aria-labelledby="workers-list-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">RUNTIME FLEET</p>
            <h2 id="workers-list-title">Worker 列表</h2>
          </div>
        </div>
        {loading ? (
          <p className="muted">正在载入 Worker…</p>
        ) : workers.length === 0 ? (
          <p className="muted">尚未预注册 Worker。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Worker</th><th>状态</th><th>架构</th><th>Workspace</th><th>主机资源</th><th>最后心跳</th><th>详情</th></tr>
              </thead>
              <tbody>
                {workers.map((worker) => (
                  <Fragment key={worker.id}>
                    <tr>
                      <td><strong>{worker.id}</strong><small>{worker.hostname ?? "尚未连接"}</small></td>
                      <td><span className={`state worker-${worker.status.toLowerCase()}`}>{worker.status}</span></td>
                      <td><strong>{worker.architecture ?? "—"}</strong></td>
                      <td title="调度以平台 authoritative assignment 为准">
                        <strong>{worker.assignedWorkspaces}/{worker.maxWorkspaces ?? "—"}</strong>
                        <span className="capacity-track" aria-label="authoritative assignment capacity"><i style={{ width: `${worker.maxWorkspaces === null || worker.maxWorkspaces === 0 ? 0 : Math.min(100, worker.assignedWorkspaces / worker.maxWorkspaces * 100)}%` }} /></span>
                      </td>
                      <td>{worker.systemResources.logicalCpuCount ?? "—"} vCPU · {formatBytes(worker.systemResources.memoryBytes)}</td>
                      <td>{worker.lastHeartbeatAt === null ? "—" : new Date(worker.lastHeartbeatAt).toLocaleString()}</td>
                      <td><button className="secondary compact-button" aria-expanded={expandedWorkerId === worker.id} onClick={() => setExpandedWorkerId(expandedWorkerId === worker.id ? null : worker.id)}>{expandedWorkerId === worker.id ? "收起" : "展开"}</button></td>
                    </tr>
                    {expandedWorkerId === worker.id ? (
                      <tr className="metadata-row">
                        <td colSpan={7}>
                          <dl className="worker-details">
                            <div><dt>Runtime version</dt><dd>{worker.runtimeVersion ?? "—"}</dd></div>
                            <div><dt>Runtime image</dt><dd>{worker.runtimeImage ?? "尚未上报"}</dd></div>
                            <div><dt>Heartbeat reported Runtime</dt><dd>{worker.allocatedWorkspaces}</dd></div>
                            <div><dt>实测能力</dt><dd><span className="capability-list">{Object.entries(CAPABILITY_LABELS).map(([key, label]) => <span className={worker.capabilities[key] ? "capability pass" : "capability fail"} key={key}>{label}</span>)}</span></dd></div>
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
    </>
  );
}
