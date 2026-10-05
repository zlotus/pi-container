import { execFile } from "node:child_process";

import type { Logger } from "@agent-runtime/logging";

/** Read-only `ip -j` queries; no root required. */
export type IpJsonReader = (args: readonly string[]) => Promise<unknown>;

export const execIpJson: IpJsonReader = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "ip",
      ["-j", ...args],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch (parseError) {
          reject(parseError instanceof Error ? parseError : new Error("invalid ip output"));
        }
      },
    );
  });

export interface EgressEnvironmentFindings {
  /** TUN devices that carry a default route in a policy-routing table (e.g. Clash TUN). */
  tunDefaultRoutes: Array<{ device: string; table: string }>;
  /** Tailscale interfaces present on the host. */
  tailscaleInterfaces: string[];
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];
}

/**
 * Development-environment hints (specs.md Phase 14.8). The findings never change whether
 * egress is enforced; they explain what the egress rules cannot see on such a host.
 */
export async function inspectEgressEnvironment(
  readIpJson: IpJsonReader = execIpJson,
): Promise<EgressEnvironmentFindings> {
  const [links, routes] = await Promise.all([
    readIpJson(["-d", "link", "show"]),
    readIpJson(["route", "show", "table", "all"]),
  ]);
  const tunDevices = new Set<string>();
  const tailscaleInterfaces: string[] = [];
  for (const link of records(links)) {
    const name = link.ifname;
    if (typeof name !== "string") continue;
    if (name.startsWith("tailscale")) {
      tailscaleInterfaces.push(name);
      continue;
    }
    const info = link.linkinfo;
    if (
      typeof info === "object" &&
      info !== null &&
      (info as Record<string, unknown>).info_kind === "tun"
    ) {
      tunDevices.add(name);
    }
  }
  const tunDefaultRoutes = records(routes)
    .filter(
      (route) =>
        route.dst === "default" &&
        typeof route.dev === "string" &&
        tunDevices.has(route.dev) &&
        typeof route.table === "string" &&
        !["main", "local", "default"].includes(route.table),
    )
    .map((route) => ({ device: String(route.dev), table: String(route.table) }));
  const unique = new Map(tunDefaultRoutes.map((entry) => [`${entry.device}/${entry.table}`, entry]));
  return { tunDefaultRoutes: [...unique.values()], tailscaleInterfaces: tailscaleInterfaces.sort() };
}

export async function logEgressEnvironment(
  log: Pick<Logger, "info" | "warn">,
  readIpJson: IpJsonReader = execIpJson,
): Promise<void> {
  let findings: EgressEnvironmentFindings;
  try {
    findings = await inspectEgressEnvironment(readIpJson);
  } catch {
    return;
  }
  for (const route of findings.tunDefaultRoutes) {
    log.warn(
      route,
      "default route through a TUN device in a policy-routing table: destinations reached by " +
        "domain name may be connected by a user-space proxy on this host, outside the Workspace " +
        "egress rules (development hosts only; see specs.md Phase 14.8)",
    );
  }
  if (findings.tailscaleInterfaces.length > 0) {
    log.info(
      { interfaces: findings.tailscaleInterfaces },
      "Tailscale detected: 100.64.0.0/10 is not denied by default; add it as an egress deny " +
        "range if Workspaces must not reach the tailnet",
    );
  }
}
