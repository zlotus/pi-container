import { createHmac } from "node:crypto";
import { BlockList, isIP } from "node:net";

import type {
  AuthThrottleHit,
  AuthThrottleKey,
  AuthThrottlePolicy,
} from "@agent-runtime/database";

/** Thresholds per counter (specs.md Phase 15.9). */
export interface LoginGuardPolicies {
  loginIp: AuthThrottlePolicy;
  ip: AuthThrottlePolicy;
  login: AuthThrottlePolicy;
  ssoStart: AuthThrottlePolicy;
}

export const DEFAULT_LOGIN_GUARD_POLICIES: LoginGuardPolicies = {
  loginIp: { threshold: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  ip: { threshold: 20, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  login: { threshold: 50, windowMs: 60 * 60_000, lockMs: 60 * 60_000 },
  ssoStart: { threshold: 30, windowMs: 10 * 60_000, lockMs: 10 * 60_000 },
};

/** Strips the IPv4-mapped IPv6 prefix so one client has one address. */
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return (mapped?.[1] ?? address).toLowerCase();
}

/** Parses `a.b.c.d/n`, `addr` or IPv6 equivalents; returns null for anything else. */
export function parseAddressRange(
  value: string,
): { address: string; prefix: number; family: "ipv4" | "ipv6" } | null {
  const [address = "", prefixText, extra] = value.trim().split("/");
  if (extra !== undefined) return null;
  const version = isIP(address);
  if (version === 0) return null;
  const family = version === 4 ? "ipv4" : "ipv6";
  const max = version === 4 ? 32 : 128;
  if (prefixText === undefined) return { address, prefix: max, family };
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  return prefix <= max ? { address, prefix, family } : null;
}

export class AddressSet {
  readonly #list = new BlockList();
  readonly entries: readonly string[];

  constructor(ranges: readonly string[]) {
    for (const range of ranges) {
      const parsed = parseAddressRange(range);
      if (parsed === null) throw new Error(`Invalid address range: ${range}`);
      this.#list.addSubnet(parsed.address, parsed.prefix, parsed.family);
    }
    this.entries = [...ranges];
  }

  has(address: string): boolean {
    const normalized = normalizeAddress(address);
    const version = isIP(normalized);
    if (version === 0) return false;
    return this.#list.check(normalized, version === 4 ? "ipv4" : "ipv6");
  }
}

/**
 * The client address: the TCP peer, unless that peer is a trusted proxy, in which case
 * the right-most `X-Forwarded-For` hop that is not itself a trusted proxy. A forged
 * header from an untrusted peer is ignored.
 */
export function resolveClientAddress(
  peerAddress: string,
  forwardedFor: string | string[] | undefined,
  trustedProxies: AddressSet,
): string {
  let client = normalizeAddress(peerAddress);
  if (!trustedProxies.has(client) || forwardedFor === undefined) return client;
  const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor)
    .split(",")
    .map((hop) => hop.trim());
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = normalizeAddress(hops[index] ?? "");
    if (isIP(hop) === 0) return client;
    client = hop;
    if (!trustedProxies.has(hop)) return client;
  }
  return client;
}

/**
 * Derives the throttle counters for one request. Counter keys are HMACs under a key
 * derived from the session secret, so the table never holds a typed login in clear text.
 */
export class LoginGuard {
  readonly #key: Buffer;

  constructor(
    sessionSecret: string,
    readonly policies: LoginGuardPolicies,
    readonly trustedNetworks: AddressSet,
  ) {
    this.#key = createHmac("sha256", sessionSecret).update("auth-throttle-v1").digest();
  }

  #hash(value: string): string {
    return createHmac("sha256", this.#key).update(value).digest("hex");
  }

  /** An existing local User is counted by ID, so email and username share one counter. */
  accountKey(login: string, userId: string | null): string {
    return userId === null ? `login:${login.trim().toLowerCase()}` : `user:${userId}`;
  }

  /** Counters that can block a local login attempt from this address. */
  localLoginKeys(account: string, address: string): AuthThrottleKey[] {
    const keys: AuthThrottleKey[] = [
      { scope: "login_ip", keyHash: this.#hash(`${account}|${address}`) },
      { scope: "ip", keyHash: this.ipKeyHash(address) },
    ];
    // A distributed attack can lock an account, but not against the management network.
    if (!this.trustedNetworks.has(address)) {
      keys.push({ scope: "login", keyHash: this.#hash(account) });
    }
    return keys;
  }

  localLoginFailureHits(
    account: string,
    address: string,
    userId: string | null,
  ): AuthThrottleHit[] {
    return [
      {
        scope: "login_ip",
        keyHash: this.#hash(`${account}|${address}`),
        policy: this.policies.loginIp,
        ipAddress: address,
        userId,
      },
      this.addressFailureHit(address),
      {
        scope: "login",
        keyHash: this.#hash(account),
        policy: this.policies.login,
        ipAddress: null,
        userId,
      },
    ];
  }

  accountAddressKey(account: string, address: string): AuthThrottleKey {
    return { scope: "login_ip", keyHash: this.#hash(`${account}|${address}`) };
  }

  accountKeys(account: string): AuthThrottleKey[] {
    return [{ scope: "login", keyHash: this.#hash(account) }];
  }

  ipKeyHash(address: string): string {
    return this.#hash(`ip:${address}`);
  }

  addressKeys(address: string): AuthThrottleKey[] {
    return [{ scope: "ip", keyHash: this.ipKeyHash(address) }];
  }

  addressFailureHit(address: string): AuthThrottleHit {
    return {
      scope: "ip",
      keyHash: this.ipKeyHash(address),
      policy: this.policies.ip,
      ipAddress: address,
      userId: null,
    };
  }

  ssoStartKeys(address: string): AuthThrottleKey[] {
    return [
      { scope: "sso_start", keyHash: this.#hash(`sso:${address}`) },
      { scope: "ip", keyHash: this.ipKeyHash(address) },
    ];
  }

  ssoStartHit(address: string): AuthThrottleHit {
    return {
      scope: "sso_start",
      keyHash: this.#hash(`sso:${address}`),
      policy: this.policies.ssoStart,
      ipAddress: address,
      userId: null,
    };
  }

  /** The longest window, so the cleanup never drops a live counter. */
  get maxWindowMs(): number {
    return Math.max(...Object.values(this.policies).map((policy) => policy.windowMs));
  }
}

export function retryAfterSeconds(lockedUntil: Date, now: Date): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1_000));
}
