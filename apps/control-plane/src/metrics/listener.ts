import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";

import type { Logger } from "@agent-runtime/logging";

/**
 * The dedicated metrics listener (specs.md Phase 17.7, 17.8). It is never part of the Portal
 * API or the Workspace Gateway, accepts only `GET /metrics` with the configured Bearer token,
 * and has no unauthenticated mode.
 */

const TOKEN_PATTERN = /^[\x21-\x7e]{32,512}$/;

export class MetricsConfigError extends Error {}

/** Reads the token file: a regular file, not a symlink, readable by its owner only. */
export async function readMetricsToken(path: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new MetricsConfigError("METRICS_TOKEN_FILE cannot be read");
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new MetricsConfigError("METRICS_TOKEN_FILE must be a regular file, not a symbolic link");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new MetricsConfigError("METRICS_TOKEN_FILE must not be readable by group or others (use 0600)");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content: string;
  try {
    content = (await handle.readFile({ encoding: "utf8" })).replace(/\r?\n$/, "");
  } finally {
    await handle.close();
  }
  if (!TOKEN_PATTERN.test(content)) {
    throw new MetricsConfigError("METRICS_TOKEN_FILE must hold 32-512 printable ASCII characters");
  }
  return content;
}

/** Rejects wildcard addresses and clashes with the Portal API and Workspace Gateway listeners. */
export function validateMetricsListen(input: {
  metricsHost: string;
  metricsPort: number;
  listeners: ReadonlyArray<{ host: string; port: number }>;
}): void {
  const host = input.metricsHost.replace(/^\[|\]$/g, "");
  if (host === "0.0.0.0" || host === "::" || host === "*" || host === "") {
    throw new MetricsConfigError("METRICS_HOST must name one address, not a wildcard");
  }
  if (isIP(host) === 0 && host !== "localhost") {
    throw new MetricsConfigError("METRICS_HOST must be an IP address or localhost");
  }
  for (const listener of input.listeners) {
    if (listener.port !== input.metricsPort) continue;
    const wildcard = listener.host === "0.0.0.0" || listener.host === "::";
    if (wildcard || listener.host === host) {
      throw new MetricsConfigError("METRICS_PORT must differ from the Portal API and Workspace Gateway ports");
    }
  }
}

export interface MetricsServerOptions {
  token: string;
  collect: () => Promise<string>;
  contentType: string;
  log?: Pick<Logger, "info" | "warn">;
  maxConcurrent?: number;
}

/** Constant-time Bearer comparison: both sides are HMACed so lengths never leak. */
function tokenMatcher(token: string): (header: string | undefined) => boolean {
  const key = randomBytes(32);
  const expected = createHmac("sha256", key).update(token).digest();
  return (header) => {
    const supplied = header !== undefined && header.startsWith("Bearer ") ? header.slice(7) : "";
    const digest = createHmac("sha256", key).update(supplied).digest();
    return timingSafeEqual(digest, expected);
  };
}

function reply(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end();
}

export function createMetricsServer(options: MetricsServerOptions): Server {
  const authorized = tokenMatcher(options.token);
  const maxConcurrent = options.maxConcurrent ?? 2;
  let active = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== "/metrics") {
      reply(response, 404);
      return;
    }
    if (request.method !== "GET") {
      reply(response, 405, { allow: "GET" });
      return;
    }
    if (!authorized(request.headers.authorization)) {
      options.log?.info({ statusCode: 401 }, "metrics scrape rejected");
      reply(response, 401, { "www-authenticate": "Bearer" });
      return;
    }
    if (active >= maxConcurrent) {
      reply(response, 503);
      return;
    }
    active += 1;
    options
      .collect()
      .then((body) => {
        response.writeHead(200, { "content-type": options.contentType, "cache-control": "no-store" });
        response.end(body);
      })
      .catch((error: unknown) => {
        options.log?.warn({ err: error }, "metrics collection failed");
        if (!response.headersSent) reply(response, 500);
      })
      .finally(() => {
        active -= 1;
      });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
