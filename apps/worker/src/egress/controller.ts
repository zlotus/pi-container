import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

import type { Logger } from "@agent-runtime/logging";
import {
  canonicalIpv4Cidr,
  type EgressPolicy,
  EgressPolicySchema,
  type WorkerEgressStatus,
} from "@agent-runtime/protocol";

import type { NftClient } from "./nft.js";
import {
  effectiveEgressRules,
  type EffectiveEgressRules,
  renderEgressTransaction,
  verifyEgressListing,
} from "./ruleset.js";

export class EgressApplyError extends Error {}

export interface EgressControllerOptions {
  nft: NftClient;
  /** `${WORKER_MANAGED_ROOT}/egress`: last applied policy and the boot-time ruleset. */
  stateDirectory: string;
  /** Worker-local protected addresses (CONTROL_PLANE_URL host, WORKER_EGRESS_PROTECTED). */
  resolveLocalProtected: () => Promise<string[]>;
  /** The model relay port Workspaces may reach on this host, if the relay is enabled. */
  relayPort?: number | null;
  log: Pick<Logger, "info" | "warn">;
}

/**
 * Owns the Worker's egress table. `enforced` is true only after the live table was read
 * back and matched the rules this Worker must enforce; every other outcome is fail-closed.
 */
export class EgressController {
  readonly #options: EgressControllerOptions;
  #policy: EgressPolicy | null = null;
  #localProtected: string[] = [];
  #enforced = false;
  #lastFailure: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: EgressControllerOptions) {
    this.#options = options;
  }

  status(): WorkerEgressStatus {
    return { enforced: this.#enforced, revision: this.#policy?.revision ?? null };
  }

  isEnforced(): boolean {
    return this.#enforced;
  }

  /** Loads the last applied policy, resolves local protected addresses and enforces them. */
  initialize(): Promise<WorkerEgressStatus> {
    return this.#serialized(async () => {
      this.#policy = await this.#loadPolicy();
      await this.#refreshLocalProtected();
      await this.#ensure();
      return this.status();
    });
  }

  /** Checks the live table and re-applies the expected rules when it drifted. */
  ensure(): Promise<WorkerEgressStatus> {
    return this.#serialized(async () => {
      await this.#ensure();
      return this.status();
    });
  }

  /** Applies a Control Plane policy; an older revision than the applied one is ignored. */
  apply(policy: EgressPolicy): Promise<WorkerEgressStatus> {
    return this.#serialized(async () => {
      if (this.#policy !== null && policy.revision < this.#policy.revision) {
        await this.#ensure();
        return this.status();
      }
      await this.#refreshLocalProtected();
      const rules = effectiveEgressRules(policy, this.#localProtected, this.#options.relayPort ?? null);
      try {
        await this.#options.nft.apply(renderEgressTransaction(rules));
      } catch (error) {
        // The previous table is untouched by a failed transaction; keep enforcing it.
        await this.#ensure();
        throw new EgressApplyError(
          error instanceof Error ? error.message : "egress rules could not be applied",
        );
      }
      this.#policy = policy;
      await this.#persist(rules);
      await this.#ensure();
      if (!this.#enforced) {
        throw new EgressApplyError("egress rules did not verify after apply");
      }
      return this.status();
    });
  }

  async #ensure(): Promise<void> {
    const rules = effectiveEgressRules(this.#policy, this.#localProtected, this.#options.relayPort ?? null);
    let reason = await this.#verify(rules);
    if (reason !== null) {
      try {
        await this.#options.nft.apply(renderEgressTransaction(rules));
        await this.#persist(rules);
        reason = await this.#verify(rules);
        if (reason === null) {
          this.#options.log.warn(
            { revision: this.#policy?.revision ?? null },
            "egress rules were missing or changed and have been re-applied",
          );
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : "egress rules could not be applied";
      }
    }
    this.#setEnforced(reason);
  }

  async #verify(rules: EffectiveEgressRules): Promise<string | null> {
    try {
      const listing = await this.#options.nft.listTable();
      if (listing === null) return "egress table is missing";
      const result = verifyEgressListing(listing, rules);
      return result.ok ? null : result.reason;
    } catch (error) {
      return error instanceof Error ? error.message : "egress rules could not be read";
    }
  }

  #setEnforced(failure: string | null): void {
    const enforced = failure === null;
    if (enforced !== this.#enforced || failure !== this.#lastFailure) {
      if (enforced) {
        this.#options.log.info(
          { revision: this.#policy?.revision ?? null },
          "egress rules enforced",
        );
      } else {
        this.#options.log.warn({ reason: failure }, "egress rules are not enforced");
      }
    }
    this.#enforced = enforced;
    this.#lastFailure = failure;
  }

  async #refreshLocalProtected(): Promise<void> {
    try {
      this.#localProtected = await this.#options.resolveLocalProtected();
    } catch (error) {
      // Keep the previous resolution; an empty list would silently drop protection.
      this.#options.log.warn({ err: error }, "could not resolve local protected addresses");
    }
  }

  async #loadPolicy(): Promise<EgressPolicy | null> {
    try {
      const decoded: unknown = JSON.parse(
        await readFile(join(this.#options.stateDirectory, "policy.json"), "utf8"),
      );
      const parsed = EgressPolicySchema.safeParse(decoded);
      if (parsed.success) return parsed.data;
      this.#options.log.warn({}, "ignoring an invalid egress policy snapshot");
    } catch {
      // No snapshot yet: enforce the base rules until the Control Plane sends a policy.
    }
    return null;
  }

  async #persist(rules: EffectiveEgressRules): Promise<void> {
    const directory = this.#options.stateDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (this.#policy !== null) {
      await writeAtomically(join(directory, "policy.json"), JSON.stringify(this.#policy));
    }
    // Loaded by agent-runtime-egress.service before Docker starts after a reboot.
    await writeAtomically(
      join(directory, "ruleset.json"),
      JSON.stringify(renderEgressTransaction(rules)),
    );
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Worker-local protected addresses: the Control Plane host this Worker connects to and the
 * model gateway it relays to (an address literal or every IPv4 address a name resolves to),
 * plus explicit entries.
 */
export function localProtectedResolver(
  controlPlaneUrl: string,
  explicit: readonly string[],
  resolveHost: (hostname: string) => Promise<string[]> = async (hostname) =>
    (await lookup(hostname, { all: true, family: 4 })).map((entry) => entry.address),
  additionalUrls: readonly string[] = [],
): () => Promise<string[]> {
  return async () => {
    const addresses: string[] = [];
    for (const url of [controlPlaneUrl, ...additionalUrls]) {
      const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
      addresses.push(
        ...(isIP(hostname) === 0 ? await resolveHost(hostname) : isIP(hostname) === 4 ? [hostname] : []),
      );
    }
    const cidrs = addresses
      .map((address) => canonicalIpv4Cidr(address))
      .filter((cidr): cidr is string => cidr !== null);
    return [...new Set([...cidrs, ...explicit])].sort();
  };
}
