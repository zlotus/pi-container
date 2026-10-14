import type { WorkspaceUsage } from "@agent-runtime/protocol";

/** Length of the averaging window for CPU activity (specs.md Phase 18.5). */
export const COMPUTE_BUCKET_MS = 5 * 60_000;
/** Samples further apart than this mean the CPU history is unknown. */
export const COMPUTE_MAX_SAMPLE_GAP_MS = 60_000;

interface Point {
  at: number;
  nanos: number;
}

interface ComputeState {
  workerId: string;
  bucketStart: Point;
  last: Point;
  activeAt: number;
}

/**
 * When each running Workspace last did real work, from the cumulative CPU counter the
 * Worker reports with every heartbeat (Phase 17). The CPU average over each 5-minute
 * bucket is compared with the threshold, so a short `git status` does not reset a day's
 * window while sustained builds, services or Agent work do. Anything unknown counts as
 * activity: the first sample, a gap between samples, a counter that went back (container
 * restarted) and a Worker that disconnected. Kept in memory only; after a Control Plane
 * restart every Workspace starts out active.
 */
export class ComputeActivityTracker {
  readonly #states = new Map<string, ComputeState>();
  readonly #thresholdCores: number;

  constructor(thresholdCores: number) {
    this.#thresholdCores = thresholdCores;
  }

  /** Feeds the samples of one heartbeat, already limited to Workspaces running on the Worker. */
  record(workerId: string, samples: readonly Pick<WorkspaceUsage, "workspaceId" | "sampledAt" | "cpuUsageNanos">[]): void {
    for (const sample of samples) {
      const point = { at: Date.parse(sample.sampledAt), nanos: sample.cpuUsageNanos };
      if (!Number.isFinite(point.at)) continue;
      const state = this.#states.get(sample.workspaceId);
      if (state === undefined || state.workerId !== workerId) {
        this.#states.set(sample.workspaceId, { workerId, bucketStart: point, last: point, activeAt: point.at });
        continue;
      }
      if (point.at <= state.last.at) continue;
      if (point.at - state.last.at > COMPUTE_MAX_SAMPLE_GAP_MS || point.nanos < state.last.nanos) {
        state.activeAt = point.at;
        state.bucketStart = point;
      } else if (point.at - state.bucketStart.at >= COMPUTE_BUCKET_MS) {
        const cores = (point.nanos - state.bucketStart.nanos) / 1e9 / ((point.at - state.bucketStart.at) / 1_000);
        if (cores >= this.#thresholdCores) state.activeAt = point.at;
        state.bucketStart = point;
      }
      state.last = point;
    }
  }

  /** A Worker's samples are no longer coming (disconnect): its Workspaces become unknown. */
  forgetWorker(workerId: string): void {
    for (const [workspaceId, state] of this.#states) {
      if (state.workerId === workerId) this.#states.delete(workspaceId);
    }
  }

  /** When the Workspace last computed; `now` whenever its recent history is unknown. */
  lastActiveAt(workspaceId: string, now: Date): Date {
    const state = this.#states.get(workspaceId);
    if (state === undefined || now.getTime() - state.last.at > COMPUTE_MAX_SAMPLE_GAP_MS) return now;
    // Work in the bucket still being filled counts too, once it spans a minute.
    const elapsed = state.last.at - state.bucketStart.at;
    if (elapsed >= 60_000) {
      const cores = (state.last.nanos - state.bucketStart.nanos) / 1e9 / (elapsed / 1_000);
      if (cores >= this.#thresholdCores) return new Date(state.last.at);
    }
    return new Date(state.activeAt);
  }
}
