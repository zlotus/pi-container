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
export {
  createPhase1Repository,
  type AuthenticatedSessionRecord,
  type Phase1Repository,
  type UserRecord,
  type UserRole,
  type UserStatus,
  type WorkspaceRecord,
} from "./phase1.js";
export {
  createPhase2Repository,
  type Phase2Repository,
  type WorkerIdentity,
  type WorkerRecord,
  type WorkerStatus,
} from "./phase2.js";
export {
  createPhase3Repository,
  type Phase3Repository,
} from "./phase3.js";
export {
  createPhase4Repository,
  type Phase4Repository,
  type WorkerGatewayRoute,
} from "./phase4.js";
export {
  createPhase5Repository,
  type Phase5Repository,
  type ScheduleWorkspaceStartResult,
  type WorkerPlacementRecord,
  type WorkerScheduleCandidate,
  type WorkerSelectionInput,
  type WorkerSelector,
  type WorkspaceSchedulingRequirements,
} from "./phase5.js";
export {
  createPhase6Repository,
  type Phase6Repository,
  type WorkspaceRecoveryRecord,
} from "./phase6.js";
export {
  createPhase8Repository,
  type Phase8Repository,
  type PlatformAuditEvent,
} from "./phase8.js";
export {
  createPhase9Repository,
  type AdminUserRecord,
  type Phase9Repository,
  type UpdateManagedUserResult,
} from "./phase9.js";
export {
  createPhase10Repository,
  type BindUserIdentityResult,
  type CompleteOidcLoginResult,
  type Phase10Repository,
  type UserIdentityRecord,
} from "./phase10.js";
export {
  createPhase11Repository,
  type BindExternalIdentityResult,
  type CompleteExternalLoginResult,
  type Phase11Repository,
  type UnbindExternalIdentityResult,
} from "./phase11.js";
