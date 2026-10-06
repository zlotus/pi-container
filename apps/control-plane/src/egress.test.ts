import type { EgressRuleRecord } from "@agent-runtime/database";
import { describe, expect, it, vi } from "vitest";

import { egressPolicyForWorkers, protectedAddressResolver, validateEgressRules } from "./egress.js";

function rule(overrides: Partial<EgressRuleRecord>): EgressRuleRecord {
  return {
    id: crypto.randomUUID(),
    action: "allow",
    network: "192.168.1.1/32",
    protocol: null,
    portMin: null,
    portMax: null,
    description: "",
    createdBy: "33333333-3333-4333-8333-333333333333",
    createdAt: new Date(0),
    ...overrides,
  };
}

describe("egress rule validation", () => {
  it("accepts allow entries inside RFC1918", () => {
    expect(validateEgressRules([rule({ network: "10.1.0.0/16" })], [])).toBeNull();
    expect(validateEgressRules([rule({ network: "172.16.0.0/12" })], [])).toBeNull();
  });

  it("rejects allow entries that open nothing denied", () => {
    expect(validateEgressRules([rule({ network: "100.64.0.0/10" })], [])).toBe(
      "EGRESS_ALLOW_OUTSIDE_DENY",
    );
    // Straddles 192.168.0.0/16 and public space.
    expect(validateEgressRules([rule({ network: "192.160.0.0/12" })], [])).toBe(
      "EGRESS_ALLOW_OUTSIDE_DENY",
    );
  });

  it("accepts allow entries inside an administrator deny range, also across adjacent ranges", () => {
    const deny = [
      rule({ action: "deny", network: "100.64.0.0/11" }),
      rule({ action: "deny", network: "100.96.0.0/11" }),
    ];
    expect(validateEgressRules([...deny, rule({ network: "100.64.0.0/10" })], [])).toBeNull();
    expect(validateEgressRules([deny[0] as EgressRuleRecord, rule({ network: "100.64.0.0/10" })], []))
      .toBe("EGRESS_ALLOW_OUTSIDE_DENY");
  });

  it("never lets an allow entry include a protected platform address", () => {
    expect(validateEgressRules([rule({ network: "10.0.0.0/24" })], ["10.0.0.5/32"])).toBe(
      "EGRESS_ALLOW_OVERLAPS_PROTECTED",
    );
    expect(validateEgressRules([rule({ network: "10.0.1.0/24" })], ["10.0.0.5/32"])).toBeNull();
  });

  it("builds the Worker policy with optional service fields", () => {
    expect(
      egressPolicyForWorkers(
        {
          revision: 4,
          rules: [
            rule({ network: "10.0.0.0/8" }),
            rule({ network: "10.1.1.1/32", protocol: "tcp", portMin: 443, portMax: 443 }),
            rule({ action: "deny", network: "169.254.0.0/16" }),
          ],
        },
        ["10.0.0.9/32"],
      ),
    ).toEqual({
      revision: 4,
      allow: [
        { network: "10.0.0.0/8" },
        { network: "10.1.1.1/32", protocol: "tcp", portMin: 443, portMax: 443 },
      ],
      denyExtra: ["169.254.0.0/16"],
      protected: ["10.0.0.9/32"],
    });
  });
});

describe("protected platform addresses", () => {
  it("adds the DATABASE_URL host to explicit entries and skips loopback", async () => {
    await expect(
      protectedAddressResolver(["10.9.0.0/16"], "postgres://u:p@10.2.3.4:5432/db")(),
    ).resolves.toEqual(["10.2.3.4/32", "10.9.0.0/16"]);
    await expect(
      protectedAddressResolver([], "postgres://u:p@127.0.0.1:5432/db")(),
    ).resolves.toEqual([]);
  });

  it("resolves a DATABASE_URL host name and tolerates resolution failure", async () => {
    const lookup = vi.fn().mockResolvedValue(["10.7.7.7"]);
    await expect(
      protectedAddressResolver([], "postgres://u:p@db.internal/db", lookup)(),
    ).resolves.toEqual(["10.7.7.7/32"]);
    const failing = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      protectedAddressResolver(["10.1.0.0/16"], "postgres://u:p@db.internal/db", failing)(),
    ).resolves.toEqual(["10.1.0.0/16"]);
  });
});
