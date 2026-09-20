export interface SessionConnectionIdentity {
  userId: string;
  sessionId: string;
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

  #closeMatching(predicate: (connection: TrackedConnection) => boolean): void {
    for (const connection of [...this.#connections]) {
      if (!predicate(connection)) continue;
      this.#connections.delete(connection);
      connection.disconnect();
    }
  }
}
