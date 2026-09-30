import { createAuditRepository } from "./audit.js";
import { createIdentityRepository } from "./identities.js";
import type { DatabaseClient } from "./index.js";
import { createRecoveryRepository } from "./recovery.js";
import { createSchedulingRepository, type WorkerSelector } from "./scheduling.js";
import { createUserRepository } from "./users.js";
import { createWorkerRepository } from "./workers.js";
import { createWorkspaceLifecycleRepository } from "./workspace-lifecycle.js";
import { createWorkspaceRepository } from "./workspaces.js";

/**
 * The platform repository: one object composed from domain modules. Domains do not
 * override each other; every method name is defined exactly once.
 */
export function createRepository(database: DatabaseClient, selectWorker: WorkerSelector) {
  return {
    ...createUserRepository(database),
    ...createWorkspaceRepository(database),
    ...createWorkspaceLifecycleRepository(database),
    ...createWorkerRepository(database),
    ...createSchedulingRepository(database, selectWorker),
    ...createRecoveryRepository(database),
    ...createAuditRepository(database),
    ...createIdentityRepository(database),
  };
}

export type Repository = ReturnType<typeof createRepository>;
