import type { NftClient } from "./nft.js";
import { NftCommandError } from "./nft.js";

type Command = Record<string, Record<string, Record<string, unknown>>>;

/**
 * Converts a rendered transaction into the shape `nft -j list table` prints: the final
 * table contents, without the add/delete wrappers.
 */
export function listingFromTransaction(transaction: unknown): { nftables: unknown[] } {
  const commands = (transaction as { nftables: Command[] }).nftables;
  let objects: Array<Record<string, unknown>> = [];
  for (const command of commands) {
    const [verb, body] = Object.entries(command)[0] ?? [];
    const [kind, value] = Object.entries(body ?? {})[0] ?? [];
    if (kind === undefined || value === undefined) continue;
    if (kind === "table") {
      if (verb === "delete") objects = [];
      else if (!objects.some((object) => "table" in object)) objects.push({ table: value });
      continue;
    }
    objects.push({ [kind]: value });
  }
  return { nftables: [{ metainfo: { json_schema_version: 1 } }, ...objects] };
}

/** In-memory nft: applies transactions atomically and lists the resulting table. */
export class FakeNft implements NftClient {
  listing: unknown = null;
  applied: unknown[] = [];
  denyPermission = false;
  failNextApply = false;

  async apply(transaction: unknown): Promise<void> {
    if (this.denyPermission) {
      throw new NftCommandError("nft could not apply the egress rules: Operation not permitted", true);
    }
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new NftCommandError("nft could not apply the egress rules: syntax error", false);
    }
    this.applied.push(transaction);
    this.listing = listingFromTransaction(transaction);
  }

  async listTable(): Promise<unknown> {
    if (this.denyPermission) {
      throw new NftCommandError("nft could not list the egress rules: Operation not permitted", true);
    }
    return this.listing;
  }
}
