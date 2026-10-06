import { z } from "zod";

/** RFC1918 ranges every Worker denies by default (specs.md section 44). */
export const EGRESS_DEFAULT_DENY_V4 = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;

/** Upper bound for each policy list, shared by the Control Plane API and the protocol. */
export const EGRESS_MAX_ENTRIES = 1_000;

/** Inclusive IPv4 address interval as unsigned 32-bit integers. */
export interface Ipv4Interval {
  start: number;
  end: number;
}

export interface Ipv4Cidr {
  address: number;
  prefix: number;
}

const OCTET = /^(?:0|[1-9]\d{0,2})$/;

/** Parses a strict dotted-quad IPv4 address (no leading zeros, no shorthand). */
export function parseIpv4Address(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

export function formatIpv4Address(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

function prefixSize(prefix: number): number {
  return 2 ** (32 - prefix);
}

/**
 * Parses `a.b.c.d/n`, or a bare address as `/32`. Host bits must be zero so that the
 * stored rule always means exactly what an administrator reads.
 */
export function parseIpv4Cidr(text: string): Ipv4Cidr | null {
  const slash = text.indexOf("/");
  const addressText = slash === -1 ? text : text.slice(0, slash);
  const prefixText = slash === -1 ? "32" : text.slice(slash + 1);
  if (!/^(?:0|[1-9]\d?)$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > 32) return null;
  const address = parseIpv4Address(addressText);
  if (address === null || address % prefixSize(prefix) !== 0) return null;
  return { address, prefix };
}

export function formatIpv4Cidr(cidr: Ipv4Cidr): string {
  return `${formatIpv4Address(cidr.address)}/${cidr.prefix}`;
}

/** Normalizes an accepted CIDR or bare address to canonical `a.b.c.d/n`. */
export function canonicalIpv4Cidr(text: string): string | null {
  const parsed = parseIpv4Cidr(text);
  return parsed === null ? null : formatIpv4Cidr(parsed);
}

export function cidrInterval(cidr: Ipv4Cidr): Ipv4Interval {
  return { start: cidr.address, end: cidr.address + prefixSize(cidr.prefix) - 1 };
}

/** Parses a canonical CIDR known to be valid (schema-validated input). */
export function cidrTextInterval(text: string): Ipv4Interval {
  const parsed = parseIpv4Cidr(text);
  if (parsed === null) throw new Error("invalid IPv4 CIDR");
  return cidrInterval(parsed);
}

/** Sorts and merges overlapping or adjacent intervals into a disjoint list. */
export function mergeIntervals(intervals: readonly Ipv4Interval[]): Ipv4Interval[] {
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  const merged: Ipv4Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && interval.start <= last.end + 1) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** Splits an interval into the minimal list of aligned CIDR blocks. */
export function intervalToCidrs(interval: Ipv4Interval): Ipv4Cidr[] {
  const blocks: Ipv4Cidr[] = [];
  let start = interval.start;
  while (start <= interval.end) {
    let prefix = 32;
    while (
      prefix > 0 &&
      start % prefixSize(prefix - 1) === 0 &&
      start + prefixSize(prefix - 1) - 1 <= interval.end
    ) {
      prefix -= 1;
    }
    blocks.push({ address: start, prefix });
    start += prefixSize(prefix);
  }
  return blocks;
}

/** True when `inner` lies entirely inside the union of `outer`. */
export function intervalCovered(
  inner: Ipv4Interval,
  outer: readonly Ipv4Interval[],
): boolean {
  return mergeIntervals(outer).some(
    (candidate) => candidate.start <= inner.start && inner.end <= candidate.end,
  );
}

export function intervalsOverlap(left: Ipv4Interval, right: Ipv4Interval): boolean {
  return left.start <= right.end && right.start <= left.end;
}

/** Canonical IPv4 CIDR (`a.b.c.d/n`, host bits zero). */
export const Ipv4CidrSchema = z
  .string()
  .max(18)
  .refine(
    (value) => value.includes("/") && canonicalIpv4Cidr(value) === value,
    "must be a canonical IPv4 CIDR",
  );

export const EgressProtocolSchema = z.enum(["tcp", "udp"]);

/**
 * One whitelist entry: a network, optionally narrowed to a protocol and an inclusive
 * port range. A protocol without ports means every port of that protocol.
 */
export const EgressAllowEntrySchema = z
  .object({
    network: Ipv4CidrSchema,
    protocol: EgressProtocolSchema.optional(),
    portMin: z.number().int().min(1).max(65_535).optional(),
    portMax: z.number().int().min(1).max(65_535).optional(),
  })
  .strict()
  .refine(
    (entry) => (entry.portMin === undefined) === (entry.portMax === undefined),
    "portMin and portMax must be set together",
  )
  .refine(
    (entry) => entry.portMin === undefined || entry.protocol !== undefined,
    "ports require a protocol",
  )
  .refine(
    (entry) =>
      entry.portMin === undefined ||
      entry.portMax === undefined ||
      entry.portMin <= entry.portMax,
    "portMin must not exceed portMax",
  );

/** The Control Plane's egress policy for every Worker; revision orders updates. */
export const EgressPolicySchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    allow: z.array(EgressAllowEntrySchema).max(EGRESS_MAX_ENTRIES),
    denyExtra: z.array(Ipv4CidrSchema).max(EGRESS_MAX_ENTRIES),
    protected: z.array(Ipv4CidrSchema).max(EGRESS_MAX_ENTRIES),
  })
  .strict();

/** What a Worker reports about its local egress rules. */
export const WorkerEgressStatusSchema = z
  .object({
    enforced: z.boolean(),
    revision: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();

export type EgressAllowEntry = z.infer<typeof EgressAllowEntrySchema>;
export type EgressPolicy = z.infer<typeof EgressPolicySchema>;
export type EgressProtocol = z.infer<typeof EgressProtocolSchema>;
export type WorkerEgressStatus = z.infer<typeof WorkerEgressStatusSchema>;

/**
 * Parses a comma-separated list of IPv4 addresses or CIDRs (configuration input) into
 * canonical CIDRs; returns the first invalid entry instead when there is one.
 */
export function parseIpv4CidrList(
  text: string,
): { ok: true; cidrs: string[] } | { ok: false; invalid: string } {
  const cidrs: string[] = [];
  for (const entry of text.split(",").map((value) => value.trim())) {
    if (entry === "") continue;
    const cidr = canonicalIpv4Cidr(entry);
    if (cidr === null) return { ok: false, invalid: entry };
    cidrs.push(cidr);
  }
  return { ok: true, cidrs: [...new Set(cidrs)] };
}

/** Zod schema for such a configuration variable (empty by default). */
export const Ipv4CidrListConfigSchema = z
  .string()
  .default("")
  .transform((value, context) => {
    const parsed = parseIpv4CidrList(value);
    if (!parsed.ok) {
      context.addIssue({
        code: "custom",
        message: `not an IPv4 address or CIDR with zero host bits: ${parsed.invalid}`,
      });
      return z.NEVER;
    }
    return parsed.cidrs;
  });
