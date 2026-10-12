import { formatAbsoluteTime, formatBytes, formatCores, resourceUsageLevel } from "../labels.js";
import type { WorkspaceUsage } from "../types.js";

function Bar({ used, limit }: { used: number | null; limit: number }) {
  const percent = used === null || limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <span className="capacity-track" aria-hidden="true">
      <i style={{ width: `${percent}%` }} />
    </span>
  );
}

/** Observed CPU and memory of a running Workspace (specs.md Phase 17.7). */
export function ResourceUsage({ usage }: { usage: WorkspaceUsage }) {
  const title = `采样于 ${formatAbsoluteTime(usage.sampledAt)}；进程 ${usage.pids} / ${usage.pidsLimit}`;
  return (
    <span className="resource-usage" title={title}>
      <span className={`disk-usage disk-${resourceUsageLevel(usage.cpuCores, usage.cpuLimitCores)}`}>
        CPU {formatCores(usage.cpuCores)} / {formatCores(usage.cpuLimitCores)} 核
        <Bar used={usage.cpuCores} limit={usage.cpuLimitCores} />
      </span>
      <span className={`disk-usage disk-${resourceUsageLevel(usage.memoryBytes, usage.memoryLimitBytes)}`}>
        内存 {formatBytes(usage.memoryBytes)} / {formatBytes(usage.memoryLimitBytes)}
        <Bar used={usage.memoryBytes} limit={usage.memoryLimitBytes} />
      </span>
      {usage.oomKills > 0 ? (
        <small role="status">内存曾超限，进程被系统终止 {usage.oomKills} 次</small>
      ) : null}
    </span>
  );
}
