// The watchdog's Sequencer checks (outside the enclave, read-only, no keys; run by src/watchdog.ts). Every game deploy,
// every queued game fund and every move of the site's `release` branch must rest on a record the enclave signed:
//  - GameDeployed (the factory): a signed `ship` record for that address and code hash, else page factory.retire(game);
//  - Delay TransactionAdded to GameFunder: a signed `fund` record with that tx and Delay nonce, else page setTxNonce;
//  - `release` moved: a signed `release` record for that commit whose public hour is over and whose ship (if any) 2
//    Safe owners did not veto, else page a revert; a release made by a page kill (it skips the hour) needs the signed
//    `page-kill` record it names, for the same page;
//  - one game took ≥ 40% of GameFunder's weekly budget in the rolling week: page (fake players can pull top-ups
//    forward; the caps bound it, this makes it visible).
// Records come from the site (/api/log/seq/<kind>), checked against the attested log signer.
import { type Address, getAbiItem, type Hex, parseAbi, parseAbiItem, type PublicClient, recoverMessageAddress } from "viem";
import * as abi from "./abi.ts";
import { type Fetch, fetchJson } from "./draw-verify.ts";
import { ownerDigestOn, targetKey, targetOf } from "./owner-sig.ts";
import { checkRecord, type SignedRecord } from "./proof.ts";
import { getLogsChunked } from "./ticket-source.ts";

type Rec = SignedRecord & { seq: string };
export type SeqDep = { gameFactory?: Address; gameFunder?: Address; delay?: Address; safe?: Address };
const SAFE_ABI = parseAbi(["function getOwners() view returns (address[])"]);
const DEPLOYED = getAbiItem({ abi: abi.gameFactoryAbi, name: "GameDeployed" });
const FUNDED = getAbiItem({ abi: abi.gameFunderAbi, name: "Funded" });
const ADDED = parseAbiItem("event TransactionAdded(uint256 indexed queueNonce, bytes32 indexed txHash, address to, uint256 value, bytes data, uint8 operation)");
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
export const SHARE_PAGE = 0.4;

/** Signed records of a kind whose body passes `match`. */
async function signedMatch(get: Fetch, base: string, kind: "ship" | "fund" | "release" | "page-kill", logSigner: string | null | undefined, match: (b: Record<string, unknown>, r: Rec) => boolean) {
  const list = (await get(`${base}/api/log/seq/${kind}`)) as { records?: Rec[] };
  for (const r of list.records ?? []) {
    let b: Record<string, unknown>;
    try { b = JSON.parse(r.body); } catch { continue; }
    if (r.kind !== kind || !match(b, r)) continue;
    const s = await checkRecord(r);
    if (s.ehashOk && (!logSigner || same(s.signer, logSigner))) return { rec: r, body: b };
  }
  return null;
}

/** Pure: the games whose funds in the rolling week reached SHARE_PAGE of the weekly budget. */
export function heavyGames(funds: { game: string; amount: bigint; at: number }[], weeklyBudget: bigint, now: number) {
  const by = new Map<string, bigint>();
  for (const f of funds) if (f.at + 7 * 86_400_000 > now) by.set(f.game.toLowerCase(), (by.get(f.game.toLowerCase()) ?? 0n) + f.amount);
  return [...by].filter(([, v]) => v * 100n >= weeklyBudget * BigInt(SHARE_PAGE * 100)).map(([g, v]) => ({ game: g, amount: v }));
}

export function seqWatch(o: {
  client: PublicClient; dep: SeqDep; page: (text: string) => Promise<void>; logSigner?: string | null; base: string; fetch?: Fetch; now: () => number;
  /** the site's `release` head (null when it can't be read now) */
  releaseHead?: () => Promise<string | null>;
}) {
  const get = o.fetch ?? fetchJson;
  let lastRelease: string | null = null;
  let releaseAt = -Infinity; // the branch is read every 5 min (an unauthenticated client gets 60 reads an hour)
  const paged = new Set<string>();
  const once = async (k: string, text: string) => { if (!paged.has(k)) { paged.add(k); await o.page(text); } };
  /** Do 2 current Safe owners veto this ship record (src/approve.ts rule; signatures bound to the log signer)? */
  /** Distinct current Safe owners whose `kind` signature (src/approve.ts rule, bound to the log signer) is on `rec`. */
  async function ownersOn(kind: "approve" | "veto", rec: Rec) {
    if (!o.logSigner || !o.dep.safe) return 0;
    const t = targetOf({ kind: rec.kind, ref: String(rec.ref), body: rec.body });
    const chain = { chainId: await o.client.getChainId(), safe: o.dep.safe, enclave: o.logSigner };
    const owners = ((await o.client.readContract({ address: o.dep.safe, abi: SAFE_ABI, functionName: "getOwners" })) as string[]).map((x) => x.toLowerCase());
    const list = (await get(`${o.base}/api/log/seq/${kind}`)) as { records?: Rec[] };
    const by = new Set<string>();
    for (const v of list.records ?? []) {
      if (v.ref !== targetKey(t)) continue;
      let sig = "";
      try { sig = String(JSON.parse(v.body).signature ?? ""); } catch { continue; }
      const who = await recoverMessageAddress({ message: { raw: `0x${ownerDigestOn(kind, t, chain)}` }, signature: sig as Hex }).catch(() => null);
      if (who && owners.includes(who.toLowerCase())) by.add(who.toLowerCase());
    }
    return by.size;
  }
  /** Do 2 current Safe owners veto this ship record? */
  async function shipVetoed(seq: string) {
    const ship = (await get(`${o.base}/api/log/${seq}`)) as Rec;
    const s = await checkRecord(ship);
    if (ship.kind !== "ship" || !s.ehashOk || !same(s.signer, o.logSigner)) return false;
    return (await ownersOn("veto", ship)) >= 2;
  }
  return {
    async tick(from: bigint, to: bigint) {
      const c = o.client;
      if (o.dep.gameFactory) {
        for (const l of await getLogsChunked((a, b) => c.getLogs({ address: o.dep.gameFactory!, event: DEPLOYED, fromBlock: a, toBlock: b }), from, to)) {
          const game = String(l.args.game), codehash = String(l.args.codehash);
          const m = await signedMatch(get, o.base, "ship", o.logSigner, (b) => same(b.predicted, game) && same(b.codehash, codehash));
          // only a mismatch pages (a restart reads the lookback again: a matching deploy stays quiet)
          if (!m) await once(`deploy:${game}`, `🚨 GAME DEPLOYED WITHOUT A SIGNED SHIP RECORD — ${game} (code hash ${codehash}). Safe: factory.retire(${game}) on ${o.dep.gameFactory}.`);
        }
      }
      if (o.dep.delay && o.dep.gameFunder) {
        for (const l of await getLogsChunked((a, b) => c.getLogs({ address: o.dep.delay!, event: ADDED, fromBlock: a, toBlock: b }), from, to)) {
          if (!same(l.args.to, o.dep.gameFunder)) continue;
          const nonce = String(l.args.queueNonce), tx = String(l.transactionHash);
          const m = await signedMatch(get, o.base, "fund", o.logSigner, (b) => same(b.tx, tx) && String(b.delayNonce) === nonce);
          if (!m) await once(`fund:${nonce}`, `🚨 GAME FUND QUEUED WITHOUT A SIGNED FUND RECORD — Delay nonce ${nonce} (tx ${tx}). Safe: setTxNonce(${BigInt(nonce) + 1n}) on Delay ${o.dep.delay} within the hour.`);
        }
        // the 40% page: GameFunder's funds of the last ~8 days
        const head = to;
        const funds = await getLogsChunked((a, b) => c.getLogs({ address: o.dep.gameFunder!, event: FUNDED, fromBlock: a, toBlock: b }), head > 60_000n ? head - 60_000n : 0n, head);
        if (funds.length) {
          const weekly = (await c.readContract({ address: o.dep.gameFunder, abi: abi.gameFunderAbi, functionName: "weeklyBudget" })) as bigint;
          const at = new Map<bigint, number>();
          const rows = [];
          for (const f of funds) {
            if (!at.has(f.blockNumber!)) at.set(f.blockNumber!, Number((await c.getBlock({ blockNumber: f.blockNumber! })).timestamp) * 1000);
            rows.push({ game: String(f.args.game), amount: f.args.amount!, at: at.get(f.blockNumber!)! });
          }
          for (const h of heavyGames(rows, weekly, o.now())) await once(`heavy:${h.game}:${new Date(o.now()).toISOString().slice(0, 10)}`, `Sequencer game ${h.game} took ${Number(h.amount) / 1e18} ETH this week, ≥ ${SHARE_PAGE * 100}% of the weekly budget: check its players are real.`);
        }
      }
      if (o.releaseHead && o.now() - releaseAt >= 5 * 60_000) {
        releaseAt = o.now();
        const sha = await o.releaseHead().catch(() => null);
        if (sha && sha !== lastRelease) {
          if (lastRelease !== null) {
            const m = await signedMatch(get, o.base, "release", o.logSigner, (b) => b.sha === sha && Date.parse(String(b.effectiveAt)) <= o.now());
            const vetoedShip = m?.body.ship ? await shipVetoed(String(m.body.ship)) : false;
            const need = Number(m?.body.needApprovals ?? 0);
            const unapproved = m && need > 0 && (await ownersOn("approve", m.rec)) < need;
            // a kill's release: only with the signed page-kill record it names, for the same page
            const killless = m && m.body.pageKill !== undefined
              && !(await signedMatch(get, o.base, "page-kill", o.logSigner, (b, r) => r.seq === String(m.body.pageKill) && b.slug === m.body.slug));
            await once(`release:${sha}`, !m
              ? `🚨 RELEASE MOVED WITHOUT A SIGNED RELEASE RECORD IN EFFECT — ${sha}. Revert the release branch to ${lastRelease}.`
              : vetoedShip
                ? `🚨 RELEASE MOVED TO A VETOED SHIP'S MERGE — ${sha} (ship record ${String(m.body.ship)} has 2 owner vetoes). Revert the release branch to ${lastRelease}.`
                : unapproved
                  ? `🚨 RELEASE MOVED TO A HELD RECORD WITHOUT AN OWNER APPROVAL — ${sha} (release record ${m.rec.seq} needs ${need}). Revert the release branch to ${lastRelease}.`
                  : killless
                    ? `🚨 RELEASE MOVED AS A PAGE KILL WITHOUT ITS SIGNED page-kill RECORD — ${sha} (release record ${m.rec.seq} names ${String(m.body.pageKill)} for ${String(m.body.slug)}). Revert the release branch to ${lastRelease}.`
                    : `Site release moved to ${sha} (release record ${m.rec.seq}).`);
          }
          lastRelease = sha;
        }
      }
    },
  };
}

/** The `release` head of a public repository (unauthenticated read; the watchdog holds no token). */
export const publicReleaseHead = (repo: string, fetcher = fetch) => async () => {
  const r = await fetcher(`https://api.github.com/repos/${repo}/git/ref/heads/release`, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return null;
  return ((await r.json()) as { object?: { sha?: string } }).object?.sha ?? null;
};
