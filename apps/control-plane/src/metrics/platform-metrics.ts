import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Every Control Plane Prometheus metric (specs.md Phase 17.4). Label values are bounded
 * enumerations, route templates, UUIDs and Worker IDs only; never names, emails, paths,
 * addresses, request IDs or credentials.
 */

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const MAX_ERROR_CODES = 50;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function methodLabel(method: string | undefined): string {
  const upper = (method ?? "").toUpperCase();
  return HTTP_METHODS.has(upper) ? upper : "OTHER";
}

export function statusClass(statusCode: number): string {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) return "other";
  return `${Math.floor(statusCode / 100)}xx`;
}

export type GatewaySource = "platform" | "upstream";
export type WorkerCommandResult =
  | "ok"
  | "error"
  | "timeout"
  | "not_connected"
  | "connection_closed"
  | "mismatch";
export type LoginProtocol = "local" | "oidc" | "oauth2";
export type LoginResult = "success" | "failure" | "rate_limited";
export type RateLimitedEndpoint = "local_login" | "sso_start" | "sso_callback";
export type ModelGatewayOperation =
  | "generate_key"
  | "delete_key"
  | "ensure_user"
  | "list_models"
  | "user_info";
export type ModelGatewayResult = "ok" | "error" | "unreachable";
export type BackgroundTask = "worker_offline_sweep" | "auth_throttle_cleanup" | "model_key_loop";

export interface PlatformMetricsOptions {
  /** Node.js process metrics (`nodejs_*`, `process_*`); off in unit tests. */
  defaultMetrics?: boolean;
  version?: string;
  protocolVersion?: number;
}

export class PlatformMetrics {
  readonly registry = new Registry();
  readonly #errorCodes = new Set<string>();

  // Portal API.
  readonly httpRequests = new Counter({
    name: "agent_runtime_http_requests_total",
    help: "Portal API requests by route template, method and status class.",
    labelNames: ["route", "method", "status_class"] as const,
    registers: [this.registry],
  });
  readonly httpDuration = new Histogram({
    name: "agent_runtime_http_request_duration_seconds",
    help: "Portal API request duration by route template and method.",
    labelNames: ["route", "method"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15],
    registers: [this.registry],
  });

  // Workspace Gateway.
  readonly gatewayRequests = new Counter({
    name: "agent_runtime_gateway_http_requests_total",
    help: "Workspace Gateway HTTP requests; source=platform when the Gateway answered itself.",
    labelNames: ["source", "status_class"] as const,
    registers: [this.registry],
  });
  readonly gatewayHeaderSeconds = new Histogram({
    name: "agent_runtime_gateway_http_response_header_seconds",
    help: "Time from receiving a Workspace Gateway request to writing the response headers.",
    labelNames: ["source"] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });
  readonly gatewayWebSockets = new Gauge({
    name: "agent_runtime_gateway_websocket_connections",
    help: "WebSocket connections currently proxied by the Workspace Gateway.",
    registers: [this.registry],
  });
  readonly gatewayUpgrades = new Counter({
    name: "agent_runtime_gateway_websocket_upgrades_total",
    help: "Workspace Gateway WebSocket upgrade outcomes.",
    labelNames: ["result", "status_class"] as const,
    registers: [this.registry],
  });
  readonly gatewayExchanges = new Counter({
    name: "agent_runtime_gateway_session_exchanges_total",
    help: "Workspace Host session exchange code redemptions by result.",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });

  // Worker control channel.
  readonly workerCommands = new Counter({
    name: "agent_runtime_worker_commands_total",
    help: "Commands sent to Workers by command type and result.",
    labelNames: ["command", "result"] as const,
    registers: [this.registry],
  });
  readonly workerCommandErrors = new Counter({
    name: "agent_runtime_worker_command_errors_total",
    help: "Typed Worker command errors by command type and protocol error code.",
    labelNames: ["command", "code"] as const,
    registers: [this.registry],
  });
  readonly workerCommandDuration = new Histogram({
    name: "agent_runtime_worker_command_duration_seconds",
    help: "Time from sending a Worker command to its response or timeout.",
    labelNames: ["command"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30],
    registers: [this.registry],
  });
  readonly workerHeartbeats = new Counter({
    name: "agent_runtime_worker_heartbeats_total",
    help: "Worker heartbeats by result.",
    labelNames: ["worker_id", "result"] as const,
    registers: [this.registry],
  });

  // Authentication.
  readonly logins = new Counter({
    name: "agent_runtime_auth_logins_total",
    help: "Login attempts by protocol and result.",
    labelNames: ["protocol", "result"] as const,
    registers: [this.registry],
  });
  readonly loginFailures = new Counter({
    name: "agent_runtime_auth_login_failures_total",
    help: "Login failures by protocol and stable failure category.",
    labelNames: ["protocol", "category"] as const,
    registers: [this.registry],
  });
  readonly lockouts = new Counter({
    name: "agent_runtime_auth_lockouts_total",
    help: "Login lockouts by throttle scope.",
    labelNames: ["scope"] as const,
    registers: [this.registry],
  });
  readonly rateLimited = new Counter({
    name: "agent_runtime_auth_rate_limited_total",
    help: "Requests refused while a login throttle lock was active.",
    labelNames: ["endpoint"] as const,
    registers: [this.registry],
  });

  // Model gateway administration.
  readonly modelGatewayRequests = new Counter({
    name: "agent_runtime_model_gateway_requests_total",
    help: "Model gateway management API calls by operation and result.",
    labelNames: ["operation", "result"] as const,
    registers: [this.registry],
  });
  readonly modelGatewayReachable = new Gauge({
    name: "agent_runtime_model_gateway_reachable",
    help: "Whether the latest model gateway management call reached the gateway.",
    registers: [this.registry],
  });

  readonly backgroundFailures = new Counter({
    name: "agent_runtime_background_task_failures_total",
    help: "Failures of periodic Control Plane tasks.",
    labelNames: ["task"] as const,
    registers: [this.registry],
  });

  constructor(options: PlatformMetricsOptions = {}) {
    new Gauge({
      name: "agent_runtime_build_info",
      help: "Control Plane build information.",
      labelNames: ["version", "protocol_version"] as const,
      registers: [this.registry],
    })
      .labels(options.version ?? "dev", String(options.protocolVersion ?? 0))
      .set(1);
    if (options.defaultMetrics === true) collectDefaultMetrics({ register: this.registry });
  }

  recordHttp(route: string | undefined, method: string | undefined, statusCode: number, seconds: number): void {
    const routeLabel = route ?? "unmatched";
    const methodValue = methodLabel(method);
    this.httpRequests.labels(routeLabel, methodValue, statusClass(statusCode)).inc();
    this.httpDuration.labels(routeLabel, methodValue).observe(Math.max(0, seconds));
  }

  recordGatewayResponse(source: GatewaySource, statusCode: number, headerSeconds: number): void {
    this.gatewayRequests.labels(source, statusClass(statusCode)).inc();
    this.gatewayHeaderSeconds.labels(source).observe(Math.max(0, headerSeconds));
  }

  recordUpgrade(result: "connected" | "rejected", statusCode: number): void {
    this.gatewayUpgrades.labels(result, statusClass(statusCode)).inc();
  }

  recordExchange(result: "ok" | "invalid" | "expired"): void {
    this.gatewayExchanges.labels(result).inc();
  }

  recordWorkerCommand(command: string, result: WorkerCommandResult, seconds: number): void {
    this.workerCommands.labels(command, result).inc();
    this.workerCommandDuration.labels(command).observe(Math.max(0, seconds));
  }

  /** Error codes come from Workers; only the first few distinct well-formed ones get a series. */
  recordWorkerCommandError(command: string, code: string): void {
    let label = "other";
    if (ERROR_CODE.test(code) && (this.#errorCodes.has(code) || this.#errorCodes.size < MAX_ERROR_CODES)) {
      this.#errorCodes.add(code);
      label = code;
    }
    this.workerCommandErrors.labels(command, label).inc();
  }

  recordHeartbeat(workerId: string, result: "accepted" | "rejected"): void {
    this.workerHeartbeats.labels(workerId, result).inc();
  }

  recordLogin(protocol: LoginProtocol, result: LoginResult): void {
    this.logins.labels(protocol, result).inc();
  }

  recordLoginFailure(protocol: LoginProtocol, category: string): void {
    this.logins.labels(protocol, "failure").inc();
    this.loginFailures.labels(protocol, category).inc();
  }

  recordLockout(scope: string): void {
    this.lockouts.labels(scope).inc();
  }

  recordRateLimited(endpoint: RateLimitedEndpoint, protocol: LoginProtocol): void {
    this.rateLimited.labels(endpoint).inc();
    if (endpoint !== "sso_start") this.logins.labels(protocol, "rate_limited").inc();
  }

  recordModelGatewayRequest(operation: ModelGatewayOperation, result: ModelGatewayResult): void {
    this.modelGatewayRequests.labels(operation, result).inc();
    this.modelGatewayReachable.set(result === "unreachable" ? 0 : 1);
  }

  recordBackgroundFailure(task: BackgroundTask): void {
    this.backgroundFailures.labels(task).inc();
  }
}
