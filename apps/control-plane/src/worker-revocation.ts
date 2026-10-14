import type { RevokedWorkerAssignment } from "@agent-runtime/database";
import type { Logger } from "@agent-runtime/logging";

/**
 * Applies a Worker revocation that happened in the database (worker:disable, or any other
 * path that set `enabled = false`) to this process: the control channel and every Gateway
 * connection to the Worker's Workspaces are closed (specs.md Phase 18.6). New connections
 * are already refused, because both require an enabled Worker.
 */
export async function enforceWorkerRevocations(dependencies: {
  store: { listRevokedWorkerAssignments(): Promise<RevokedWorkerAssignment[]> };
  channel: {
    isConnected(workerId: string): boolean;
    disconnect(workerId: string, code: number, reason: string): boolean;
  };
  sessionConnections?: { closeWorkspaces(workspaceIds: Iterable<string>): void };
  log?: Pick<Logger, "info">;
}): Promise<void> {
  const revoked = await dependencies.store.listRevokedWorkerAssignments();
  for (const { workerId, workspaceIds } of revoked) {
    if (dependencies.channel.isConnected(workerId)) {
      dependencies.channel.disconnect(workerId, 1008, "Worker revoked");
      dependencies.log?.info({ workerId }, "closed the control connection of a revoked worker");
    }
    dependencies.sessionConnections?.closeWorkspaces(workspaceIds);
  }
}
