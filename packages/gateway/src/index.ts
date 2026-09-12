import { request as httpRequest } from "node:http";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";

import { WorkspaceIdSchema } from "@agent-runtime/protocol";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PLATFORM_COOKIE_NAMES = new Set([
  "platform-session",
  "__Host-platform-session",
]);

export interface WorkspaceBaseUrl {
  protocol: "http:" | "https:";
  hostname: string;
  port: string;
}

export interface ProxyOptions {
  target: URL;
  requestHeaders: IncomingHttpHeaders;
  connectTimeoutMs?: number;
  publicOrigin?: string;
}

function connectionHeaderTokens(headers: IncomingHttpHeaders): Set<string> {
  const values = headers.connection;
  const combined = Array.isArray(values) ? values.join(",") : (values ?? "");
  return new Set(
    combined
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(value)),
  );
}

export function sanitizeRequestHeaders(
  headers: IncomingHttpHeaders,
  replacements: IncomingHttpHeaders = {},
): IncomingHttpHeaders {
  const blocked = connectionHeaderTokens(headers);
  for (const name of HOP_BY_HOP_HEADERS) blocked.add(name);
  for (const name of Object.keys(replacements)) blocked.add(name.toLowerCase());

  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name.toLowerCase())) {
      result[name] = value;
    }
  }
  for (const [name, value] of Object.entries(replacements)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

export function stripPlatformCookies(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  const kept = cookieHeader.split(";").filter((part) => {
    const separator = part.indexOf("=");
    const name = (separator < 0 ? part : part.slice(0, separator)).trim();
    return !PLATFORM_COOKIE_NAMES.has(name);
  });
  const result = kept.join(";").trim();
  return result === "" ? undefined : result;
}

function isPlatformSetCookie(value: string): boolean {
  const first = value.split(";", 1)[0] ?? "";
  const separator = first.indexOf("=");
  return PLATFORM_COOKIE_NAMES.has(
    (separator < 0 ? first : first.slice(0, separator)).trim(),
  );
}

function sanitizeResponseHeaders(
  headers: IncomingHttpHeaders,
  target: URL,
  publicOrigin?: string,
): IncomingHttpHeaders {
  const result = sanitizeRequestHeaders(headers);
  const setCookie = headers["set-cookie"]?.filter(
    (value) => !isPlatformSetCookie(value),
  );
  if (setCookie === undefined || setCookie.length === 0) {
    delete result["set-cookie"];
  } else {
    result["set-cookie"] = setCookie;
  }

  const location = headers.location;
  if (location !== undefined && publicOrigin !== undefined) {
    try {
      const parsed = new URL(location, target);
      if (parsed.origin === target.origin) {
        result.location = `${publicOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    } catch {
      delete result.location;
    }
  }
  return result;
}

function requester(target: URL) {
  if (target.protocol === "http:") return httpRequest;
  if (target.protocol === "https:") return httpsRequest;
  throw new Error("proxy target must use http or https");
}

function targetPath(request: IncomingMessage): string | null {
  const path = request.url;
  if (path === undefined || !path.startsWith("/") || path.startsWith("//")) {
    return null;
  }
  return path;
}

export function sendJsonError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message } });
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

export function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyOptions,
): void {
  const path = targetPath(request);
  if (path === null) {
    sendJsonError(response, 400, "INVALID_PROXY_PATH", "Invalid request path");
    return;
  }

  let upstreamRequest: ClientRequest;
  try {
    upstreamRequest = requester(options.target)({
      protocol: options.target.protocol,
      hostname: options.target.hostname,
      port: options.target.port,
      method: request.method,
      path,
      headers: options.requestHeaders,
    });
  } catch {
    sendJsonError(response, 502, "UPSTREAM_UNAVAILABLE", "Upstream is unavailable");
    return;
  }

  const timeoutMs = options.connectTimeoutMs ?? 10_000;
  upstreamRequest.setTimeout(timeoutMs, () => {
    upstreamRequest.destroy(new Error("upstream connection timed out"));
  });
  upstreamRequest.once("response", (upstreamResponse) => {
    upstreamRequest.setTimeout(0);
    const headers = sanitizeResponseHeaders(
      upstreamResponse.headers,
      options.target,
      options.publicOrigin,
    );
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.once("aborted", () => response.destroy());
    upstreamResponse.once("error", () => response.destroy());
    upstreamResponse.pipe(response);
  });
  upstreamRequest.once("error", () => {
    sendJsonError(response, 502, "UPSTREAM_UNAVAILABLE", "Upstream is unavailable");
  });
  response.once("close", () => {
    if (!response.writableEnded) upstreamRequest.destroy();
  });
  request.once("aborted", () => upstreamRequest.destroy());
  request.once("error", () => upstreamRequest.destroy());
  request.pipe(upstreamRequest);
}

function writeSocketResponse(
  socket: Duplex,
  statusCode: number,
  statusMessage: string,
  headers: IncomingHttpHeaders,
): void {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
}

export function rejectUpgrade(
  socket: Duplex,
  statusCode: 400 | 401 | 403 | 404 | 409 | 502 | 503,
  message: string,
): void {
  const body = `${message}\n`;
  const statusMessages: Record<typeof statusCode, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    502: "Bad Gateway",
    503: "Service Unavailable",
  };
  writeSocketResponse(socket, statusCode, statusMessages[statusCode], {
    connection: "close",
    "content-length": Buffer.byteLength(body).toString(),
    "content-type": "text/plain; charset=utf-8",
  });
  socket.end(body);
}

export function proxyWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: ProxyOptions,
): void {
  const path = targetPath(request);
  if (path === null) {
    rejectUpgrade(socket, 400, "Invalid request path");
    return;
  }
  const headers = sanitizeRequestHeaders(options.requestHeaders, {
    connection: "Upgrade",
    upgrade: "websocket",
  });

  let upstreamRequest: ClientRequest;
  try {
    upstreamRequest = requester(options.target)({
      protocol: options.target.protocol,
      hostname: options.target.hostname,
      port: options.target.port,
      method: "GET",
      path,
      headers,
    });
  } catch {
    rejectUpgrade(socket, 502, "Upstream is unavailable");
    return;
  }

  const timeoutMs = options.connectTimeoutMs ?? 10_000;
  let responseStarted = false;
  upstreamRequest.setTimeout(timeoutMs, () => {
    upstreamRequest.destroy(new Error("upstream connection timed out"));
  });
  upstreamRequest.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    responseStarted = true;
    upstreamRequest.setTimeout(0);
    upstreamSocket.setTimeout(0);
    const responseHeaders = { ...upstreamResponse.headers };
    const setCookie = responseHeaders["set-cookie"]?.filter(
      (value) => !isPlatformSetCookie(value),
    );
    if (setCookie === undefined || setCookie.length === 0) {
      delete responseHeaders["set-cookie"];
    } else {
      responseHeaders["set-cookie"] = setCookie;
    }
    writeSocketResponse(
      socket,
      upstreamResponse.statusCode ?? 101,
      upstreamResponse.statusMessage ?? "Switching Protocols",
      responseHeaders,
    );
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    socket.once("error", () => upstreamSocket.destroy());
    upstreamSocket.once("error", () => socket.destroy());
    socket.once("close", () => upstreamSocket.destroy());
    upstreamSocket.once("close", () => socket.destroy());
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamRequest.once("response", (upstreamResponse) => {
    responseStarted = true;
    upstreamRequest.setTimeout(0);
    writeSocketResponse(
      socket,
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage ?? "Bad Gateway",
      sanitizeResponseHeaders(upstreamResponse.headers, options.target),
    );
    upstreamResponse.once("aborted", () => socket.destroy());
    upstreamResponse.once("error", () => socket.destroy());
    upstreamResponse.pipe(socket);
  });
  upstreamRequest.once("error", () => {
    if (socket.destroyed) return;
    if (responseStarted) {
      socket.destroy();
    } else {
      rejectUpgrade(socket, 502, "Upstream is unavailable");
    }
  });
  socket.once("close", () => upstreamRequest.destroy());
  upstreamRequest.end();
}

export function parseHttpOrigin(value: string): URL {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("URL must be an HTTP(S) origin");
  }
  return parsed;
}

export function parseWorkspaceBaseUrl(value: string): WorkspaceBaseUrl {
  const parsed = parseHttpOrigin(value);
  const hostname = parsed.hostname.toLowerCase();
  const protocol = parsed.protocol;
  if (
    (protocol !== "http:" && protocol !== "https:") ||
    isIP(hostname) !== 0 ||
    hostname.length > 253 ||
    !hostname
      .split(".")
      .every((label) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
      )
  ) {
    throw new Error("Workspace base URL must be an HTTP(S) origin");
  }
  return {
    protocol,
    hostname,
    port: parsed.port,
  };
}

function authority(base: WorkspaceBaseUrl): string {
  return `${base.hostname}${base.port === "" ? "" : `:${base.port}`}`;
}

export function workspaceHost(
  workspaceId: string,
  base: WorkspaceBaseUrl,
): string {
  const id = WorkspaceIdSchema.parse(workspaceId);
  return `${id}.${authority(base)}`;
}

export function workspaceOrigin(
  workspaceId: string,
  base: WorkspaceBaseUrl,
): string {
  return `${base.protocol}//${workspaceHost(workspaceId, base)}`;
}

export function workspaceIdFromHost(
  hostHeader: string | undefined,
  base: WorkspaceBaseUrl,
): string | null {
  if (hostHeader === undefined || hostHeader !== hostHeader.toLowerCase()) {
    return null;
  }
  const suffix = `.${authority(base)}`;
  if (!hostHeader.endsWith(suffix)) return null;
  const candidate = hostHeader.slice(0, -suffix.length);
  const parsed = WorkspaceIdSchema.safeParse(candidate);
  return parsed.success && workspaceHost(parsed.data, base) === hostHeader
    ? parsed.data
    : null;
}
