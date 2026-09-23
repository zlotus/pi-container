import type { DatabaseClient } from "./index.js";
import {
  createPhase11Repository,
  type Phase11Repository,
} from "./phase11.js";
import type { AuthenticationAuditMetadata } from "./phase1.js";
import type { WorkerSelector } from "./phase5.js";

export type AuthenticationFailureCategory =
  | "invalid_request"
  | "invalid_credentials"
  | "provider_unavailable"
  | "transaction_invalid"
  | "protocol_validation_failed"
  | "identity_not_bound"
  | "provisioning_not_allowed"
  | "user_disabled";

export function createPhase12Repository(
  database: DatabaseClient,
  selectWorker: WorkerSelector,
) {
  const phase11: Phase11Repository = createPhase11Repository(
    database,
    selectWorker,
  );

  return {
    ...phase11,

    async recordAuthenticationFailure(input: {
      category: AuthenticationFailureCategory;
      audit: AuthenticationAuditMetadata;
    }): Promise<void> {
      await database`
        insert into platform_audit_events (event_type, details)
        values (
          'auth.login_failed',
          ${database.json({ ...input.audit, category: input.category })}
        )
      `;
    },
  };
}

export type Phase12Repository = ReturnType<typeof createPhase12Repository>;
