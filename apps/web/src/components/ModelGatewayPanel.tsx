import { useEffect, useState } from "react";

import { api } from "../api.js";
import { formatAbsoluteTime } from "../labels.js";
import type { ModelGatewayStatusResponse } from "../types.js";

/** Model gateway health for administrators (specs.md Phase 16.8); hidden when disabled. */
export function ModelGatewayPanel() {
  const [status, setStatus] = useState<ModelGatewayStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api<ModelGatewayStatusResponse>("/api/admin/model-gateway")
      .then((result) => {
        if (active) setStatus(result);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "无法载入模型网关状态");
      });
    return () => {
      active = false;
    };
  }, []);

  if (error !== null) return <p className="error banner" role="alert">{error}</p>;
  if (status === null || !status.enabled) return null;
  const missing = status.catalog.filter((model) => model.presentInGateway === false);
  return (
    <section className="worker-panel model-gateway-panel" aria-label="模型网关">
      <h2>模型网关</h2>
      <dl className="worker-details">
        <div>
          <dt>网关</dt>
          <dd>
            {status.reachable ? (
              <span className="state worker-online">可达</span>
            ) : (
              <span className="state worker-offline">不可达</span>
            )}
          </dd>
        </div>
        <div>
          <dt>平台模型（{status.providerId}）</dt>
          <dd>
            {status.catalog.map((model) => model.name ?? model.id).join("、")}
            {missing.length === 0 ? null : (
              <small className="model-access-warn">
                网关中缺少：{missing.map((model) => model.id).join("、")}
              </small>
            )}
          </dd>
        </div>
        <div><dt>有效凭据</dt><dd>{status.activeKeys}</dd></div>
        <div>
          <dt>待吊销</dt>
          <dd>
            {status.pendingRevocations === 0 ? (
              "0"
            ) : (
              <span className="model-access-warn" title="网关确认删除前不会视为已吊销，系统会自动重试">
                {status.pendingRevocations}
                {status.oldestPendingAt === null ? null : `（最早 ${formatAbsoluteTime(status.oldestPendingAt)}）`}
                {status.lastErrorCode === null ? null : ` · ${status.lastErrorCode}`}
              </span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
