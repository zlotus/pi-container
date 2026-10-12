/** How often a Workspace's last access is written while it keeps being used. */
export const ACCESS_PERSIST_INTERVAL_MS = 60_000;

interface AccessState {
  latest: Date;
  persisted: Date | null;
  pending: boolean;
}

/**
 * The last Gateway access per Workspace (specs.md Phase 18.5). Every authorized request
 * and WebSocket upgrade touches it, and so does the end of every connection, so an idle
 * window starts when the last connection closes. Writes go to the database at most once
 * a minute per Workspace, and right away when a connection ends.
 */
export class WorkspaceAccessTracker {
  readonly #states = new Map<string, AccessState>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  touch(workspaceId: string, connectionEnded = false): void {
    const now = this.#now();
    const state = this.#states.get(workspaceId);
    if (state === undefined) {
      this.#states.set(workspaceId, { latest: now, persisted: null, pending: true });
      return;
    }
    if (now > state.latest) state.latest = now;
    if (
      connectionEnded ||
      state.persisted === null ||
      now.getTime() - state.persisted.getTime() >= ACCESS_PERSIST_INTERVAL_MS
    ) {
      state.pending = true;
    }
  }

  /** The latest access this process has seen, which may be newer than the database. */
  latest(workspaceId: string): Date | null {
    return this.#states.get(workspaceId)?.latest ?? null;
  }

  /** Writes pending accesses; failed writes stay pending for the next flush. */
  async flush(write: (entries: Array<{ workspaceId: string; at: Date }>) => Promise<void>): Promise<void> {
    const entries = [...this.#states]
      .filter(([, state]) => state.pending)
      .map(([workspaceId, state]) => ({ workspaceId, at: state.latest }));
    if (entries.length === 0) return;
    for (const entry of entries) {
      const state = this.#states.get(entry.workspaceId);
      if (state !== undefined) state.pending = false;
    }
    try {
      await write(entries);
      for (const entry of entries) {
        const state = this.#states.get(entry.workspaceId);
        if (state !== undefined) state.persisted = entry.at;
      }
    } catch (error) {
      for (const entry of entries) {
        const state = this.#states.get(entry.workspaceId);
        if (state !== undefined) state.pending = true;
      }
      throw error;
    }
  }
}
