import { generateOpaqueToken, hashOpaqueToken } from "@agent-runtime/auth";

interface ExchangeRecord {
  rawSessionToken: string;
  userId: string;
  workspaceId: string;
  expiresAt: number;
}

export class WorkspaceSessionExchange {
  readonly #records = new Map<string, ExchangeRecord>();

  constructor(readonly ttlMs: number) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) {
      throw new Error("Workspace session exchange TTL is out of bounds");
    }
  }

  issue(input: {
    rawSessionToken: string;
    userId: string;
    workspaceId: string;
    now: Date;
  }): string {
    this.#prune(input.now.getTime());
    for (const [key, record] of this.#records) {
      if (
        record.rawSessionToken === input.rawSessionToken &&
        record.workspaceId === input.workspaceId
      ) {
        this.#records.delete(key);
      }
    }
    const code = generateOpaqueToken();
    this.#records.set(hashOpaqueToken(code), {
      rawSessionToken: input.rawSessionToken,
      userId: input.userId,
      workspaceId: input.workspaceId,
      expiresAt: input.now.getTime() + this.ttlMs,
    });
    return code;
  }

  consume(code: string, workspaceId: string, now: Date): ExchangeRecord | null {
    const key = hashOpaqueToken(code);
    const record = this.#records.get(key);
    this.#records.delete(key);
    if (
      record === undefined ||
      record.expiresAt <= now.getTime() ||
      record.workspaceId !== workspaceId
    ) {
      return null;
    }
    return record;
  }

  #prune(now: number): void {
    for (const [key, record] of this.#records) {
      if (record.expiresAt <= now) this.#records.delete(key);
    }
  }
}
