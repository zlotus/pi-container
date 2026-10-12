export interface User {
  id: string;
  email: string | null;
  username: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
}

export interface AdminUser extends User {
  source: "local" | "external";
  workspaceCount: number;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Data-project limit and the Worker's latest usage sample (null until sampled). */
export interface WorkspaceDisk {
  limitBytes: number;
  usedBytes: number | null;
  usedInodes: number | null;
  piUsedBytes: number | null;
  piLimitBytes: number | null;
  sampledAt: string | null;
}

/** Platform model access of a Workspace (specs.md Phase 16.8). */
export interface ModelAccess {
  status: "available" | "pending" | "unavailable" | "disabled";
  reason: string | null;
}

/** Observed container usage while RUNNING (specs.md Phase 17.7); null without a fresh sample. */
export interface WorkspaceUsage {
  cpuCores: number | null;
  cpuLimitCores: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  pids: number;
  pidsLimit: number;
  oomKills: number;
  sampledAt: string;
}

/** A Worker host's observed usage and the sum over its running Workspaces. */
export interface WorkerUsage {
  hostCpuUtilization: number | null;
  hostMemoryTotalBytes: number;
  hostMemoryAvailableBytes: number;
  load1: number;
  workspaceCpuCores: number;
  workspaceMemoryBytes: number;
  runningWorkspaces: number;
  sampledAt: string;
}

/** A Workspace's Runtime version and the changes it allows (specs.md Phase 18.8). */
export interface WorkspaceRuntime {
  image: string;
  runtimeVersion: string | null;
  piWebVersion: string | null;
  piVersion: string | null;
  previousImage: string | null;
  upgradeAvailable: boolean;
  rollbackAvailable: boolean;
  changeIncomplete: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  workerId: string | null;
  state: string;
  createdAt: string;
  disk: WorkspaceDisk;
  /** Absent on admin listings; "disabled" without a model gateway. */
  modelAccess?: ModelAccess;
  usage?: WorkspaceUsage | null;
  runtime?: WorkspaceRuntime | null;
  lastAccessAt?: string | null;
  lastStopReason?: "idle" | null;
}

export interface ModelUsage {
  spendUsd: number;
  maxBudgetUsd: number | null;
  budgetResetAt: string | null;
}

export type ModelUsageResponse =
  | { enabled: false }
  | { enabled: true; available: boolean; usage: ModelUsage | null };

export type ModelGatewayStatusResponse =
  | { enabled: false }
  | {
      enabled: true;
      reachable: boolean;
      providerId: string;
      catalog: Array<{ id: string; name: string | null; presentInGateway: boolean | null }>;
      pendingRevocations: number;
      oldestPendingAt: string | null;
      lastErrorCode: string | null;
      activeKeys: number;
    };

export interface AdminWorkspace extends Workspace {
  updatedAt: string;
  lastActivityAt: string;
  owner: { id: string; username: string | null; email: string | null };
  /** Images the Workspace's Worker offers, for the admin Runtime change (Phase 18.4). */
  offeredImages: Array<{ image: string; runtimeVersion: string }>;
}

export interface WorkerRuntimeImage {
  image: string;
  runtimeVersion: string;
  piWebVersion: string | null;
  piVersion: string | null;
  capabilities: Record<string, boolean>;
  /** Workspaces on this Worker using the image. */
  workspaces: number;
}

export interface Worker {
  id: string;
  hostname: string | null;
  architecture: "amd64" | "arm64" | null;
  status: "ONLINE" | "OFFLINE" | "DISABLED";
  /** false when an admin paused new placements on this Worker. */
  schedulable: boolean;
  runtimeImage: string | null;
  runtimeVersion: string | null;
  capabilities: Record<string, boolean>;
  /** Every Runtime image the Worker offers (Phase 18.4). */
  runtimeImages: WorkerRuntimeImage[];
  /** Workspaces on images the Worker no longer offers; they cannot start. */
  unofferedWorkspaces: number;
  /** Whether the Worker offers the platform default image; null when unknown. */
  defaultImageAvailable: boolean | null;
  maxWorkspaces: number | null;
  assignedWorkspaces: number;
  allocatedWorkspaces: number;
  systemResources: {
    logicalCpuCount: number | null;
    memoryBytes: number | null;
  };
  lastHeartbeatAt: string | null;
  /** Whether the Worker verifiably enforces the egress policy, and which revision. */
  egress: { enforced: boolean; revision: number | null; checkedAt: string | null };
  /** Whether the Worker's managed root enforces disk quotas, and its capacity. */
  storage: {
    enforced: boolean;
    fsType: string | null;
    totalBytes: number | null;
    freeBytes: number | null;
    checkedAt: string | null;
    allocatedLimitBytes: number;
  };
  /** The Worker's model relay (Phase 16.4). */
  modelRelay: { enabled: boolean; port: number | null; listening: boolean };
  usage?: WorkerUsage | null;
}

export interface AuthLock {
  id: string;
  scope: "login_ip" | "ip" | "login" | "sso_start";
  ipAddress: string | null;
  user: { id: string; email: string | null } | null;
  failures: number;
  lockedUntil: string;
}

export interface EgressRule {
  id: string;
  action: "allow" | "deny";
  network: string;
  protocol: "tcp" | "udp" | null;
  portMin: number | null;
  portMax: number | null;
  description: string;
  createdBy: string;
  createdAt: string;
}

export interface EgressPolicyResponse {
  revision: number;
  defaultDeny: string[];
  protected: string[];
  rules: EgressRule[];
  workers: Array<{
    id: string;
    enabled: boolean;
    enforced: boolean;
    revision: number | null;
    checkedAt: string | null;
  }>;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  actorUserId: string | null;
  ownerUserId: string | null;
  workspaceId: string | null;
  workerId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface SessionResponse {
  user: User;
  csrfToken: string;
}

export interface AuthMethodsResponse {
  oidc: { enabled: boolean; providerId: string | null };
  oauth2: { enabled: boolean; providerId: string | null };
}

export interface ExternalIdentity {
  id: string;
  userId: string;
  providerId: string;
  providerSubject: string;
  usernameSnapshot: string | null;
  emailSnapshot: string | null;
  displayNameSnapshot: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface WorkspaceOpenResponse {
  exchangeUrl: string;
  code: string;
}
