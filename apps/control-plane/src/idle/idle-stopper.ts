import type { IdleStopCandidate } from "@agent-runtime/database";
import type { Logger } from "@agent-runtime/logging";

import type { ComputeActivityTracker } from "./compute-activity.js";
import type { WorkspaceAccessTracker } from "./access-tracker.js";

/** The administrator's idle policy (specs.md Phase 18.5); absent means idle stop is off. */
export interface IdlePolicy {
  stopAfterHours: number;
  cpuThresholdCores: number;
}

export const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000;
const CANDIDATES_PER_SWEEP = 50;
const STOPS_PER_SWEEP = 10;

export type IdleStopResult = "stopped" | "skipped_race" | "failed";

export interface IdleStopperDependencies {
  policy: IdlePolicy;
  store: {
    listIdleStopCandidates(input: { cutoff: Date; limit: number }): Promise<IdleStopCandidate[]>;
    beginIdleStop(input: {
      workspaceId: string;
      workerId: string;
      cutoff: Date;
      idleAfterHours: number;
      cpuThresholdCores: number;
    }): Promise<boolean>;
  };
  /** Sends workspace.stop and settles the Workspace (finish or failure), like a user stop. */
  stop(candidate: IdleStopCandidate): Promise<boolean>;
  workerConnected(workerId: string): boolean;
  activeConnections(workspaceId: string): number;
  access: WorkspaceAccessTracker;
  compute: ComputeActivityTracker;
  /** When this Control Plane process started: no connection or CPU history before it. */
  startedAt: Date;
  now?: () => Date;
  recordStop?: (result: IdleStopResult) => void;
  log?: Pick<Logger, "info" | "warn">;
}

/**
 * Stops Workspaces that have been idle for the whole policy window: no live Gateway
 * connection, no Gateway access and no CPU activity, all three unknown-is-active
 * (specs.md Phase 18.5). It only ever stops; data, assignment and model keys stay.
 */
export class IdleStopper {
  readonly #dependencies: IdleStopperDependencies;
  readonly #now: () => Date;

  constructor(dependencies: IdleStopperDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => new Date());
  }

  #idleSince(candidate: IdleStopCandidate, cutoff: Date, now: Date): boolean {
    const { access, compute, activeConnections, workerConnected } = this.#dependencies;
    if (!workerConnected(candidate.workerId)) return false;
    if (activeConnections(candidate.workspaceId) > 0) return false;
    const accessed = access.latest(candidate.workspaceId);
    if (accessed !== null && accessed > cutoff) return false;
    return compute.lastActiveAt(candidate.workspaceId, now) <= cutoff;
  }

  async sweep(): Promise<{ stopped: number; skipped: number }> {
    const { policy, store, startedAt } = this.#dependencies;
    const now = this.#now();
    const windowMs = policy.stopAfterHours * 3_600_000;
    // Nothing is known about connections and CPU from before this process started.
    if (now.getTime() - startedAt.getTime() < windowMs) return { stopped: 0, skipped: 0 };
    const cutoff = new Date(now.getTime() - windowMs);
    const candidates = await store.listIdleStopCandidates({ cutoff, limit: CANDIDATES_PER_SWEEP });
    let stopped = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      if (stopped >= STOPS_PER_SWEEP) break;
      if (!this.#idleSince(candidate, cutoff, now)) continue;
      // Re-checked in SQL against the last persisted access: a racing access wins.
      const begun = await store.beginIdleStop({
        workspaceId: candidate.workspaceId,
        workerId: candidate.workerId,
        cutoff,
        idleAfterHours: policy.stopAfterHours,
        cpuThresholdCores: policy.cpuThresholdCores,
      });
      if (!begun) {
        skipped += 1;
        this.#dependencies.recordStop?.("skipped_race");
        continue;
      }
      const ok = await this.#dependencies.stop(candidate).catch(() => false);
      this.#dependencies.recordStop?.(ok ? "stopped" : "failed");
      if (ok) {
        stopped += 1;
        this.#dependencies.log?.info(
          { workspaceId: candidate.workspaceId, workerId: candidate.workerId, idleAfterHours: policy.stopAfterHours },
          "stopped an idle Workspace",
        );
      } else {
        this.#dependencies.log?.warn({ workspaceId: candidate.workspaceId }, "idle stop did not complete");
      }
    }
    return { stopped, skipped };
  }
}
