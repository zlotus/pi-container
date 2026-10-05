import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";

import pino, { type DestinationStream, type Logger } from "pino";
import { z } from "zod";

export type { Logger } from "pino";

export const LoggingConfigSchema = z.object({
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  LOG_FORMAT: z.enum(["json", "pretty"]).default("json"),
});

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

/**
 * Defense in depth: request logs only ever carry whitelisted fields (see the serializers
 * below), and these paths are censored even if a caller logs a raw object by mistake.
 */
export const REDACT_PATHS = [
  "req.headers",
  "request.headers",
  "headers",
  "*.headers",
  "cookie",
  "*.cookie",
  "authorization",
  "*.authorization",
  "password",
  "*.password",
  "token",
  "*.token",
  "rawToken",
  "*.rawToken",
  "code",
  "*.code_verifier",
  "body",
  "*.body",
];

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newRequestId(): string {
  return randomUUID();
}

/** Accepts only platform-generated request IDs, so a forwarded header cannot inject log content. */
export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

/**
 * The only path detail logged for Workspace traffic: the first segment. Deeper segments
 * and query strings can contain user file names, OAuth codes or tokens.
 */
export function workspacePathClass(url: string | undefined): string {
  if (url === undefined || !url.startsWith("/")) return "/";
  const segment = url.slice(1).split(/[/?#]/, 1)[0] ?? "";
  return /^[A-Za-z0-9._-]{1,64}$/.test(segment) ? `/${segment}` : "/";
}

interface SerializableRequest {
  id?: unknown;
  method?: string;
  routeOptions?: { url?: string };
}

interface SerializableError {
  name?: string;
  message?: string;
  code?: unknown;
  stack?: string;
  cause?: unknown;
}

interface SerializedError {
  type: string | undefined;
  message: string | undefined;
  code: string | undefined;
  stack?: string | undefined;
  cause?: SerializedError;
}

function serializeError(error: SerializableError, depth: number): SerializedError {
  const cause = error.cause;
  return {
    type: error.name,
    message: error.message,
    code: typeof error.code === "string" ? error.code : undefined,
    ...(depth === 0 ? { stack: error.stack } : {}),
    ...(typeof cause === "object" && cause !== null && depth < 3
      ? { cause: serializeError(cause, depth + 1) }
      : {}),
  };
}

export const serializers = {
  // Fastify requests: the route template never contains user data; the raw URL may.
  req(request: SerializableRequest) {
    return {
      method: request.method,
      route: request.routeOptions?.url ?? "unmatched",
    };
  },
  res(response: { statusCode?: number }) {
    return { statusCode: response.statusCode };
  },
  // Database errors keep values in `detail`; only the stable fields (and causes) are logged.
  err(error: SerializableError): SerializedError {
    return serializeError(error, 0);
  },
};

function loggerOptions(service: string, config: LoggingConfig) {
  return {
    level: config.LOG_LEVEL,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    serializers,
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

/** Synchronous JSON logger; used directly by libraries and as the production format. */
export function createJsonLogger(
  service: string,
  config: LoggingConfig = LoggingConfigSchema.parse({}),
  destination?: DestinationStream,
): Logger {
  const options = loggerOptions(service, config);
  return destination === undefined ? pino(options) : pino(options, destination);
}

export async function createLogger(
  service: string,
  config: LoggingConfig,
  destination?: DestinationStream,
): Promise<Logger> {
  if (destination !== undefined || config.LOG_FORMAT === "json") {
    return createJsonLogger(service, config, destination);
  }
  const options = loggerOptions(service, config);
  let pretty;
  try {
    ({ default: pretty } = await import("pino-pretty"));
  } catch {
    throw new Error("LOG_FORMAT=pretty requires the pino-pretty development dependency");
  }
  return pino(options, pretty({ colorize: true, translateTime: "SYS:standard" }));
}

/** Header that carries the Control Plane Gateway request ID to the Worker Gateway. */
export const REQUEST_ID_HEADER = "x-platform-request-id";

/** Reuses a forwarded platform request ID when it is well-formed; otherwise starts a new one. */
export function requestIdFrom(headers: IncomingHttpHeaders): string {
  const supplied = headers[REQUEST_ID_HEADER];
  return isRequestId(supplied) ? supplied : newRequestId();
}

interface WorkspaceTrafficContext {
  requestId: string;
  workspaceId: string | null;
}

/** Logs one whitelisted line when a proxied Workspace HTTP exchange ends. */
export function observeWorkspaceHttp(
  log: Logger,
  request: IncomingMessage,
  response: ServerResponse,
  context: WorkspaceTrafficContext,
): void {
  const startedAt = performance.now();
  response.once("close", () => {
    log.info(
      {
        requestId: context.requestId,
        workspaceId: context.workspaceId,
        method: request.method,
        path: workspacePathClass(request.url),
        statusCode: response.statusCode,
        completed: response.writableFinished,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "workspace request",
    );
  });
}

/** Logs WebSocket upgrade outcome and, once connected, the connection lifetime. */
export function observeWorkspaceUpgrade(
  log: Logger,
  request: IncomingMessage,
  socket: Duplex,
  context: WorkspaceTrafficContext,
) {
  const fields = () => ({
    requestId: context.requestId,
    workspaceId: context.workspaceId,
    path: workspacePathClass(request.url),
  });
  const startedAt = performance.now();
  return {
    rejected(statusCode: number): void {
      log.info({ ...fields(), statusCode }, "workspace websocket rejected");
    },
    connected(): void {
      log.info(fields(), "workspace websocket connected");
      socket.once("close", () => {
        log.info(
          { ...fields(), durationMs: Math.round(performance.now() - startedAt) },
          "workspace websocket closed",
        );
      });
    },
  };
}
