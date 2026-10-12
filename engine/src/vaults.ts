// The Genome Vaults NFT (contracts/src/GenomeVaults.sol) as the engine sees it: the three chain events the public hears
// about (a vault minted, the Safe's fund, a vault burned) and their fact sheets. Everything keys off the deployment's
// `genomeVaults` address: absent, nothing is indexed, watched or said. Every number in a fact sheet is the chain's own
// (the event's arguments, the contract's constants and its live count read at send time): no model, no guess.
import type { Address } from "viem";
import * as abi from "./abi.ts";
import { d } from "./config.ts";
import { edb as sql } from "./db.ts";
import { pub } from "./tx.ts";

/** The vault events that reach the site and X; the rest of the contract's log (transfers, approvals, art updates) stays
 *  out of chain_log too. */
export const VAULT_X_EVENTS = new Set(["Minted", "Funded", "Burned"]);
export const vaultEventAbi = abi.genomeVaultsAbi.filter((x) => x.type === "event" && VAULT_X_EVENTS.has(x.name));
/** The announcement type per chain event (the outbox stores the event's name). */
export const VAULT_TYPE: Record<string, string> = { Minted: "vault_minted", Funded: "vault_funded", Burned: "vault_burned" };

/** The vaults address, when deployed: what the watcher and the indexer read. */
export const vaultsAddress = (): Address | undefined => d.genomeVaults;
/** A log from the vaults contract (its events share names with other contracts': the address decides). */
export const isVaultLog = (address: string | undefined) => !!d.genomeVaults && !!address && address.toLowerCase() === d.genomeVaults.toLowerCase();

const ETH = (wei: bigint) => Number((Number(wei) / 1e18).toFixed(4));
const DNA = (wei: bigint) => Number(wei / 10n ** 18n);

/** The contract's constants and its live count, read at send time (a mint or a burn says how many are live now). Test seam. */
export type VaultState = { live: number; maxLive: number; depositDna: number };
export const VAULT_READ = {
  state: async (): Promise<VaultState> => {
    const address = d.genomeVaults!;
    const read = <T>(functionName: "liveCount" | "MAX_LIVE" | "DEPOSIT") => pub.readContract({ address, abi: abi.genomeVaultsAbi, functionName }) as Promise<T>;
    const [live, maxLive, deposit] = await Promise.all([read<bigint>("liveCount"), read<bigint>("MAX_LIVE"), read<bigint>("DEPOSIT")]);
    return { live: Number(live), maxLive: Number(maxLive), depositDna: DNA(deposit) };
  },
  /** The slot a burned vault held: its Minted log (Burned carries no slot). undefined when it is not indexed yet. */
  slotOf: async (id: string): Promise<number | undefined> => {
    const [r] = await sql<{ slot: string }[]>`select args->>'slot' as slot from chain_log where event = 'Minted' and address = ${d.genomeVaults!.toLowerCase()} and args->>'id' = ${id} limit 1`;
    return r ? Number(r.slot) : undefined;
  },
};

/** Pure: a vault chain event (its args as chain_log stores them: bigints as decimal strings) → the raw fact input
 *  (src/voice.ts FIELDS is the allow-list). `state`: the contract read at send time; `slot`: a burned vault's slot. */
export function vaultFacts(ev: { name: string; args: Record<string, unknown> }, state?: VaultState, slot?: number): Record<string, unknown> | null {
  const a = ev.args as Record<string, string>;
  const now = state ? { live: state.live, maxLive: state.maxLive, lockedDna: state.depositDna } : {};
  switch (ev.name) {
    case "Minted": return { event: "vault_minted", slot: Number(a.slot), ...now };
    case "Burned": return { event: "vault_burned", ...(slot !== undefined ? { slot } : {}), ethReturned: ETH(BigInt(a.eth)), ...now };
    case "Funded": {
      const vaults = Number(a.eligible);
      return { event: "vault_funded", ethTotal: ETH(BigInt(a.amount)), vaults, ...(vaults > 0 ? { perVaultEth: ETH(BigInt(a.perToken)) } : {}) };
    }
  }
  return null;
}

/** The fact sheet for an outbox vault event (src/x.ts resolve): the chain's numbers plus what the contract says now. */
export async function resolveVault(ev: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!d.genomeVaults) return null;
  const name = String(ev.name), args = (ev.args ?? {}) as Record<string, unknown>;
  // a failed read states nothing about the count (never a guessed number); the event's own numbers still post
  const state = name === "Funded" ? undefined : await VAULT_READ.state().catch(() => undefined);
  const slot = name === "Burned" ? await VAULT_READ.slotOf(String(args.id)).catch(() => undefined) : undefined;
  return vaultFacts({ name, args }, state, slot);
}
