import type {
  AdminUserRecord,
  PlatformAuditEvent,
  UserIdentityRecord,
  UserRecord,
  WorkerPlacementRecord,
  WorkerRuntimeImage,
  WorkspaceRecord,
} from "@agent-runtime/database";

import type { WorkerUsageView, WorkspaceUsageView } from "./metrics/usage-registry.js";

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

/** Disabled when no model gateway is configured (specs.md Phase 16.8). */
export type PublicModelAccess =
  | { status: "available" | "pending" | "unavailable"; reason: string | null }
  | { status: "disabled"; reason: null };

const MODEL_ACCESS_DISABLED: PublicModelAccess = { status: "disabled", reason: null };

/** A Workspace's Runtime version and the changes it allows (specs.md Phase 18.4, 18.8). */
export interface PublicRuntime {
  image: string;
  runtimeVersion: string | null;
  piWebVersion: string | null;
  piVersion: string | null;
  previousImage: string | null;
  /** Stopped, on another image than the platform default, which its Worker offers. */
  upgradeAvailable: boolean;
  rollbackAvailable: boolean;
  /** A Runtime change was interrupted; retry or roll back. */
  changeIncomplete: boolean;
}

/** Whether a Workspace is left in the middle of a Runtime change. */
export function runtimeChangeIncomplete(workspace: WorkspaceRecord): boolean {
  return (
    workspace.state === "ERROR" &&
    workspace.previousRuntimeImage !== null &&
    workspace.runtimeChangedAt === null
  );
}

export function workspaceRuntime(
  workspace: WorkspaceRecord,
  /** The images its Worker offers; empty when it has none or no Worker yet. */
  offered: readonly WorkerRuntimeImage[],
  defaultRuntimeImage: string,
): PublicRuntime {
  const current = offered.find((image) => image.image === workspace.runtimeImage);
  const offers = (image: string | null) =>
    image !== null && offered.some((entry) => entry.image === image);
  const incomplete = runtimeChangeIncomplete(workspace);
  const changeable = workspace.state === "STOPPED" || incomplete;
  return {
    image: workspace.runtimeImage,
    runtimeVersion: current?.runtimeVersion ?? null,
    piWebVersion: current?.piWebVersion ?? null,
    piVersion: current?.piVersion ?? null,
    previousImage: workspace.previousRuntimeImage,
    upgradeAvailable:
      changeable &&
      offers(defaultRuntimeImage) &&
      (workspace.runtimeImage !== defaultRuntimeImage || incomplete),
    rollbackAvailable:
      changeable &&
      workspace.previousRuntimeImage !== workspace.runtimeImage &&
      offers(workspace.previousRuntimeImage),
    changeIncomplete: incomplete,
  };
}

export function publicWorkspace(
  workspace: WorkspaceRecord,
  modelAccess: PublicModelAccess = MODEL_ACCESS_DISABLED,
  /** Observed container usage (specs.md Phase 17.7); shown only while RUNNING. */
  usage: WorkspaceUsageView | null = null,
  runtime: PublicRuntime | null = null,
) {
  return {
    id: workspace.id,
    name: workspace.name,
    workerId: workspace.workerId,
    state: workspace.state,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
    lastActivityAt: workspace.lastActivityAt.toISOString(),
    disk: {
      limitBytes: workspace.disk.limitBytes,
      usedBytes: workspace.disk.usedBytes,
      usedInodes: workspace.disk.usedInodes,
      piUsedBytes: workspace.disk.piUsedBytes,
      piLimitBytes: workspace.disk.piLimitBytes,
      sampledAt: workspace.disk.sampledAt?.toISOString() ?? null,
    },
    modelAccess,
    usage: workspace.state === "RUNNING" ? usage : null,
    runtime,
    lastAccessAt: workspace.lastAccessAt?.toISOString() ?? null,
    lastStopReason: workspace.lastStopReason,
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
  usage: WorkerUsageView | null = null,
  defaultRuntimeImage: string | null = null,
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
    /** Software version from the last hello; differs from the Control Plane's during an upgrade. */
    workerVersion: worker.workerVersion,
    status,
    enabled: worker.enabled,
    schedulable: worker.schedulable,
    runtimeImage: worker.runtimeImage,
    runtimeVersion: worker.runtimeVersion,
    capabilities: worker.capabilities,
    runtimeImages: worker.runtimeImages.map((image) => ({
      image: image.image,
      runtimeVersion: image.runtimeVersion,
      piWebVersion: image.piWebVersion,
      piVersion: image.piVersion,
      capabilities: image.capabilities,
      workspaces: worker.workspacesByImage[image.image] ?? 0,
    })),
    /** Workspaces on images the Worker no longer offers (they cannot start). */
    unofferedWorkspaces: Object.entries(worker.workspacesByImage)
      .filter(([image]) => !worker.runtimeImages.some((entry) => entry.image === image))
      .reduce((sum, [, count]) => sum + count, 0),
    defaultImageAvailable:
      defaultRuntimeImage === null
        ? null
        : worker.runtimeImages.some((image) => image.image === defaultRuntimeImage),
    maxWorkspaces: worker.maxWorkspaces,
    assignedWorkspaces: worker.assignedWorkspaces,
    allocatedWorkspaces: worker.allocatedWorkspaces,
    systemResources: worker.systemResources,
    lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString() ?? null,
    egress: {
      enforced: worker.egress.enforced,
      revision: worker.egress.revision,
      checkedAt: worker.egress.checkedAt?.toISOString() ?? null,
    },
    storage: {
      enforced: worker.storage.enforced,
      fsType: worker.storage.fsType,
      totalBytes: worker.storage.totalBytes,
      freeBytes: worker.storage.freeBytes,
      checkedAt: worker.storage.checkedAt?.toISOString() ?? null,
      allocatedLimitBytes: worker.allocatedDiskLimitBytes,
    },
    modelRelay: worker.modelRelay,
    usage: status === "ONLINE" ? usage : null,
  };
}
