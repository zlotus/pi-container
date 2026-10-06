import { nextAuthThrottleState } from "@agent-runtime/database";
import { describe, expect, it } from "vitest";

import {
  AddressSet,
  DEFAULT_LOGIN_GUARD_POLICIES,
  LoginGuard,
  normalizeAddress,
  parseAddressRange,
  resolveClientAddress,
} from "./login-guard.js";

describe("address parsing", () => {
  it("normalizes IPv4-mapped IPv6 and case", () => {
    expect(normalizeAddress("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeAddress("FD00::1")).toBe("fd00::1");
  });

  it("accepts addresses and CIDRs and rejects the rest", () => {
    expect(parseAddressRange("10.0.0.0/8")).toEqual({ address: "10.0.0.0", prefix: 8, family: "ipv4" });
    expect(parseAddressRange("::1")).toEqual({ address: "::1", prefix: 128, family: "ipv6" });
    for (const invalid of ["", "10.0.0.0/33", "10.0.0.0/8/1", "example.test", "10.0.0.0/x"]) {
      expect(parseAddressRange(invalid)).toBeNull();
    }
  });

  it("matches IPv4 and mapped addresses against a set", () => {
    const set = new AddressSet(["127.0.0.1/32", "10.0.0.0/8"]);
    expect(set.has("10.1.2.3")).toBe(true);
    expect(set.has("::ffff:127.0.0.1")).toBe(true);
    expect(set.has("192.0.2.1")).toBe(false);
    expect(set.has("not-an-address")).toBe(false);
  });
});

describe("resolveClientAddress", () => {
  const proxies = new AddressSet(["10.0.0.0/8"]);

  it("uses the peer when it is not a trusted proxy", () => {
    expect(resolveClientAddress("192.0.2.1", "203.0.113.9", proxies)).toBe("192.0.2.1");
  });

  it("walks trusted hops from the right", () => {
    expect(resolveClientAddress("10.0.0.1", "203.0.113.9, 198.51.100.1, 10.0.0.2", proxies)).toBe(
      "198.51.100.1",
    );
    expect(resolveClientAddress("10.0.0.1", ["203.0.113.9", "10.0.0.2"], proxies)).toBe(
      "203.0.113.9",
    );
  });

  it("stops at a malformed hop and keeps the last trusted address", () => {
    expect(resolveClientAddress("10.0.0.1", "garbage, 10.0.0.2", proxies)).toBe("10.0.0.2");
    expect(resolveClientAddress("10.0.0.1", undefined, proxies)).toBe("10.0.0.1");
  });
});

describe("LoginGuard keys", () => {
  const guard = new LoginGuard(
    "secret-secret-secret-secret-secret-secret",
    DEFAULT_LOGIN_GUARD_POLICIES,
    new AddressSet(["127.0.0.1/32"]),
  );

  it("omits the account-wide counter for trusted networks only", () => {
    const account = guard.accountKey("User@Example.test", null);
    expect(guard.localLoginKeys(account, "198.51.100.1").map((key) => key.scope)).toEqual([
      "login_ip",
      "ip",
      "login",
    ]);
    expect(guard.localLoginKeys(account, "127.0.0.1").map((key) => key.scope)).toEqual([
      "login_ip",
      "ip",
    ]);
  });

  it("derives keyed hashes that do not contain the login", () => {
    const account = guard.accountKey(" User@Example.test ", null);
    expect(account).toBe(guard.accountKey("user@example.test", null));
    const [key] = guard.accountKeys(account);
    expect(key?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    const other = new LoginGuard(
      "another-secret-another-secret-another-secret",
      DEFAULT_LOGIN_GUARD_POLICIES,
      new AddressSet([]),
    );
    expect(other.accountKeys(account)[0]?.keyHash).not.toBe(key?.keyHash);
  });
});

describe("nextAuthThrottleState", () => {
  const policy = { threshold: 3, windowMs: 60_000, lockMs: 120_000 };
  const start = new Date("2026-10-06T00:00:00Z");
  const at = (ms: number) => new Date(start.getTime() + ms);

  it("counts within a window and locks at the threshold", () => {
    let state = nextAuthThrottleState(null, policy, start);
    expect(state).toEqual({ windowStart: start, failures: 1, lockedUntil: null });
    state = nextAuthThrottleState(state, policy, at(1_000));
    state = nextAuthThrottleState(state, policy, at(2_000));
    expect(state).toEqual({ windowStart: start, failures: 3, lockedUntil: at(122_000) });
  });

  it("starts over after the window or the lock ends", () => {
    const counted = nextAuthThrottleState(null, policy, start);
    expect(nextAuthThrottleState(counted, policy, at(60_000)).failures).toBe(1);
    const locked = { windowStart: start, failures: 3, lockedUntil: at(10_000) };
    expect(nextAuthThrottleState(locked, policy, at(10_000))).toEqual({
      windowStart: at(10_000),
      failures: 1,
      lockedUntil: null,
    });
  });
});
