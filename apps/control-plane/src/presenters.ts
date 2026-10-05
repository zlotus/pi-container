import type {
  AdminUserRecord,
  PlatformAuditEvent,
  UserIdentityRecord,
  UserRecord,
  WorkerPlacementRecord,
  WorkspaceRecord,
} from "@agent-runtime/database";

// API response shapes. Keep these as the only place records are converted for the Browser.
export function publicUser(user: Omit<UserRecord, "passwordHash">) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export function publicAdminUser(user: AdminUserRecord) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    status: user.status,
    source: user.source,
    workspaceCount: user.workspaceCount,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export function publicUserIdentity(identity: UserIdentityRecord) {
  return {
    id: identity.id,
    userId: identity.userId,
    providerId: identity.providerId,
    providerSubject: identity.providerSubject,
    usernameSnapshot: identity.usernameSnapshot,
    emailSnapshot: identity.emailSnapshot,
    displayNameSnapshot: identity.displayNameSnapshot,
    createdAt: identity.createdAt.toISOString(),
    lastLoginAt: identity.lastLoginAt?.toISOString() ?? null,
  };
}

export function publicWorkspace(workspace: WorkspaceRecord) {
  return {
    id: workspace.id,
    name: workspace.name,
    workerId: workspace.workerId,
    state: workspace.state,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
    lastActivityAt: workspace.lastActivityAt.toISOString(),
  };
}

export function publicAuditEvent(event: PlatformAuditEvent) {
  return {
    id: event.id,
    eventType: event.eventType,
    actorUserId: event.actorUserId,
    ownerUserId: event.ownerUserId,
    workspaceId: event.workspaceId,
    workerId: event.workerId,
    details: event.details,
    createdAt: event.createdAt.toISOString(),
  };
}

export function publicWorker(
  worker: WorkerPlacementRecord,
  currentTime: Date,
  offlineAfterMs: number,
) {
  const status = !worker.enabled
    ? "DISABLED"
    : worker.lastHeartbeatAt !== null &&
        currentTime.getTime() - worker.lastHeartbeatAt.getTime() < offlineAfterMs
      ? "ONLINE"
      : "OFFLINE";
  return {
    id: worker.id,
    hostname: worker.hostname,
    architecture: worker.architecture,
    status,
    enabled: worker.enabled,
    schedulable: worker.schedulable,
    runtimeImage: worker.runtimeImage,
    runtimeVersion: worker.runtimeVersion,
    capabilities: worker.capabilities,
    maxWorkspaces: worker.maxWorkspaces,
    assignedWorkspaces: worker.assignedWorkspaces,
    allocatedWorkspaces: worker.allocatedWorkspaces,
    systemResources: worker.systemResources,
    lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString() ?? null,
  };
}
