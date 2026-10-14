import type { WorkspaceAccessTracker } from "./access-tracker.js";
import type { ComputeActivityTracker } from "./compute-activity.js";
import type { IdlePolicy } from "./idle-stopper.js";

/** What the Portal shows about a running Workspace under the idle policy (Phase 18.5). */
export interface IdleView {
  /** A Gateway connection is open now: the Workspace is not idle. */
  connected: boolean;
  /** Since when every condition has held (now while connected). */
  idleSince: string;
  /** When the sweep may stop it, at the earliest; sweeps run every 5 minutes. */
  stopAt: string;
}

/**
 * The same three conditions the idle sweep checks, as a point in time: the latest of the
 * run's start, the Control Plane's start, the last Gateway access and the last CPU
 * activity. Null unless the Workspace is running.
 */
export function idleView(input: {
  workspace: { id: string; state: string; lastActivityAt: Date; lastAccessAt: Date | null };
  policy: IdlePolicy;
  access: WorkspaceAccessTracker;
  compute: ComputeActivityTracker;
  startedAt: Date;
  activeConnections: number;
  now: Date;
}): IdleView | null {
  const { workspace, policy, now } = input;
  if (workspace.state !== "RUNNING") return null;
  const connected = input.activeConnections > 0;
  const candidates = [
    workspace.lastActivityAt,
    input.startedAt,
    workspace.lastAccessAt,
    input.access.latest(workspace.id),
    input.compute.lastActiveAt(workspace.id, now),
  ].filter((value): value is Date => value !== null);
  const idleSince = connected ? now : new Date(Math.max(...candidates.map((value) => value.getTime())));
  return {
    connected,
    idleSince: idleSince.toISOString(),
    stopAt: new Date(idleSince.getTime() + policy.stopAfterHours * 3_600_000).toISOString(),
  };
}
