import postgres from "postgres";
import { z } from "zod";

const DatabaseUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "DATABASE_URL must use the postgres or postgresql scheme",
  );

export type DatabaseClient = ReturnType<typeof postgres>;

export function createDatabaseClient(databaseUrl: string): DatabaseClient {
  const parsedUrl = DatabaseUrlSchema.parse(databaseUrl);

  return postgres(parsedUrl, {
    max: 10,
    onnotice: () => undefined,
  });
}

export async function checkDatabase(client: DatabaseClient): Promise<void> {
  await client`select 1`;
}

export { migrateDatabase } from "./migrate.js";
export { createRepository, type Repository } from "./repository.js";
export {
  AUDIT_EVENT_CATEGORIES,
  type AuditEventCategory,
  type AuditEventFilter,
  type AuthenticationFailureCategory,
  type PlatformAuditEvent,
} from "./audit.js";
export {
  nextAuthThrottleState,
  type AuthLockRecord,
  type AuthThrottleHit,
  type AuthThrottleKey,
  type AuthThrottlePolicy,
  type AuthThrottleScope,
  type AuthThrottleState,
} from "./auth-throttle.js";
export {
  type CreateEgressRuleResult,
  type DeleteEgressRuleResult,
  type EgressAuditMetadata,
  type EgressPolicyRecord,
  type EgressPolicyValidator,
  type EgressRuleAction,
  type EgressRuleRecord,
} from "./egress.js";
export {
  type BindExternalIdentityResult,
  type CompleteExternalLoginResult,
  type UnbindExternalIdentityResult,
  type UserIdentityRecord,
} from "./identities.js";
export {
  type AuthenticatedSessionRecord,
  type AuthenticationAuditMetadata,
  type AuthenticationProtocol,
  type UserRecord,
  type UserRole,
  type UserStatus,
  type WorkspaceRecord,
} from "./records.js";
export { type WorkspaceRecoveryRecord } from "./recovery.js";
export {
  type ScheduleWorkspaceStartResult,
  type SetWorkerSchedulableResult,
  type WorkerPlacementRecord,
  type WorkerScheduleCandidate,
  type WorkerSchedulingAuditMetadata,
  type WorkerSelectionInput,
  type WorkerSelector,
  type WorkspaceSchedulingRequirements,
} from "./scheduling.js";
export {
  type StorageAuditMetadata,
  type UpdateWorkspaceDiskLimitResult,
} from "./storage.js";
export {
  type AdminUserRecord,
  type UpdateManagedUserResult,
} from "./users.js";
export {
  type RevokedWorkerAssignment,
  type WorkerDeleteResult,
  type WorkerDisableResult,
  type WorkerGatewayRoute,
  type WorkerIdentity,
  type WorkerRecord,
  type WorkerStatus,
} from "./workers.js";
export { type MetricsSnapshot } from "./metrics.js";
export { type AdminWorkspaceRecord } from "./workspaces.js";
export {
  type BeginModelKeyIssueResult,
  type ModelKeyIssue,
  type ModelKeyIssueReason,
  type ModelKeyOverview,
  type ModelKeyRevokeReason,
  type ModelKeyStatus,
  modelKeyRetryDelaySeconds,
  type PendingModelKeyRevocation,
  type WorkspaceModelKeyState,
} from "./model-keys.js";
