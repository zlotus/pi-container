import { describe, expect, it } from "vitest";

import {
  effectiveEgressRules,
  renderEgressTransaction,
  verifyEgressListing,
  workspaceBridgeName,
} from "./ruleset.js";
import { listingFromTransaction } from "./test-support.js";

const POLICY = {
  revision: 3,
  allow: [
    { network: "192.168.1.1/32", protocol: "tcp" as const, portMin: 80, portMax: 80 },
    { network: "10.20.0.0/16" },
    { network: "10.20.1.0/24" },
    { network: "10.30.0.0/16", protocol: "udp" as const },
  ],
  denyExtra: ["100.64.0.0/10", "169.254.0.0/16"],
  protected: ["10.20.5.7/32"],
};

type Listing = { nftables: Array<Record<string, Record<string, unknown>>> };

function listing(): Listing {
  const rules = effectiveEgressRules(POLICY, ["100.112.169.46/32"]);
  return listingFromTransaction(renderEgressTransaction(rules)) as Listing;
}

function verify(value: unknown) {
  return verifyEgressListing(value, effectiveEgressRules(POLICY, ["100.112.169.46/32"]));
}

function rulesOf(value: Listing, chain: string) {
  return value.nftables.filter((entry) => entry.rule?.chain === chain);
}

describe("egress ruleset", () => {
  it("derives a 15-character arw- bridge name from the Workspace id", () => {
    const name = workspaceBridgeName("90b38efc-aa9a-4bc6-8eee-528b4e0c7c60");
    expect(name).toBe("arw-90b38efcaa9");
    expect(name.length).toBeLessThanOrEqual(15);
  });

  it("merges overlapping networks and expands protocol-only entries to every port", () => {
    const rules = effectiveEgressRules(POLICY, ["10.20.5.6/32", "100.112.169.46/32"]);
    expect(rules.allowNet).toEqual([{ start: 0x0a140000, end: 0x0a14ffff }]);
    expect(rules.allowService).toEqual([
      { network: { start: 0x0a1e0000, end: 0x0a1effff }, protocol: "udp", portMin: 1, portMax: 65_535 },
      { network: { start: 0xc0a80101, end: 0xc0a80101 }, protocol: "tcp", portMin: 80, portMax: 80 },
    ]);
    // Adjacent protected addresses merge into one interval; nft rejects overlaps.
    expect(rules.protected).toEqual([
      { start: 0x0a140506, end: 0x0a140507 },
      { start: 0x6470a92e, end: 0x6470a92e },
    ]);
  });

  it("checks protected addresses before the whitelist and the whitelist before the deny ranges", () => {
    const forward = rulesOf(listing(), "ws_forward").map((entry) => JSON.stringify(entry.rule?.expr));
    const position = (needle: string) => forward.findIndex((expr) => expr.includes(needle));
    expect(position("@protected_v4")).toBeLessThan(position("@allow_svc_v4"));
    expect(position("@allow_svc_v4")).toBeLessThan(position("@allow_net_v4"));
    expect(position("@allow_net_v4")).toBeLessThan(position("@deny_default_v4"));
    expect(position("@deny_default_v4")).toBeLessThan(position("@deny_extra_v4"));
  });

  it("drops traffic to every local address of the Worker host before Docker's DNAT", () => {
    const pre = rulesOf(listing(), "ws_prerouting").map((entry) => JSON.stringify(entry.rule?.expr));
    expect(pre.at(-1)).toContain('"fib"');
    expect(pre.at(-1)).toContain('"local"');
    const chain = listing().nftables.find((entry) => entry.chain?.name === "ws_prerouting");
    expect(chain?.chain).toMatchObject({ hook: "prerouting", prio: -150 });
  });

  it("verifies the rendered table", () => {
    expect(verify(listing())).toEqual({ ok: true });
  });

  it("rejects a missing table, a missing rule, reordered rules and changed priorities", () => {
    expect(verify({ nftables: [] })).toMatchObject({ ok: false });

    const missingRule = listing();
    missingRule.nftables.splice(
      missingRule.nftables.findIndex((entry) =>
        JSON.stringify(entry.rule?.expr ?? "").includes("@protected_v4"),
      ),
      1,
    );
    expect(verify(missingRule)).toEqual({ ok: false, reason: "rules of ws_forward do not match" });

    const reordered = listing();
    const indexes = reordered.nftables
      .map((entry, index) => (entry.rule?.chain === "ws_forward" ? index : -1))
      .filter((index) => index >= 0);
    const [first, second] = [indexes[3], indexes[4]] as [number, number];
    [reordered.nftables[first], reordered.nftables[second]] = [
      reordered.nftables[second] as Record<string, Record<string, unknown>>,
      reordered.nftables[first] as Record<string, Record<string, unknown>>,
    ];
    expect(verify(reordered)).toMatchObject({ ok: false });

    const priority = listing();
    const chain = priority.nftables.find((entry) => entry.chain?.name === "ws_forward");
    if (chain?.chain !== undefined) chain.chain.prio = 0;
    expect(verify(priority)).toEqual({ ok: false, reason: "chain ws_forward does not match" });
  });

  it("rejects extra rules, foreign objects and changed set elements", () => {
    const extra = listing();
    extra.nftables.push({
      rule: { family: "inet", table: "agent_runtime", chain: "ws_forward", expr: [{ accept: null }] },
    });
    expect(verify(extra)).toMatchObject({ ok: false });

    const foreign = listing();
    foreign.nftables.push({ chain: { family: "inet", table: "other", name: "x" } });
    expect(verify(foreign)).toMatchObject({ ok: false });

    const widened = listing();
    const allow = widened.nftables.find((entry) => entry.set?.name === "allow_net_v4");
    if (allow?.set !== undefined) allow.set.elem = [{ prefix: { addr: "10.0.0.0", len: 8 } }];
    expect(verify(widened)).toEqual({ ok: false, reason: "elements of allow_net_v4 do not match" });

    const emptied = listing();
    const deny = emptied.nftables.find((entry) => entry.set?.name === "deny_default_v4");
    if (deny?.set !== undefined) delete deny.set.elem;
    expect(verify(emptied)).toEqual({ ok: false, reason: "elements of deny_default_v4 do not match" });
  });

  it("accepts the element forms nft prints back (plain addresses, ranges, single ports)", () => {
    const printed = listing();
    const svc = printed.nftables.find((entry) => entry.set?.name === "allow_svc_v4");
    if (svc?.set !== undefined) {
      svc.set.elem = [
        { concat: [{ prefix: { addr: "10.30.0.0", len: 16 } }, "udp", { range: [1, 65_535] }] },
        { concat: ["192.168.1.1", "tcp", 80] },
      ];
    }
    const protectedSet = printed.nftables.find((entry) => entry.set?.name === "protected_v4");
    if (protectedSet?.set !== undefined) {
      protectedSet.set.elem = ["10.20.5.7", "100.112.169.46"];
    }
    expect(verify(printed)).toEqual({ ok: true });
  });
  describe("model relay exception (Phase 16.4)", () => {
    const relayRules = () => effectiveEgressRules(POLICY, ["100.112.169.46/32"], 3101);
    const relayListing = () => listingFromTransaction(renderEgressTransaction(relayRules())) as Listing;

    it("renders exactly the Phase 14 table when the relay is disabled", () => {
      const names = listing().nftables.flatMap((entry) => (entry.chain ? [entry.chain.name] : []));
      expect(names).toEqual(["ws_prerouting", "ws_forward"]);
    });

    it("accepts only the relay port on host addresses, before the host drop", () => {
      const pre = rulesOf(relayListing(), "ws_prerouting").map((entry) => JSON.stringify(entry.rule?.expr));
      const relay = pre.findIndex((expr) => expr.includes("3101"));
      const hostDrop = pre.findIndex((expr) => expr.includes('"broadcast"'));
      expect(relay).toBeGreaterThan(-1);
      expect(relay).toBeLessThan(hostDrop);
      expect(pre[relay]).toContain('"local"');
      expect(pre[relay]).toContain('"accept"');
      expect(pre[relay]).not.toContain('"broadcast"');
    });

    it("drops the relay port from every interface except Workspace bridges", () => {
      const chain = relayListing().nftables.find((entry) => entry.chain?.name === "relay_input");
      expect(chain?.chain).toMatchObject({ hook: "input", prio: -10, policy: "accept" });
      const rules = rulesOf(relayListing(), "relay_input").map((entry) => JSON.stringify(entry.rule?.expr));
      expect(rules).toHaveLength(1);
      expect(rules[0]).toContain('"!="');
      expect(rules[0]).toContain('"arw-*"');
      expect(rules[0]).toContain("3101");
      expect(rules[0]).toContain('"drop"');
    });

    it("verifies only against the configured relay port", () => {
      expect(verifyEgressListing(relayListing(), relayRules())).toEqual({ ok: true });
      expect(verifyEgressListing(listing(), relayRules())).toMatchObject({ ok: false });
      expect(verifyEgressListing(relayListing(), effectiveEgressRules(POLICY, ["100.112.169.46/32"]))).toMatchObject({ ok: false });
      expect(
        verifyEgressListing(relayListing(), effectiveEgressRules(POLICY, ["100.112.169.46/32"], 3102)),
      ).toMatchObject({ ok: false });
      const withoutInput = relayListing();
      withoutInput.nftables = withoutInput.nftables.filter(
        (entry) => entry.rule?.chain !== "relay_input",
      );
      expect(verifyEgressListing(withoutInput, relayRules())).toEqual({
        ok: false,
        reason: "rules of relay_input do not match",
      });
    });
  });
});
