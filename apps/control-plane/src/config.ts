import { parseWorkspaceBaseUrl } from "@agent-runtime/gateway";
import { WorkerIdSchema, WorkerTokenSchema } from "@agent-runtime/protocol";
import { z } from "zod";

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

export const ServerConfigSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
    GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    PORTAL_ORIGIN: PortalOriginSchema.default("http://127.0.0.1:5173"),
    PORTAL_ALLOWED_ORIGINS: PortalAllowedOriginsSchema,
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
