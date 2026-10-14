import { parseWorkspaceBaseUrl } from "@agent-runtime/gateway";
import {
  Ipv4CidrListConfigSchema,
  WorkerIdSchema,
  WorkerTokenSchema,
} from "@agent-runtime/protocol";
import { z } from "zod";

import { parseAddressRange } from "./login-guard.js";

function parseHttpOrigin(
  value: string,
  context: z.RefinementCtx,
  variableName: string,
): string | typeof z.NEVER {
  const candidate = value.trim();
  if (candidate.includes("*")) {
    context.addIssue({
      code: "custom",
      message: `${variableName} does not allow wildcard origins`,
    });
    return z.NEVER;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return parsed.origin;
  } catch {
    context.addIssue({
      code: "custom",
      message: `${variableName} must contain HTTP(S) origins`,
    });
    return z.NEVER;
  }
}

const PortalOriginSchema = z.string().transform((value, context) =>
  parseHttpOrigin(value, context, "PORTAL_ORIGIN"),
);

const PortalAllowedOriginsSchema = z
  .string()
  .default("")
  .transform((value, context) => {
    if (value.trim() === "") return [];
    const entries = value.split(",");
    const origins: string[] = [];
    for (const entry of entries) {
      if (entry.trim() === "") {
        context.addIssue({
          code: "custom",
          message: "PORTAL_ALLOWED_ORIGINS must not contain empty entries",
        });
        return z.NEVER;
      }
      const origin = parseHttpOrigin(entry, context, "PORTAL_ALLOWED_ORIGINS");
      if (origin === z.NEVER) return z.NEVER;
      origins.push(origin);
    }
    return [...new Set(origins)];
  });

const WorkerGatewayTokensSchema = z
  .string()
  .default("{}")
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: "custom", message: "Invalid Worker Gateway token JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.record(WorkerIdSchema, WorkerTokenSchema))
  .refine(
    (tokens) => new Set(Object.values(tokens)).size === Object.keys(tokens).length,
    "Each Worker Gateway must use a distinct token",
  );

const OidcIssuerSchema = z
  .string()
  .trim()
  .default("")
  .refine((value) => {
    if (value === "") return true;
    try {
      const url = new URL(value);
      const loopbackHttp =
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return (
        (url.protocol === "https:" || loopbackHttp) &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }, "AUTH_OIDC_ISSUER must use HTTPS (or loopback HTTP) without credentials, query, or fragment");

function parseSecureEndpoint(
  value: string,
  context: z.RefinementCtx,
  variableName: string,
): string | typeof z.NEVER {
  if (value === "") return value;
  try {
    const url = new URL(value);
    const loopbackHttp =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !loopbackHttp) ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new Error("unsafe endpoint");
    }
    return url.href;
  } catch {
    context.addIssue({
      code: "custom",
      message: `${variableName} must use HTTPS (or loopback HTTP) without credentials or fragment`,
    });
    return z.NEVER;
  }
}

function endpointSchema(variableName: string) {
  return z.string().trim().default("").transform((value, context) =>
    parseSecureEndpoint(value, context, variableName),
  );
}

const JsonPathSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]+(?:(?:\.[A-Za-z0-9_-]+)|(?:\[\s*"[A-Za-z0-9_-]+"\s*\]))*$/);

const OptionalJsonPathSchema = z
  .string()
  .trim()
  .default("")
  .refine(
    (value) =>
      value === "" ||
      /^[A-Za-z0-9_-]+(?:(?:\.[A-Za-z0-9_-]+)|(?:\[\s*"[A-Za-z0-9_-]+"\s*\]))*$/.test(
        value,
      ),
    "must be empty or a supported JSON path",
  );

const AllowedDomainsSchema = z
  .string()
  .default("")
  .transform((value, context) => {
    if (value.trim() === "") return [];
    const domains: string[] = [];
    for (const entry of value.split(",")) {
      const candidate = entry.trim().toLowerCase();
      if (candidate === "" || candidate.includes("*")) {
        context.addIssue({ code: "custom", message: "allowed_domains contains an invalid entry" });
        return z.NEVER;
      }
      try {
        const url = new URL(`https://${candidate}`);
        if (
          url.hostname !== candidate ||
          url.port !== "" ||
          url.pathname !== "/" ||
          url.search !== "" ||
          url.hash !== ""
        ) {
          throw new Error("invalid domain");
        }
      } catch {
        context.addIssue({ code: "custom", message: "allowed_domains contains an invalid entry" });
        return z.NEVER;
      }
      domains.push(candidate);
    }
    return [...new Set(domains)];
  });

/** Comma-separated IPv4/IPv6 addresses or CIDRs, e.g. `127.0.0.1/32,::1/128`. */
function addressRangeListSchema(defaultValue: string) {
  return z
    .string()
    .default(defaultValue)
    .transform((value, context) => {
      const entries = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      for (const entry of entries) {
        if (parseAddressRange(entry) === null) {
          context.addIssue({ code: "custom", message: `invalid address range: ${entry}` });
          return z.NEVER;
        }
      }
      return entries;
    });
}

const GIB = 1024 ** 3;

function thresholdSchema(defaultValue: number) {
  return z.coerce.number().int().min(1).max(10_000).default(defaultValue);
}

export const ServerConfigSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
    GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    /** Idle stop (specs.md Phase 18.5): unset = off; whole hours, 1 to 720. */
    IDLE_STOP_AFTER_HOURS: z
      .string()
      .default("")
      .transform((value, context) => {
        if (value === "") return null;
        const hours = Number(value);
        if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
          context.addIssue({ code: "custom", message: "IDLE_STOP_AFTER_HOURS must be a whole number from 1 to 720" });
          return z.NEVER;
        }
        return hours;
      }),
    /** Average CPU (cores) over a 5-minute window that still counts as activity. */
    IDLE_CPU_THRESHOLD_CORES: z.coerce.number().min(0.01).max(1).default(0.05),
    /** Prometheus metrics listener (specs.md Phase 17.7); unset port = no listener. */
    METRICS_HOST: z.string().min(1).default("127.0.0.1"),
    METRICS_PORT: z
      .string()
      .default("")
      .transform((value, context) => {
        if (value === "") return null;
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          context.addIssue({ code: "custom", message: "METRICS_PORT must be a TCP port" });
          return z.NEVER;
        }
        return port;
      }),
    METRICS_TOKEN_FILE: z.string().default(""),
    PORTAL_ORIGIN: PortalOriginSchema.default("http://127.0.0.1:5173"),
    PORTAL_ALLOWED_ORIGINS: PortalAllowedOriginsSchema,
    /** Platform addresses no egress whitelist may open (specs.md Phase 14.3). */
    PLATFORM_EGRESS_PROTECTED: Ipv4CidrListConfigSchema,
    AUTH_OIDC_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    AUTH_OIDC_PROVIDER_ID: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)
      .default("generic-oidc"),
    AUTH_OIDC_ISSUER: OidcIssuerSchema,
    AUTH_OIDC_CLIENT_ID: z.string().trim().default(""),
    AUTH_OIDC_CLIENT_SECRET: z.string().default(""),
    AUTH_OIDC_AUTO_PROVISION: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    AUTH_OIDC_ALLOWED_DOMAINS: AllowedDomainsSchema,
    AUTH_OAUTH2_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    AUTH_OAUTH2_PROVIDER_ID: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)
      .default("generic-oauth2"),
    AUTH_OAUTH2_AUTHORIZATION_URL: endpointSchema("AUTH_OAUTH2_AUTHORIZATION_URL"),
    AUTH_OAUTH2_TOKEN_URL: endpointSchema("AUTH_OAUTH2_TOKEN_URL"),
    AUTH_OAUTH2_USERINFO_URL: endpointSchema("AUTH_OAUTH2_USERINFO_URL"),
    AUTH_OAUTH2_USERINFO_TOKEN_METHOD: z
      .enum(["bearer", "query"])
      .default("bearer"),
    AUTH_OAUTH2_CLIENT_ID: z.string().trim().default(""),
    AUTH_OAUTH2_CLIENT_SECRET: z.string().default(""),
    AUTH_OAUTH2_SCOPE: z.string().trim().default(""),
    AUTH_OAUTH2_SUBJECT_FIELD: JsonPathSchema.default("sub"),
    AUTH_OAUTH2_USERNAME_FIELD: OptionalJsonPathSchema,
    AUTH_OAUTH2_EMAIL_FIELD: OptionalJsonPathSchema,
    AUTH_OAUTH2_DISPLAY_NAME_FIELD: OptionalJsonPathSchema,
    AUTH_OAUTH2_AUTO_PROVISION: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    AUTH_OAUTH2_ALLOWED_DOMAINS: AllowedDomainsSchema,
    SESSION_SECRET: z.string().min(32),
    SESSION_COOKIE_SECURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    SESSION_TTL_HOURS: z.coerce.number().positive().max(720).default(12),
    WORKSPACE_SESSION_EXCHANGE_TTL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(60_000),
    WORKSPACE_BASE_URL: z.string().transform((value, context) => {
      try {
        parseWorkspaceBaseUrl(value);
        return value;
      } catch {
        context.addIssue({
          code: "custom",
          message: "WORKSPACE_BASE_URL must be an HTTP(S) origin",
        });
        return z.NEVER;
      }
    }),
    WORKER_GATEWAY_TOKENS_JSON: WorkerGatewayTokensSchema,
    DEFAULT_RUNTIME_IMAGE: z
      .string()
      .min(1)
      .default("agent-runtime:phase7-toolchain"),
    WORKER_OFFLINE_AFTER_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(35_000),
    WORKER_STATUS_SWEEP_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    WORKER_COMMAND_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(300_000)
      .default(15_000),
    WORKSPACE_CPU_COUNT: z.coerce.number().positive().max(256).default(2),
    WORKSPACE_MEMORY_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(4 * 1024 ** 3),
    WORKSPACE_PIDS_LIMIT: z.coerce.number().int().positive().default(512),
    /** Data-project limit given to new Workspaces (specs.md Phase 15.7). */
    WORKSPACE_DISK_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(GIB)
      .max(2 ** 50)
      .default(20 * GIB),
    /** The most an administrator may give one Workspace. */
    WORKSPACE_DISK_LIMIT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(GIB)
      .max(2 ** 50)
      .default(1024 * GIB),
    /** Reverse proxies whose X-Forwarded-For is believed; empty = the TCP peer is the client. */
    AUTH_TRUSTED_PROXIES: addressRangeListSchema(""),
    /** Management networks exempt from the account-wide lock (break-glass). */
    AUTH_TRUSTED_NETWORKS: addressRangeListSchema("127.0.0.1/32,::1/128"),
    AUTH_LOCKOUT_ACCOUNT_IP_THRESHOLD: thresholdSchema(5),
    AUTH_LOCKOUT_IP_THRESHOLD: thresholdSchema(20),
    AUTH_LOCKOUT_ACCOUNT_THRESHOLD: thresholdSchema(50),
    AUTH_SSO_START_LIMIT: thresholdSchema(30),
    /** LiteLLM admin origin; empty disables platform model access (specs.md Phase 16). */
    MODEL_GATEWAY_ADMIN_URL: endpointSchema("MODEL_GATEWAY_ADMIN_URL"),
    MODEL_GATEWAY_MASTER_KEY: z.string().default(""),
    MODEL_GATEWAY_CATALOG_FILE: z.string().trim().default(""),
    /** Default per-user budget in USD per budget period; empty means unlimited. */
    MODEL_GATEWAY_USER_BUDGET_USD: z
      .string()
      .trim()
      .default("")
      .transform((value, context) => {
        if (value === "") return null;
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) {
          context.addIssue({ code: "custom", message: "MODEL_GATEWAY_USER_BUDGET_USD must be 0..1000000" });
          return z.NEVER;
        }
        return amount;
      }),
    MODEL_GATEWAY_BUDGET_DURATION: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{0,3}[smhd]$/)
      .default("30d"),
    MODEL_GATEWAY_KEY_RPM: z.coerce.number().int().min(1).max(100_000).default(60),
    MODEL_GATEWAY_KEY_TPM: z
      .string()
      .trim()
      .default("")
      .transform((value, context) => {
        if (value === "") return null;
        const amount = Number(value);
        if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000_000) {
          context.addIssue({ code: "custom", message: "MODEL_GATEWAY_KEY_TPM must be a positive integer" });
          return z.NEVER;
        }
        return amount;
      }),
  })
  .passthrough()
  .superRefine((config, context) => {
    if (config.AUTH_OIDC_AUTO_PROVISION && !config.AUTH_OIDC_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_OIDC_AUTO_PROVISION"],
        message: "AUTH_OIDC_AUTO_PROVISION requires AUTH_OIDC_ENABLED=true",
      });
    }
    if (config.AUTH_OIDC_ENABLED) {
      for (const key of [
        "AUTH_OIDC_ISSUER",
        "AUTH_OIDC_CLIENT_ID",
        "AUTH_OIDC_CLIENT_SECRET",
      ] as const) {
        if (config[key] === "") {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when AUTH_OIDC_ENABLED=true`,
          });
        }
      }
    }
    if (config.AUTH_OAUTH2_AUTO_PROVISION && !config.AUTH_OAUTH2_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_OAUTH2_AUTO_PROVISION"],
        message: "AUTH_OAUTH2_AUTO_PROVISION requires AUTH_OAUTH2_ENABLED=true",
      });
    }
    if (config.AUTH_OAUTH2_ENABLED) {
      for (const key of [
        "AUTH_OAUTH2_AUTHORIZATION_URL",
        "AUTH_OAUTH2_TOKEN_URL",
        "AUTH_OAUTH2_USERINFO_URL",
        "AUTH_OAUTH2_CLIENT_ID",
        "AUTH_OAUTH2_CLIENT_SECRET",
        "AUTH_OAUTH2_SUBJECT_FIELD",
      ] as const) {
        if (config[key] === "") {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when AUTH_OAUTH2_ENABLED=true`,
          });
        }
      }
    }
    if (config.METRICS_PORT === null) {
      if (config.METRICS_TOKEN_FILE !== "") {
        context.addIssue({
          code: "custom",
          path: ["METRICS_TOKEN_FILE"],
          message: "METRICS_TOKEN_FILE requires METRICS_PORT",
        });
      }
    } else if (!config.METRICS_TOKEN_FILE.startsWith("/")) {
      context.addIssue({
        code: "custom",
        path: ["METRICS_TOKEN_FILE"],
        message: "METRICS_PORT requires METRICS_TOKEN_FILE (an absolute path); metrics are never unauthenticated",
      });
    }
    if (config.WORKSPACE_DISK_LIMIT_BYTES > config.WORKSPACE_DISK_LIMIT_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["WORKSPACE_DISK_LIMIT_BYTES"],
        message: "WORKSPACE_DISK_LIMIT_BYTES cannot exceed WORKSPACE_DISK_LIMIT_MAX_BYTES",
      });
    }
    if (config.MODEL_GATEWAY_ADMIN_URL === "") {
      for (const key of ["MODEL_GATEWAY_MASTER_KEY", "MODEL_GATEWAY_CATALOG_FILE"] as const) {
        if (config[key] !== "") {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} requires MODEL_GATEWAY_ADMIN_URL`,
          });
        }
      }
    } else {
      if (!/^sk-[\x21-\x7e]{13,509}$/.test(config.MODEL_GATEWAY_MASTER_KEY)) {
        context.addIssue({
          code: "custom",
          path: ["MODEL_GATEWAY_MASTER_KEY"],
          message: "MODEL_GATEWAY_MASTER_KEY must be the LiteLLM master key (sk-...)",
        });
      }
      if (!config.MODEL_GATEWAY_CATALOG_FILE.startsWith("/")) {
        context.addIssue({
          code: "custom",
          path: ["MODEL_GATEWAY_CATALOG_FILE"],
          message: "MODEL_GATEWAY_CATALOG_FILE must be an absolute path",
        });
      }
    }
    if (
      config.AUTH_OIDC_ENABLED &&
      config.AUTH_OAUTH2_ENABLED &&
      config.AUTH_OIDC_PROVIDER_ID === config.AUTH_OAUTH2_PROVIDER_ID
    ) {
      for (const key of ["AUTH_OIDC_PROVIDER_ID", "AUTH_OAUTH2_PROVIDER_ID"] as const) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "External authentication provider IDs must be distinct",
        });
      }
    }
  });

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function parseServerConfig(environment: Record<string, string | undefined>): ServerConfig {
  return ServerConfigSchema.parse(environment);
}
