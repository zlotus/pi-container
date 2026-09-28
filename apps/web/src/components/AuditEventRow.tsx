import type { AuditEvent, User, Workspace } from "../types.js";

const AUDIT_LABELS: Record<string, string> = {
  "workspace.created": "Workspace 已创建",
  "workspace.scheduled": "Scheduler 已分配 Worker",
  "workspace.starting": "Runtime 正在启动",
  "workspace.running": "Runtime 已运行",
  "workspace.opened": "已打开 pi-web",
  "workspace.stopping": "Runtime 正在停止",
  "workspace.stopped": "Runtime 已停止",
  "workspace.deleting": "Workspace 正在删除",
  "workspace.deleted": "Workspace 已永久删除",
  "workspace.error": "Runtime 进入错误状态",
  "workspace.worker_offline": "Worker 已离线",
  "worker.registered": "Worker 已预注册",
  "worker.online": "Worker 已上线",
  "worker.offline": "Worker 已离线",
  "worker.disabled": "Worker 已禁用",
  "worker.runtime_reported": "Runtime 能力已上报",
  "identity.bound": "External Identity 已绑定",
  "identity.unbound": "External Identity 已解绑",
  "auth.login_succeeded": "登录成功",
  "auth.login_failed": "登录失败",
  "auth.logout": "已退出登录",
  "auth.session_revoked": "Session 已撤销",
  "user.created": "User 已创建",
  "user.enabled": "User 已启用",
  "user.disabled": "User 已禁用",
  "user.role_changed": "User role 已变更",
  "user.password_reset": "Local password 已重置",
};

function auditDetail(details: Record<string, unknown>): string | null {
  const fromState = details.fromState;
  const toState = details.toState;
  if (typeof fromState === "string" && typeof toState === "string") {
    return `${fromState} → ${toState}`;
  }
  const fromStatus = details.fromStatus;
  const toStatus = details.toStatus;
  if (typeof fromStatus === "string" && typeof toStatus === "string") {
    return `${fromStatus} → ${toStatus}`;
  }
  const fromRole = details.fromRole;
  const toRole = details.toRole;
  if (typeof fromRole === "string" && typeof toRole === "string") {
    return `${fromRole} → ${toRole}`;
  }
  const protocol = details.protocol;
  const category = details.category;
  if (typeof protocol === "string" && typeof category === "string") {
    return `${protocol} · ${category}`;
  }
  return typeof protocol === "string" ? protocol : null;
}

function auditUserName(
  userId: string,
  users: readonly Pick<User, "id" | "username" | "email">[],
): string {
  const user = users.find((candidate) => candidate.id === userId);
  return user?.username ?? user?.email ?? userId.slice(0, 8);
}

export function AuditEventRow({
  event,
  workspaces,
  adminUsers,
  isAdmin,
}: {
  event: AuditEvent;
  workspaces: readonly Pick<Workspace, "id" | "name">[];
  adminUsers: readonly Pick<User, "id" | "username" | "email">[];
  isAdmin: boolean;
}) {
  const workspace = workspaces.find((candidate) => candidate.id === event.workspaceId);
  const recordedName = event.details.name;
  const workspaceSubject = workspace?.name ??
    (typeof recordedName === "string" ? recordedName : null) ??
    (event.workspaceId === null ? "平台" : `${event.workspaceId.slice(0, 8)}…`);
  const isUserEvent = ["auth.", "user.", "identity."].some(
    (prefix) => event.eventType.startsWith(prefix),
  );
  const targetUserId = event.ownerUserId ?? event.actorUserId;
  const actor = event.actorUserId;
  const subject = isAdmin && isUserEvent && targetUserId !== null
    ? `${auditUserName(targetUserId, adminUsers)}${
      actor !== null && actor !== targetUserId
        ? ` · 操作者 ${auditUserName(actor, adminUsers)}`
        : ""
    }`
    : workspaceSubject;
  const detail = auditDetail(event.details);

  return (
    <li>
      <span className="audit-dot" aria-hidden="true" />
      <div>
        <strong>{AUDIT_LABELS[event.eventType] ?? event.eventType}</strong>
        <p>{subject}{event.workerId === null ? "" : ` · ${event.workerId}`}{detail === null ? "" : ` · ${detail}`}</p>
      </div>
      <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
    </li>
  );
}
