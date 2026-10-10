import type { Logger } from "@agent-runtime/logging";
import type { WorkerHostUsage, WorkspaceUsage } from "@agent-runtime/protocol";

import { HostUsageSampler } from "./sampler.js";

/** What the daemon reports with each heartbeat (specs.md Phase 17.5). */
export interface WorkerUsage {
  /** Samples the Workspace containers in the background; never awaited by the heartbeat. */
  refresh(): Promise<void>;
  /** The most recent Workspace sample, or null before the first one completes. */
  workspaces(): WorkspaceUsage[] | null;
  host(): WorkerHostUsage;
}

/**
 * Keeps the latest Workspace sample. A round that is still running when the next one is due
 * is not overlapped; the Control Plane drops samples whose `sampledAt` became stale.
 */
export class UsageReporter implements WorkerUsage {
  #latest: WorkspaceUsage[] | null = null;
  #sampling = false;

  constructor(
    readonly sampler: { sample(): Promise<WorkspaceUsage[]> } | null,
    readonly hostSampler: HostUsageSampler = new HostUsageSampler(),
    readonly log?: Pick<Logger, "debug">,
  ) {}

  async refresh(): Promise<void> {
    if (this.sampler === null || this.#sampling) return;
    this.#sampling = true;
    try {
      this.#latest = await this.sampler.sample();
    } catch (error) {
      this.log?.debug({ err: error }, "Workspace usage sampling failed");
    } finally {
      this.#sampling = false;
    }
  }

  workspaces(): WorkspaceUsage[] | null {
    return this.#latest;
  }

  host(): WorkerHostUsage {
    return this.hostSampler.sample();
  }
}

/** Host usage only; used when no Docker sampler is wired (tests, partial setups). */
export const HOST_ONLY_USAGE = (): WorkerUsage => new UsageReporter(null);
