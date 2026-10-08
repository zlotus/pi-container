import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { EgressPolicyRecord, EgressRuleRecord } from "@agent-runtime/database";
import {
  canonicalIpv4Cidr,
  cidrTextInterval,
  EGRESS_DEFAULT_DENY_V4,
  EGRESS_MAX_ENTRIES,
  type EgressPolicy,
  intervalCovered,
  intervalsOverlap,
} from "@agent-runtime/protocol";

/**
 * Control Plane-known platform addresses that no whitelist entry may open (specs.md
 * Phase 14.3): explicit PLATFORM_EGRESS_PROTECTED entries plus the IPv4 addresses of
 * the DATABASE_URL host. Workers add their own Control Plane address on top.
 */
export function protectedAddressResolver(
  explicit: readonly string[],
  databaseUrl: string,
  resolveHost: (hostname: string) => Promise<string[]> = async (hostname) =>
    (await lookup(hostname, { all: true, family: 4 })).map((entry) => entry.address),
  /** Further platform services, e.g. the model gateway (specs.md Phase 16.4). */
  additionalUrls: readonly string[] = [],
): () => Promise<string[]> {
  return async () => {
    const addresses: string[] = [];
    for (const url of [databaseUrl, ...additionalUrls]) {
      let hostname: string;
      try {
        hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
      } catch {
        hostname = "";
      }
      if (isIP(hostname) === 4) {
        addresses.push(hostname);
      } else if (hostname !== "" && isIP(hostname) === 0) {
        try {
          addresses.push(...(await resolveHost(hostname)));
        } catch {
          // An unresolvable name protects nothing; the explicit list still applies.
        }
      }
    }
    const cidrs = addresses
      .map((address) => canonicalIpv4Cidr(address))
      .filter((cidr): cidr is string => cidr !== null && !cidr.startsWith("127."));
    return [...new Set([...explicit, ...cidrs])].sort();
  };
}

/**
 * Validates a complete candidate rule set. Returns an API error code or null.
 * Allow entries must open something that is otherwise denied, and must never touch a
 * protected platform address (the Worker's rule order also guarantees that).
 */
export function validateEgressRules(
  rules: readonly EgressRuleRecord[],
  protectedCidrs: readonly string[],
): string | null {
  const allow = rules.filter((rule) => rule.action === "allow");
  const deny = rules.filter((rule) => rule.action === "deny");
  if (allow.length > EGRESS_MAX_ENTRIES || deny.length > EGRESS_MAX_ENTRIES) {
    return "EGRESS_RULE_LIMIT";
  }
  const denied = [...EGRESS_DEFAULT_DENY_V4, ...deny.map((rule) => rule.network)].map(
    cidrTextInterval,
  );
  const protectedIntervals = protectedCidrs.map(cidrTextInterval);
  for (const rule of allow) {
    const network = cidrTextInterval(rule.network);
    if (!intervalCovered(network, denied)) return "EGRESS_ALLOW_OUTSIDE_DENY";
    if (protectedIntervals.some((candidate) => intervalsOverlap(candidate, network))) {
      return "EGRESS_ALLOW_OVERLAPS_PROTECTED";
    }
  }
  return null;
}

export function egressPolicyForWorkers(
  record: EgressPolicyRecord,
  protectedCidrs: readonly string[],
): EgressPolicy {
  return {
    revision: record.revision,
    allow: record.rules
      .filter((rule) => rule.action === "allow")
      .map((rule) => ({
        network: rule.network,
        ...(rule.protocol === null ? {} : { protocol: rule.protocol }),
        ...(rule.portMin === null || rule.portMax === null
          ? {}
          : { portMin: rule.portMin, portMax: rule.portMax }),
      })),
    denyExtra: record.rules.filter((rule) => rule.action === "deny").map((rule) => rule.network),
    protected: [...protectedCidrs],
  };
}
