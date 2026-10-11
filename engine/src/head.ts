// Boot check against log-head rollback: the enclave refuses to start unless the DB's enclave chain
//  (a) descends from the latest root THIS enclave's anchor key anchored on-chain (both RPC providers, not the DB), and
//  (b) is not older than the head kept on the CVM's encrypted disk (HEAD_FILE, written every minute by the heartbeat).
// From the oldest of those two onwards, the enclave's own records (ehash recomputes, esig = the log key) must link
// linearly (a fork or a rollback fails the boot); foreign rows are skipped and alerted, never links. Before that point the
// chain is walked back to genesis by hash (eprev links) so the log knows the newest record of every kind:ref (a row the
// DB later hides reads as a rollback). The verified head becomes the log's in-memory head: every later append chains
// on it. No root of ours and no disk head (a first boot, or a lost disk): a boot anchor goes out at once, in any mode,
// and agent txs wait until it is mined.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseAbiItem, type PublicClient } from "viem";
import * as abi from "./abi.ts";
import { agreedHead, clients } from "./chainref.ts";
import { d, LOG_BASE_URL } from "./config.ts";
import { edb as sql } from "./db.ts";
import { isRangeError, nextRange } from "./lib.ts";
import { append, canonical, chainHash, enclaveHead, type EnclaveRow, GENESIS, noteNewest, recordOk, setHead } from "./log.ts";
import { signerAddress } from "./signed.ts";
import { alert } from "./telegram.ts";
import { addressOf, AGENT_HOLD, send } from "./tx.ts";

/** The compose file mounts the CVM's encrypted data disk here (deploy/app-compose.json). `active`: the file the boot check verified against (appends and the heartbeat keep it current); `anchored`: a root of
 *  this enclave is on chain (found at boot, or the boot anchor mined), kept in the file across restarts. */
export const HEAD_FILE = { path: "/data/dna/head.json", active: undefined as string | undefined, scannedTo: 0, anchored: false };
export type Head = { ehash: string; seq: string; scannedTo: number; anchored?: boolean };

export const readHead = (path = HEAD_FILE.path): Head | undefined => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);
export function writeHead(h: Head, path = HEAD_FILE.path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(h));
  renameSync(`${path}.tmp`, path); // atomic: a crash never leaves half a head
}

/** Pure: the targets NOT reached walking back from `head` through `prevOf` (ehash → eprev). */
export function unreached(head: string | undefined, prevOf: Map<string, string>, targets: string[]) {
  const seen = new Set<string>();
  for (let h = head; h && !seen.has(h); h = prevOf.get(h)) seen.add(h);
  return targets.filter((t) => !seen.has(t));
}

const anchoredEvent = parseAbiItem("event Anchored(bytes32 indexed root, string uri)");
/** One provider's view of [fromBlock, last]: the newest Anchored root sent by `anchor`, and how many other senders'
 *  (an older anchor key, e.g. the plain build's) were skipped. RPC windows halve on range errors. */
async function scanAnchored(c: PublicClient, fromBlock: bigint, last: bigint, anchor: string) {
  let found: { root: string; block: number } | undefined;
  let foreign = 0;
  let window = 10_000n;
  for (let from = fromBlock; from <= last;) {
    const r = nextRange(from, last, window);
    try {
      for (const l of await c.getLogs({ address: d.registry, event: anchoredEvent, fromBlock: r.from, toBlock: r.to })) {
        if ((await c.getTransaction({ hash: l.transactionHash! })).from.toLowerCase() !== anchor) { foreign++; continue; }
        found = { root: l.args.root!.slice(2).toLowerCase(), block: Number(l.blockNumber) };
      }
    } catch (e) {
      if (isRangeError(e) && window > 1n) { window /= 2n; continue; }
      throw e;
    }
    from = r.to + 1n;
  }
  return { found, foreign };
}

/** The newest root this enclave's anchor key anchored in [fromBlock, the providers' lowest head]; every provider must
 *  report the same (the enclave has two), or the boot stops. */
export async function latestAnchored(fromBlock: bigint, cs: PublicClient[] = clients) {
  const anchor = addressOf("anchor")?.toLowerCase();
  if (!anchor) throw new Error("the boot check needs the anchor key");
  const last = await agreedHead(cs);
  const views = await Promise.all(cs.map((c) => scanAnchored(c, fromBlock, last, anchor)));
  if (new Set(views.map(canonical)).size !== 1) throw new Error(`enclave boot check failed: RPC providers disagree on the registry's Anchored events up to block ${last}`);
  return { ...views[0], scannedTo: Number(last) };
}

type Row = EnclaveRow & { seq: string; kind: string; ref: string | null };
const hexOf = (b: Buffer | null) => (b ? b.toString("hex") : "");

export async function bootCheck(path = HEAD_FILE.path) {
  const file = readHead(path);
  const { found, foreign, scannedTo } = await latestAnchored(BigInt(file?.scannedTo ?? d.startBlock));
  // nothing to hold the DB to: a first boot (anchors so far came from another key) or a lost disk. Anchor at once (bootAnchor)
  const needsAnchor = !found && !file?.anchored;
  if (needsAnchor && !file) {
    if (foreign) await alert(`Enclave boot: no root anchored by this enclave's anchor key and no disk head, but the registry has ${foreign} Anchored event(s) from other senders. Expected only on the first enclave boot; otherwise the DB chain is unchecked: compare it with the last anchored root before trusting it.`);
  }
  const targets = [...new Set([found?.root, file?.ehash].filter((x): x is string => !!x))];
  const fail = (why: string) => { throw new Error(`enclave boot check failed: ${why}. Refusing to start (a human must look at the DB).`); };
  let from = "0";
  if (targets.length) {
    const rows = await sql<{ seq: string; h: string }[]>`select seq::text, encode(ehash, 'hex') as h from log where ehash is not null and encode(ehash, 'hex') = any(${targets})`;
    for (const t of targets) if (!rows.some((r) => r.h === t)) fail(`${t === found?.root ? `the latest anchored root ${t} (block ${found!.block})` : `the disk head ${t}`} is not in the DB`);
    from = rows.reduce((m, r) => (BigInt(r.seq) < BigInt(m) ? r.seq : m), rows[0].seq);
  }
  const signer = signerAddress();
  const prevOf = new Map<string, string>();
  let head: Row | undefined;
  let skipped = 0;
  // before `from`: hash-only (ehash recomputes), indexed by ehash for the walk back from the first verified record
  const older = new Map<string, { seq: string; kind: string; ref: string | null; eprev: string }>();
  for await (const rows of sql<Row[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where ehash is not null and seq < ${from} order by log.seq`.cursor(1000)) {
    for (const r of rows) if (r.eprev && chainHash(r.eprev, r.body).equals(r.ehash!)) older.set(hexOf(r.ehash), { seq: r.seq, kind: r.kind, ref: r.ref, eprev: hexOf(r.eprev) });
  }
  let first: Row | undefined;
  for await (const rows of sql<Row[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where ehash is not null and seq >= ${from} order by log.seq`.cursor(1000)) {
    for (const r of rows) {
      if (!(await recordOk(r, signer))) { skipped++; continue; } // foreign or tampered: never a link
      if (head && !r.eprev!.equals(head.ehash!)) fail(`enclave record seq ${r.seq} does not link to the previous enclave record ${head.seq} (a fork or a rollback)`);
      prevOf.set(hexOf(r.ehash), hexOf(r.eprev));
      noteNewest(r.kind, r.ref, r.seq);
      first ??= r;
      head = r;
    }
  }
  const genesis = GENESIS.toString("hex");
  for (let h = first ? hexOf(first.eprev) : genesis; h !== genesis;) {
    const o = older.get(h);
    if (!o) fail(`the enclave chain before seq ${first!.seq} is incomplete (record ${h} is missing)`);
    noteNewest(o!.kind, o!.ref, o!.seq);
    h = o!.eprev;
  }
  const missing = unreached(head && hexOf(head.ehash), prevOf, targets);
  if (missing.length) fail(`the DB head does not descend from ${missing.join(", ")}`);
  if (skipped) await alert(`Enclave boot: skipped ${skipped} foreign or tampered log row(s) after seq ${from} (not part of the enclave chain).`);
  const h = head ? { ehash: hexOf(head.ehash), seq: head.seq } : undefined;
  setHead(h);
  Object.assign(HEAD_FILE, { active: path, scannedTo, anchored: !needsAnchor });
  AGENT_HOLD.why = needsAnchor ? "first boot: the boot anchor is not mined yet" : null;
  return { head: h, anchored: found, scannedTo, needsAnchor };
}

/** First boot / lost disk: anchor the enclave's first verified 'mode env' record now, whatever the mode (an anchor only
 *  restricts: it pins the chain), and release agent txs once it is mined. The heartbeat retries until it is. */
export async function bootAnchor() {
  const signer = signerAddress();
  let r: Row | undefined;
  for (const x of await sql<Row[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where kind = 'mode' and ref = 'env' and ehash is not null order by log.seq limit 50`) {
    if (await recordOk(x, signer)) { r = x; break; }
  }
  if (!r) throw new Error("boot anchor: no verified 'mode env' record yet");
  const root = hexOf(r.ehash);
  const s = await send({ key: "anchor", to: d.registry, abi: abi.registryAbi, fn: "anchor", args: [`0x${root}`, `${LOG_BASE_URL}/api/log/${r.seq}`], purpose: `anchor:boot:${r.seq}`, anyMode: true });
  if (s.status !== "mined") throw new Error(`boot anchor ${s.status}: ${s.error ?? s.hash ?? ""}`);
  HEAD_FILE.anchored = true;
  await append("anchor", `boot:${r.seq}`, { kind: "boot", root, seq: r.seq, hash: s.hash ?? null }); // its sync writes `anchored`
  syncHead();
  AGENT_HOLD.why = null;
  return s;
}

const DISK_HOLD = "the disk head could not be written";
/** syncHead for the append and heartbeat paths: a failed write (disk full) never throws, but holds agent txs while the
 *  disk head lags the records they rest on, released by the next write that succeeds. @returns the error, if any */
export function persistHead(scannedTo?: number): string | null {
  try {
    syncHead(scannedTo);
    if (AGENT_HOLD.why === DISK_HOLD) AGENT_HOLD.why = null;
    return null;
  } catch (e) {
    AGENT_HOLD.why ??= DISK_HOLD; // a boot-anchor hold already in place stays (it is released by its own mined anchor)
    return (e as Error).message;
  }
}

/** Every append and the heartbeat: the enclave's own head (the boot-verified head, advanced only by its appends) → the
 *  disk head, never a lower seq (the DB's newest row is not asked: it could be a fork). Nothing before a boot check. */
export function syncHead(scannedTo?: number, path = HEAD_FILE.active) {
  const h = enclaveHead();
  if (!h || !path) return;
  const file = readHead(path);
  if (file && BigInt(h.seq) < BigInt(file.seq)) return;
  writeHead({ ...h, scannedTo: scannedTo ?? file?.scannedTo ?? HEAD_FILE.scannedTo, ...(HEAD_FILE.anchored || file?.anchored ? { anchored: true } : {}) }, path);
}
