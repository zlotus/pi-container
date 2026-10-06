import {
  cidrTextInterval,
  EGRESS_DEFAULT_DENY_V4,
  formatIpv4Address,
  type EgressPolicy,
  type EgressProtocol,
  intervalToCidrs,
  type Ipv4Interval,
  mergeIntervals,
  parseIpv4Address,
  parseIpv4Cidr,
} from "@agent-runtime/protocol";

/**
 * The platform-owned nftables table (specs.md Phase 14.3). It never touches Docker's
 * tables: a drop in any table on a hook is final, so these rules hold regardless of
 * how Docker, Tailscale or anything else manages its own netfilter state.
 */
export const EGRESS_TABLE_FAMILY = "inet";
export const EGRESS_TABLE_NAME = "agent_runtime";

/** Every managed Workspace bridge is named `arw-<11 hex>` (agent-runtime workspace). */
export const WORKSPACE_BRIDGE_PREFIX = "arw-";
const WORKSPACE_BRIDGE_PATTERN = `${WORKSPACE_BRIDGE_PREFIX}*`;

export function workspaceBridgeName(workspaceId: string): string {
  return `${WORKSPACE_BRIDGE_PREFIX}${workspaceId.replaceAll("-", "").slice(0, 11)}`;
}

interface ServiceEntry {
  network: Ipv4Interval;
  protocol: EgressProtocol;
  portMin: number;
  portMax: number;
}

/** The fully resolved rule content one Worker enforces. */
export interface EffectiveEgressRules {
  protected: Ipv4Interval[];
  allowNet: Ipv4Interval[];
  allowService: ServiceEntry[];
  denyExtra: Ipv4Interval[];
}

export function effectiveEgressRules(
  policy: EgressPolicy | null,
  localProtected: readonly string[],
): EffectiveEgressRules {
  const allowNet: Ipv4Interval[] = [];
  const allowService = new Map<string, ServiceEntry>();
  for (const entry of policy?.allow ?? []) {
    const network = cidrTextInterval(entry.network);
    if (entry.protocol === undefined) {
      allowNet.push(network);
      continue;
    }
    const service = {
      network,
      protocol: entry.protocol,
      portMin: entry.portMin ?? 1,
      portMax: entry.portMax ?? 65_535,
    };
    allowService.set(serviceKey(service), service);
  }
  return {
    protected: mergeIntervals(
      [...(policy?.protected ?? []), ...localProtected].map(cidrTextInterval),
    ),
    allowNet: mergeIntervals(allowNet),
    allowService: [...allowService.values()].sort((left, right) =>
      serviceKey(left).localeCompare(serviceKey(right)),
    ),
    denyExtra: mergeIntervals((policy?.denyExtra ?? []).map(cidrTextInterval)),
  };
}

function serviceKey(entry: ServiceEntry): string {
  return [
    entry.network.start.toString(16).padStart(8, "0"),
    entry.network.end.toString(16).padStart(8, "0"),
    entry.protocol,
    entry.portMin,
    entry.portMax,
  ].join("|");
}

// ---------------------------------------------------------------------------
// Rendering (libnftables JSON)

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const table = { family: EGRESS_TABLE_FAMILY, table: EGRESS_TABLE_NAME };

const SINGLE_SETS = [
  "deny_default_v4",
  "deny_extra_v4",
  "protected_v4",
  "allow_net_v4",
] as const;
const SERVICE_SET = "allow_svc_v4";

interface ChainSpec {
  name: string;
  hook: string;
  prio: number;
  rules: Json[][];
}

function match(op: "==" | "!=", left: Json, right: Json): Json {
  return { match: { op, left, right } };
}

const daddr: Json = { payload: { protocol: "ip", field: "daddr" } };

const workspaceTrafficOnly: Json[] = [
  match("!=", { meta: { key: "iifname" } }, WORKSPACE_BRIDGE_PATTERN),
  { return: null },
];
const repliesPass: Json[] = [
  match("==", { ct: { key: "direction" } }, "reply"),
  { accept: null },
];
const ipv6Dropped: Json[] = [
  match("==", { meta: { key: "nfproto" } }, "ipv6"),
  { drop: null },
];

/** Chains in the exact form `nft -j list` prints them, so verification can compare. */
const CHAINS: readonly ChainSpec[] = [
  {
    // After conntrack, before Docker's DNAT: any address of the Worker host itself,
    // including published ports that would be rewritten to another container.
    name: "ws_prerouting",
    hook: "prerouting",
    prio: -150,
    rules: [
      workspaceTrafficOnly,
      repliesPass,
      ipv6Dropped,
      [
        match(
          "==",
          { fib: { result: "type", flags: ["daddr"] } },
          { set: ["local", "broadcast", "multicast"] },
        ),
        { drop: null },
      ],
    ],
  },
  {
    // Protected platform addresses first, then the whitelist, then the deny ranges.
    name: "ws_forward",
    hook: "forward",
    prio: -10,
    rules: [
      workspaceTrafficOnly,
      repliesPass,
      ipv6Dropped,
      [match("==", daddr, "@protected_v4"), { drop: null }],
      [
        match(
          "==",
          {
            concat: [
              daddr,
              { meta: { key: "l4proto" } },
              { payload: { protocol: "th", field: "dport" } },
            ],
          },
          `@${SERVICE_SET}`,
        ),
        { accept: null },
      ],
      [match("==", daddr, "@allow_net_v4"), { accept: null }],
      [match("==", daddr, "@deny_default_v4"), { drop: null }],
      [match("==", daddr, "@deny_extra_v4"), { drop: null }],
    ],
  },
];

function prefixElements(intervals: readonly Ipv4Interval[]): Json[] {
  return intervals.flatMap((interval) =>
    intervalToCidrs(interval).map((cidr) => ({
      prefix: { addr: formatIpv4Address(cidr.address), len: cidr.prefix },
    })),
  );
}

function serviceElements(entries: readonly ServiceEntry[]): Json[] {
  return entries.flatMap((entry) =>
    intervalToCidrs(entry.network).map((cidr) => ({
      concat: [
        { prefix: { addr: formatIpv4Address(cidr.address), len: cidr.prefix } },
        entry.protocol,
        { range: [entry.portMin, entry.portMax] },
      ],
    })),
  );
}

function singleSetElements(rules: EffectiveEgressRules): Record<(typeof SINGLE_SETS)[number], Ipv4Interval[]> {
  return {
    deny_default_v4: mergeIntervals(EGRESS_DEFAULT_DENY_V4.map(cidrTextInterval)),
    deny_extra_v4: rules.denyExtra,
    protected_v4: rules.protected,
    allow_net_v4: rules.allowNet,
  };
}

/**
 * One atomic transaction that replaces the whole table: `add` makes the following
 * `delete` safe when the table is absent, and packets never see a partial state.
 */
export function renderEgressTransaction(rules: EffectiveEgressRules): { nftables: Json[] } {
  const commands: Json[] = [
    { add: { table: { family: EGRESS_TABLE_FAMILY, name: EGRESS_TABLE_NAME } } },
    { delete: { table: { family: EGRESS_TABLE_FAMILY, name: EGRESS_TABLE_NAME } } },
    { add: { table: { family: EGRESS_TABLE_FAMILY, name: EGRESS_TABLE_NAME } } },
  ];
  const singles = singleSetElements(rules);
  for (const name of SINGLE_SETS) {
    const elements = prefixElements(singles[name]);
    commands.push({
      add: {
        set: {
          ...table,
          name,
          type: "ipv4_addr",
          flags: ["interval"],
          ...(elements.length === 0 ? {} : { elem: elements }),
        },
      },
    });
  }
  const services = serviceElements(rules.allowService);
  commands.push({
    add: {
      set: {
        ...table,
        name: SERVICE_SET,
        type: ["ipv4_addr", "inet_proto", "inet_service"],
        flags: ["interval"],
        ...(services.length === 0 ? {} : { elem: services }),
      },
    },
  });
  for (const chain of CHAINS) {
    commands.push({
      add: {
        chain: {
          ...table,
          name: chain.name,
          type: "filter",
          hook: chain.hook,
          prio: chain.prio,
          policy: "accept",
        },
      },
    });
    for (const expr of chain.rules) {
      commands.push({ add: { rule: { ...table, chain: chain.name, expr } } });
    }
  }
  return { nftables: commands };
}

// ---------------------------------------------------------------------------
// Verification against `nft -j list table inet agent_runtime`

export type EgressVerification = { ok: true } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => key in right && deepEqual(left[key], right[key]))
    );
  }
  return left === right;
}

function addressInterval(value: unknown): Ipv4Interval | null {
  if (typeof value === "string") {
    const address = parseIpv4Address(value);
    return address === null ? null : { start: address, end: address };
  }
  if (!isRecord(value)) return null;
  const prefix = value.prefix;
  if (isRecord(prefix) && typeof prefix.addr === "string" && typeof prefix.len === "number") {
    const parsed = parseIpv4Cidr(`${prefix.addr}/${prefix.len}`);
    return parsed === null
      ? null
      : { start: parsed.address, end: parsed.address + 2 ** (32 - parsed.prefix) - 1 };
  }
  const range = value.range;
  if (Array.isArray(range) && range.length === 2) {
    const start = typeof range[0] === "string" ? parseIpv4Address(range[0]) : null;
    const end = typeof range[1] === "string" ? parseIpv4Address(range[1]) : null;
    return start === null || end === null || start > end ? null : { start, end };
  }
  return null;
}

function portRange(value: unknown): [number, number] | null {
  if (typeof value === "number") return [value, value];
  if (isRecord(value) && Array.isArray(value.range) && value.range.length === 2) {
    const [start, end] = value.range;
    return typeof start === "number" && typeof end === "number" ? [start, end] : null;
  }
  return null;
}

function elementList(set: Record<string, unknown>): unknown[] {
  const elements = set.elem;
  if (elements === undefined) return [];
  return Array.isArray(elements) ? elements : [elements];
}

function canonicalSingle(elements: unknown[]): string | null {
  const intervals: Ipv4Interval[] = [];
  for (const element of elements) {
    const interval = addressInterval(element);
    if (interval === null) return null;
    intervals.push(interval);
  }
  return JSON.stringify(mergeIntervals(intervals));
}

function canonicalServices(elements: unknown[]): string | null {
  const keys = new Set<string>();
  for (const element of elements) {
    if (!isRecord(element) || !Array.isArray(element.concat) || element.concat.length !== 3) {
      return null;
    }
    const [address, protocol, ports] = element.concat;
    const network = addressInterval(address);
    const range = portRange(ports);
    if (network === null || range === null || (protocol !== "tcp" && protocol !== "udp")) {
      return null;
    }
    keys.add(`${network.start}-${network.end}|${protocol}|${range[0]}-${range[1]}`);
  }
  return JSON.stringify([...keys].sort());
}

/** Compares a table listing with the rules this Worker must enforce. */
export function verifyEgressListing(
  listing: unknown,
  rules: EffectiveEgressRules,
): EgressVerification {
  if (!isRecord(listing) || !Array.isArray(listing.nftables)) {
    return { ok: false, reason: "listing is not nftables JSON" };
  }
  const tables: Record<string, unknown>[] = [];
  const chains = new Map<string, Record<string, unknown>>();
  const rulesByChain = new Map<string, unknown[]>();
  const sets = new Map<string, Record<string, unknown>>();
  for (const entry of listing.nftables) {
    if (!isRecord(entry)) return { ok: false, reason: "unexpected listing entry" };
    if ("metainfo" in entry) continue;
    const [kind, value] = Object.entries(entry)[0] ?? [];
    if (!isRecord(value)) return { ok: false, reason: "unexpected listing entry" };
    const inTable =
      kind === "table"
        ? value.family === EGRESS_TABLE_FAMILY && value.name === EGRESS_TABLE_NAME
        : value.family === EGRESS_TABLE_FAMILY && value.table === EGRESS_TABLE_NAME;
    if (!inTable) return { ok: false, reason: `object outside the egress table: ${kind}` };
    if (kind === "table") tables.push(value);
    else if (kind === "chain" && typeof value.name === "string") chains.set(value.name, value);
    else if (kind === "set" && typeof value.name === "string") sets.set(value.name, value);
    else if (kind === "rule" && typeof value.chain === "string") {
      rulesByChain.set(value.chain, [...(rulesByChain.get(value.chain) ?? []), value.expr]);
    } else return { ok: false, reason: `unexpected object in egress table: ${String(kind)}` };
  }
  if (tables.length !== 1) return { ok: false, reason: "egress table is missing" };

  if (chains.size !== CHAINS.length) return { ok: false, reason: "unexpected chain count" };
  for (const expected of CHAINS) {
    const chain = chains.get(expected.name);
    if (
      chain === undefined ||
      chain.type !== "filter" ||
      chain.hook !== expected.hook ||
      chain.prio !== expected.prio ||
      chain.policy !== "accept"
    ) {
      return { ok: false, reason: `chain ${expected.name} does not match` };
    }
    if (!deepEqual(rulesByChain.get(expected.name) ?? [], expected.rules)) {
      return { ok: false, reason: `rules of ${expected.name} do not match` };
    }
  }
  if ([...rulesByChain.keys()].some((name) => !chains.has(name))) {
    return { ok: false, reason: "rule in an unknown chain" };
  }

  if (sets.size !== SINGLE_SETS.length + 1) return { ok: false, reason: "unexpected set count" };
  const singles = singleSetElements(rules);
  for (const name of SINGLE_SETS) {
    const set = sets.get(name);
    if (set === undefined || set.type !== "ipv4_addr" || !deepEqual(set.flags, ["interval"])) {
      return { ok: false, reason: `set ${name} does not match` };
    }
    if (canonicalSingle(elementList(set)) !== JSON.stringify(singles[name])) {
      return { ok: false, reason: `elements of ${name} do not match` };
    }
  }
  const services = sets.get(SERVICE_SET);
  if (
    services === undefined ||
    !deepEqual(services.type, ["ipv4_addr", "inet_proto", "inet_service"]) ||
    !deepEqual(services.flags, ["interval"])
  ) {
    return { ok: false, reason: `set ${SERVICE_SET} does not match` };
  }
  const expectedServices = canonicalServices(serviceElements(rules.allowService));
  if (canonicalServices(elementList(services)) !== expectedServices) {
    return { ok: false, reason: `elements of ${SERVICE_SET} do not match` };
  }
  return { ok: true };
}
