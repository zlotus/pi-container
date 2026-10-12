import type { Logger } from "@agent-runtime/logging";

/**
 * Counts OOM events of managed Workspace containers from the Docker Engine event stream
 * (specs.md Phase 17.5, Q6). Events that arrive while the stream is reconnecting are lost,
 * so the counts are a lower bound; they restart from zero with the Worker.
 */
export interface OomEventSource {
  /** A stream of newline-delimited JSON events already filtered to managed containers' `oom`. */
  oomEvents(): Promise<NodeJS.ReadableStream>;
  /** Whether the event's container labels name a Workspace this Worker manages. */
  managedWorkspaceId(labels: Record<string, string>): string | null;
}

export interface OomEventCounterOptions {
  source: OomEventSource;
  log: Pick<Logger, "warn" | "debug">;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export class OomEventCounter {
  readonly #source: OomEventSource;
  readonly #log: Pick<Logger, "warn" | "debug">;
  readonly #initialBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #counts = new Map<string, number>();
  #stream: NodeJS.ReadableStream | null = null;
  #retry: NodeJS.Timeout | null = null;
  #backoffMs: number;
  #stopped = true;

  constructor(options: OomEventCounterOptions) {
    this.#source = options.source;
    this.#log = options.log;
    this.#initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.#backoffMs = this.#initialBackoffMs;
  }

  count(workspaceId: string): number {
    return this.#counts.get(workspaceId) ?? 0;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
    const stream = this.#stream;
    this.#stream = null;
    (stream as { destroy?: () => void } | null)?.destroy?.();
  }

  /** Counts one decoded Docker event when it is an OOM of a managed Workspace container. */
  record(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const { Type, Action, Actor } = event as {
      Type?: unknown;
      Action?: unknown;
      Actor?: { Attributes?: unknown };
    };
    if (Type !== "container" || Action !== "oom") return;
    const attributes = Actor?.Attributes;
    if (typeof attributes !== "object" || attributes === null) return;
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === "string") labels[key] = value;
    }
    const workspaceId = this.#source.managedWorkspaceId(labels);
    if (workspaceId === null) return;
    this.#counts.set(workspaceId, this.count(workspaceId) + 1);
  }

  async #open(): Promise<void> {
    if (this.#stopped) return;
    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.#source.oomEvents();
    } catch (error) {
      this.#log.warn({ err: error }, "could not subscribe to Docker OOM events");
      this.#scheduleReconnect();
      return;
    }
    if (this.#stopped) {
      (stream as { destroy?: () => void }).destroy?.();
      return;
    }
    this.#stream = stream;
    let buffered = "";
    stream.on("data", (chunk: Buffer | string) => {
      this.#backoffMs = this.#initialBackoffMs;
      buffered += chunk.toString();
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line !== "") {
          try {
            this.record(JSON.parse(line));
          } catch {
            this.#log.debug({}, "ignored an undecodable Docker event");
          }
        }
        newline = buffered.indexOf("\n");
      }
      // A single event is small; an unterminated huge buffer is not an event stream.
      if (buffered.length > 1_000_000) buffered = "";
    });
    const closed = () => {
      if (this.#stream !== stream) return;
      this.#stream = null;
      this.#scheduleReconnect();
    };
    stream.on("end", closed);
    stream.on("close", closed);
    stream.on("error", (error: unknown) => {
      this.#log.warn({ err: error }, "Docker OOM event stream failed");
      closed();
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#retry !== null) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#maxBackoffMs, this.#backoffMs * 2);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.#open();
    }, delay);
    this.#retry.unref();
  }
}
