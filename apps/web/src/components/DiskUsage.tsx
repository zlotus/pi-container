import { diskUsageLevel, formatAbsoluteTime, formatBytes } from "../labels.js";
import type { WorkspaceDisk } from "../types.js";

/** `已用 / 上限` with a capacity bar; warning from 90 %, full at the limit (Phase 15.7). */
export function DiskUsage({ disk }: { disk: WorkspaceDisk }) {
  const level = diskUsageLevel(disk.usedBytes, disk.limitBytes);
  const percent =
    disk.usedBytes === null ? 0 : Math.min(100, Math.round((disk.usedBytes / disk.limitBytes) * 100));
  const title = [
    disk.sampledAt === null ? "尚未采样" : `采样于 ${formatAbsoluteTime(disk.sampledAt)}`,
    disk.piUsedBytes === null || disk.piLimitBytes === null
      ? null
      : `Pi 会话数据 ${formatBytes(disk.piUsedBytes)} / ${formatBytes(disk.piLimitBytes)}`,
  ]
    .filter((part) => part !== null)
    .join("；");
  return (
    <span className={`disk-usage disk-${level}`} title={title}>
      {disk.usedBytes === null ? "—" : formatBytes(disk.usedBytes)} / {formatBytes(disk.limitBytes)}
      <span className="capacity-track" aria-hidden="true">
        <i style={{ width: `${percent}%` }} />
      </span>
      {level === "full" ? <small role="status">磁盘已满：请删除文件或联系管理员</small> : null}
    </span>
  );
}
