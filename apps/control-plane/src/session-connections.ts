export interface SessionConnectionIdentity {
  userId: string;
  sessionId: string;
  workspaceId: string;
}

interface TrackedConnection extends SessionConnectionIdentity {
  disconnect: () => void;
}

export class SessionConnectionRegistry {
  readonly #connections = new Set<TrackedConnection>();

  register(
    identity: SessionConnectionIdentity,
    disconnect: () => void,
  ): () => void {
    const connection = { ...identity, disconnect };
    this.#connections.add(connection);
    return () => this.#connections.delete(connection);
  }

  closeSession(sessionId: string): void {
    this.#closeMatching((connection) => connection.sessionId === sessionId);
  }

  closeUser(userId: string): void {
    this.#closeMatching((connection) => connection.userId === userId);
  }

  /** Closes every connection to these Workspaces, e.g. when their Worker is revoked. */
  closeWorkspaces(workspaceIds: Iterable<string>): void {
    const targets = new Set(workspaceIds);
    if (targets.size === 0) return;
    this.#closeMatching((connection) => targets.has(connection.workspaceId));
  }

  #closeMatching(predicate: (connection: TrackedConnection) => boolean): void {
    for (const connection of [...this.#connections]) {
      if (!predicate(connection)) continue;
      this.#connections.delete(connection);
      connection.disconnect();
    }
  }
}
