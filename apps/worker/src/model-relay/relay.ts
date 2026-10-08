import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { performance } from "node:perf_hooks";

import type { Logger } from "@agent-runtime/logging";
import { MODEL_RELAY_ROUTES, type ModelRelayStatus } from "@agent-runtime/protocol";

/**
 * Worker model relay (specs.md Phase 16.4). Workspaces never reach the model gateway: Pi
 * sends inference requests to this listener on the Workspace's bridge gateway address. The
 * relay identifies the Workspace from the TCP connection itself, forwards only inference
 * routes, drops every client credential header and injects that Workspace's virtual key.
 * It does not parse or rewrite request bodies.
 */

/** A running managed Workspace as the Worker itself inspected it. */
export interface RelayEndpoint {
  workspaceId: string;
  /** The Workspace bridge's gateway address on this host (the connection's local address). */
  gatewayAddress: string;
  /** The Workspace container's address (the connection's remote address). */
  containerAddress: string;
}

export interface ModelRelayOptions {
  port: number;
  host?: string;
  /** WORKER_MODEL_GATEWAY_URL: the gateway's inference origin, reachable from this host. */
  upstream: URL;
  keys: { get(workspaceId: string): string | undefined };
  endpoints: () => Promise<RelayEndpoint[]>;
  maxBodyBytes: number;
  maxConcurrentPerWorkspace?: number;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Minimum interval between endpoint refreshes triggered by unknown connections. */
  refreshIntervalMs?: number;
  log: Pick<Logger, "info" | "warn">;
}

export const ALLOWED_RELAY_PATHS: ReadonlySet<string> = new Set(
  Object.values(MODEL_RELAY_ROUTES).flat(),
);

const FORWARDED_HEADERS = new Set([
  "content-type",
  "content-length",
  "accept",
  "user-agent",
  "openai-beta",
  "anthropic-version",
  "anthropic-beta",
  "session_id",
  "x-client-request-id",
  "x-session-affinity",
]);
const FORWARDED_HEADER_PREFIXES = ["x-stainless-"];

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
]);

/** Request headers that reach the gateway: an allow-list, never client credentials. */
export function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  virtualKey: string,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    const lower = name.toLowerCase();
    if (FORWARDED_HEADERS.has(lower) || FORWARDED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      forwarded[lower] = value;
    }
  }
  forwarded.authorization = `Bearer ${virtualKey}`;
  return forwarded;
}

function plainAddress(address: string | undefined): string {
  if (address === undefined) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function endpointKey(local: string, remote: string): string {
  return `${local}|${remote}`;
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ error: { type: "model_relay_error", code, message } });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
}

export class ModelRelay {
  readonly #options: Required<Omit<ModelRelayOptions, "host">> & { host: string };
  #server: Server | null = null;
  #listening = false;
  #endpoints = new Map<string, string>();
  #lastRefresh = 0;
  #refreshing: Promise<void> | null = null;
  readonly #active = new Map<string, number>();
  readonly #identities = new WeakMap<Socket, string>();

  constructor(options: ModelRelayOptions) {
    this.#options = {
      host: "0.0.0.0",
      maxConcurrentPerWorkspace: 16,
      idleTimeoutMs: 600_000,
      connectTimeoutMs: 10_000,
      refreshIntervalMs: 1_000,
      ...options,
    };
  }

  status(): ModelRelayStatus {
    return { enabled: true, port: this.#options.port, listening: this.#listening };
  }

  /** The bound port (differs from the configured one only when it was 0, in tests). */
  address(): AddressInfo | null {
    const address = this.#server?.address();
    return typeof address === "object" && address !== null ? address : null;
  }

  async start(): Promise<void> {
    if (this.#server !== null) return;
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    server.on("clientError", (_error, socket) => socket.destroy());
    this.#server = server;
    await this.refresh();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port, this.#options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#listening = true;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#listening = false;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Re-reads the running managed Workspaces (after ensure, start, stop, delete, reconcile). */
  refresh(): Promise<void> {
    this.#refreshing ??= (async () => {
      try {
        const endpoints = await this.#options.endpoints();
        this.#endpoints = new Map(
          endpoints.map((endpoint) => [
            endpointKey(endpoint.gatewayAddress, endpoint.containerAddress),
            endpoint.workspaceId,
          ]),
        );
      } catch (error) {
        this.#options.log.warn({ err: error }, "model relay could not refresh Workspace endpoints");
      } finally {
        this.#lastRefresh = Date.now();
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  async #identify(socket: Socket): Promise<string | null> {
    const known = this.#identities.get(socket);
    if (known !== undefined) return known;
    const key = endpointKey(plainAddress(socket.localAddress), plainAddress(socket.remoteAddress));
    let workspaceId = this.#endpoints.get(key);
    if (workspaceId === undefined && Date.now() - this.#lastRefresh >= this.#options.refreshIntervalMs) {
      await this.refresh();
      workspaceId = this.#endpoints.get(key);
    }
    if (workspaceId === undefined) return null;
    this.#identities.set(socket, workspaceId);
    return workspaceId;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = performance.now();
    const workspaceId = await this.#identify(request.socket);
    if (workspaceId === null) {
      // Not a running managed Workspace on this host: no response at all.
      request.socket.destroy();
      return;
    }
    const path = request.url ?? "";
    const log = (status: number, bytesIn: number, bytesOut: number) =>
      this.#options.log.info(
        {
          workspaceId,
          method: request.method,
          path: "/v1",
          status,
          durationMs: Math.round(performance.now() - startedAt),
          bytesIn,
          bytesOut,
        },
        "model relay request",
      );

    if (request.method !== "POST" || !ALLOWED_RELAY_PATHS.has(path)) {
      sendError(response, 404, "MODEL_RELAY_ROUTE_NOT_FOUND", "Only model inference routes are available");
      log(404, 0, 0);
      return;
    }
    const virtualKey = this.#options.keys.get(workspaceId);
    if (virtualKey === undefined) {
      sendError(
        response,
        403,
        "MODEL_KEY_UNAVAILABLE",
        "Platform model access is not available for this Workspace right now",
      );
      log(403, 0, 0);
      return;
    }
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (!Number.isFinite(declaredLength) || declaredLength > this.#options.maxBodyBytes) {
      sendError(response, 413, "MODEL_RELAY_BODY_TOO_LARGE", "Request body is too large");
      log(413, 0, 0);
      return;
    }
    const active = this.#active.get(workspaceId) ?? 0;
    if (active >= this.#options.maxConcurrentPerWorkspace) {
      sendError(response, 429, "MODEL_RELAY_BUSY", "Too many concurrent model requests");
      log(429, 0, 0);
      return;
    }
    this.#active.set(workspaceId, active + 1);
    try {
      await this.#forward(request, response, path, virtualKey, log);
    } finally {
      const remaining = (this.#active.get(workspaceId) ?? 1) - 1;
      if (remaining <= 0) this.#active.delete(workspaceId);
      else this.#active.set(workspaceId, remaining);
    }
  }

  #forward(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    virtualKey: string,
    log: (status: number, bytesIn: number, bytesOut: number) => void,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const upstream = this.#options.upstream;
      const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
      const basePath = upstream.pathname.replace(/\/$/, "");
      let bytesIn = 0;
      let bytesOut = 0;
      let status = 502;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        log(status, bytesIn, bytesOut);
        resolve();
      };

      const outgoing = send({
        protocol: upstream.protocol,
        hostname: upstream.hostname.replace(/^\[|\]$/g, ""),
        port: upstream.port === "" ? undefined : Number(upstream.port),
        method: "POST",
        path: `${basePath}${path}`,
        headers: forwardedRequestHeaders(request.headers, virtualKey),
      });
      const connectTimer = setTimeout(() => {
        outgoing.destroy(new Error("model gateway connect timeout"));
      }, this.#options.connectTimeoutMs);
      outgoing.once("socket", (socket) => {
        socket.once(upstream.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
      });
      outgoing.setTimeout(this.#options.idleTimeoutMs, () => {
        outgoing.destroy(new Error("model gateway idle timeout"));
      });
      request.socket.setTimeout(this.#options.idleTimeoutMs, () => {
        request.socket.destroy();
      });

      outgoing.on("response", (incoming) => {
        clearTimeout(connectTimer);
        status = incoming.statusCode ?? 502;
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined && !STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
            headers[name] = value;
          }
        }
        response.writeHead(status, headers);
        response.flushHeaders();
        incoming.on("data", (chunk: Buffer) => {
          bytesOut += chunk.length;
        });
        incoming.pipe(response);
        incoming.on("end", finish);
        incoming.on("error", () => {
          response.destroy();
          finish();
        });
      });
      outgoing.on("error", () => {
        clearTimeout(connectTimer);
        // Already answered (body too large) or the client went away first.
        if (settled) return;
        if (!response.headersSent) {
          status = 502;
          sendError(response, 502, "MODEL_GATEWAY_UNAVAILABLE", "The model gateway is not reachable");
        } else {
          response.destroy();
        }
        finish();
      });
      // The Agent stopped the request (Pi abort) or the connection broke: stop upstream too.
      response.on("close", () => {
        if (!response.writableFinished) outgoing.destroy();
        finish();
      });

      request.on("data", (chunk: Buffer) => {
        bytesIn += chunk.length;
        if (bytesIn > this.#options.maxBodyBytes) {
          outgoing.destroy();
          request.unpipe(outgoing);
          status = 413;
          sendError(response, 413, "MODEL_RELAY_BODY_TOO_LARGE", "Request body is too large");
          finish();
        }
      });
      request.pipe(outgoing);
    });
  }
}

/** Used when the relay is not configured on this Worker. */
export const DISABLED_MODEL_RELAY_STATUS: ModelRelayStatus = {
  enabled: false,
  port: null,
  listening: false,
};
