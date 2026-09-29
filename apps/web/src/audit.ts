import { useCallback, useEffect, useState } from "react";

import { api } from "./api.js";
import type { AuditEventDescription } from "./components/AuditEventRow.js";
import { formatAbsoluteTime } from "./labels.js";
import type { AuditEvent } from "./types.js";

export const AUDIT_PAGE_SIZE = 50;

export const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  workspace: "Workspace",
  worker: "Worker",
  auth: "登录与会话",
  user: "用户管理",
  identity: "登录方式绑定",
};

export interface AuditFilter {
  category: string;
  userId: string;
  workspaceId: string;
  workerId: string;
  /** Local calendar dates (YYYY-MM-DD); both ends are inclusive. */
  fromDate: string;
  toDate: string;
}

export const EMPTY_AUDIT_FILTER: AuditFilter = {
  category: "",
  userId: "",
  workspaceId: "",
  workerId: "",
  fromDate: "",
  toDate: "",
};

function localDayStart(date: string, offsetDays = 0): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offsetDays);
  return day.toISOString();
}

export function auditQueryString(
  filter: AuditFilter,
  before: string | null,
  limit: number = AUDIT_PAGE_SIZE,
): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before !== null) params.set("before", before);
  if (filter.category !== "") params.set("category", filter.category);
  if (filter.userId !== "") params.set("userId", filter.userId);
  if (filter.workspaceId !== "") params.set("workspaceId", filter.workspaceId);
  if (filter.workerId !== "") params.set("workerId", filter.workerId);
  const from = localDayStart(filter.fromDate);
  if (from !== null) params.set("from", from);
  // The API upper bound is exclusive, so an inclusive end date becomes the next local midnight.
  const to = localDayStart(filter.toDate, 1);
  if (to !== null) params.set("to", to);
  return params.toString();
}

export function useAuditEvents(filter: AuditFilter) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api<{ events: AuditEvent[] }>(`/api/audit-events?${auditQueryString(filter, null)}`)
      .then((result) => {
        if (!active) return;
        setEvents(result.events);
        setHasMore(result.events.length === AUDIT_PAGE_SIZE);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "无法载入事件");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filter, generation]);

  const loadMore = useCallback(async () => {
    const last = events.at(-1);
    if (last === undefined) return;
    setLoadingMore(true);
    try {
      const result = await api<{ events: AuditEvent[] }>(
        `/api/audit-events?${auditQueryString(filter, last.id)}`,
      );
      setEvents((current) => [...current, ...result.events]);
      setHasMore(result.events.length === AUDIT_PAGE_SIZE);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法载入更多事件");
    } finally {
      setLoadingMore(false);
    }
  }, [events, filter]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  return { events, loading, loadingMore, hasMore, error, loadMore, refresh };
}

function csvCell(value: string | null): string {
  let text = value ?? "";
  // Spreadsheet formula injection guard: event fields (e.g. User-Agent) are user-influenced.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function auditEventsCsv(
  events: readonly AuditEvent[],
  describe: (event: AuditEvent) => AuditEventDescription,
): string {
  const header = ["时间", "级别", "事件", "对象", "Worker", "详情", "事件类型", "事件 ID", "操作者 ID", "所有者 ID", "Workspace ID"];
  const rows = events.map((event) => {
    const description = describe(event);
    return [
      formatAbsoluteTime(event.createdAt),
      description.severityLabel,
      description.label,
      description.subject,
      event.workerId,
      description.detail,
      event.eventType,
      event.id,
      event.actorUserId,
      event.ownerUserId,
      event.workspaceId,
    ];
  });
  // BOM keeps Chinese text readable when the file is opened directly in Excel.
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function downloadTextFile(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
