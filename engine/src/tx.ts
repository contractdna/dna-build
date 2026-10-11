// Transaction sender. One viem wallet per key (agent, anchor, keeper) from env; one in-flight tx per key (an
// in-process mutex, on top of the job lanes); nonce from the chain ('latest', so a stuck tx is replaced, not queued
// behind); fees from eth_feeHistory (quoteFees: a percentile tip with a floor, 2× the base fee); fee bump ×1.25 merged
// with a fresh quote after TX_BUMP_BLOCKS blocks; gas guard; daily gas cap per key. Every outcome is a `tx` log
// record; a `pending` record is written before polling so a crash/timeout never re-sends blindly. dry_run stops after
// estimateGas (= eth_call with gas accounting). Only a revert counts as a simulation result; RPC errors throw (retry).
import { type Abi, type Address, BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, defineChain, encodeFunctionData, encodePacked, ExecutionRevertedError, fallback, formatEther, formatGwei, type Hex, http, keccak256, parseAbi, parseEther, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as abi from "./abi.ts";
import { CHAIN_ID, d, GAS, type KeyName, KEYS, RPC_URLS } from "./config.ts";
import { edb as sql } from "./db.ts";
import { Defer, enqueue } from "./jobs.ts";
import { append } from "./log.ts";
import { mode } from "./mode.ts";

const chain = defineChain({ id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: RPC_URLS } } });
const transport = fallback(RPC_URLS.map((u) => http(u, { retryCount: 2 })));
export const pub = createPublicClient({ chain, transport, cacheTime: 0 }); // fresh block numbers for the bump check

const accounts = Object.fromEntries(Object.entries(KEYS).filter(([, k]) => k).map(([n, k]) => [n, privateKeyToAccount(k!)])) as Partial<Record<KeyName, ReturnType<typeof privateKeyToAccount>>>;
export const addressOf = (k: KeyName): Address | undefined => accounts[k]?.address;
const wallets = Object.fromEntries(Object.entries(accounts).map(([n, account]) => [n, createWalletClient({ account, chain, transport })]));

export type Call = {
  key: KeyName;
  to: Address;
  abi: Abi | readonly unknown[];
  fn: string;
  args?: readonly unknown[];
  value?: bigint;
  purpose: string; // e.g. 'keeper:distribute'
  valueMoved?: bigint; // wei the call moves, for the gas-vs-value guard (keepers)
  emergency?: boolean; // breaker rollback: emergency gas ceiling, no value guard
  since?: Date; // when the work became due (job created_at): past GAS.maxDelayMs the guard yields
  anyMode?: boolean; // the enclave's boot anchor: sent live whatever the mode (it only pins the log)
  gasMin?: bigint; // a gas-limit floor over the estimate: a call whose real cost can exceed what eth_estimateGas saw (settle)
  // re-send at this exact nonce (an earlier attempt of the same call that may still land: only one of them can be
  // mined); refused (final) once the chain has used that nonce
  replaces?: { nonce: number; maxFee: string; tip: string };
};
/** Set while agent txs must wait (the enclave's boot anchor is not mined yet: src/head.ts). */
export const AGENT_HOLD = { why: null as string | null };
export type Sent = { status: "mined" | "reverted" | "dry_run" | "sim_revert"; hash?: Hex; error?: string };

/** Pure gas guard. `maxFee` is the price the tx is expected to pay (send() passes next base fee + tip). Returns why
 *  the tx should wait, or null to send now. */
export function gasGuard(o: { maxFee: bigint; gas: bigint; valueMoved?: bigint; emergency?: boolean; ageMs: number }, g: Pick<typeof GAS, "maxGwei" | "emergencyMaxGwei" | "valuePct" | "maxDelayMs"> = GAS): string | null {
  const overdue = o.ageMs >= g.maxDelayMs;
  const ceiling = parseGwei(String(o.emergency || overdue ? g.emergencyMaxGwei : g.maxGwei));
  if (o.maxFee > ceiling) return `maxFee ${formatGwei(o.maxFee)} gwei > ${formatGwei(ceiling)} gwei`;
  if (!o.emergency && !overdue && o.valueMoved !== undefined) {
    const cost = o.gas * o.maxFee;
    // cost ≤ pct% of value, in integer math: cost·10000 ≤ value·pct·100
    if (cost * 10_000n > o.valueMoved * BigInt(Math.round(g.valuePct * 100))) return `gas ${formatEther(cost)} ETH > ${g.valuePct}% of ${formatEther(o.valueMoved)} ETH`;
  }
  return null;
}

export const ROLES_ABI = parseAbi([
  "function isModuleEnabled(address module) view returns (bool)",
  "function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)",
]);
/** Pure: may the funder key send this? Only to Roles (queue a fund) or Delay (skipExpired), and only while Roles still
 *  has it as an enabled module (Roles enables a module when it assigns it a role; the Safe disabling the module shows
 *  here). Revoking the role alone leaves the module enabled: Roles then refuses the call itself (NoMembership), which
 *  the send's simulation sees as a sim_revert and src/funding.ts alerts on. */
export function funderCheck(to: Address, enabled: boolean, dep: { roles?: Address; delay?: Address }) {
  if (!dep.roles || !dep.delay) return "no Roles / Delay in the deployment";
  if (![dep.roles, dep.delay].some((a) => a.toLowerCase() === to.toLowerCase())) return `the funder key only calls Roles or Delay, not ${to}`;
  return enabled ? null : "the funder key is no longer an enabled module on Roles";
}

/** Pure: is the registry still pointing at our agent key, unpaused? */
export const agentCheck = (onchain: Address, paused: boolean, ours: Address) =>
  onchain.toLowerCase() !== ours.toLowerCase() ? `registry.agent() is ${onchain}, not our key ${ours}` : paused ? "agent is paused" : null;

const dailyCap = (key: KeyName) => parseEther(String(GAS.dailyCapEth[key]));
const startOfUtcDay = (t = Date.now()) => new Date(Math.floor(t / 86_400_000) * 86_400_000);
const msToTomorrow = () => startOfUtcDay().getTime() + 86_400_000 - Date.now() + 60_000;

/** Wei spent today (UTC) by `key` on live txs, from the log. */
export async function spentToday(key: KeyName) {
  const [r] = await sql<{ wei: string | null }[]>`select sum((doc->>'costWei')::numeric)::text as wei from log
    where kind = 'tx' and at >= ${startOfUtcDay()} and doc->>'key' = ${key} and doc->>'mode' = 'live'`;
  return BigInt(r?.wei ?? 0);
}

const locks: Partial<Record<KeyName, Promise<unknown>>> = {};
function serialize<T>(key: KeyName, fn: () => Promise<T>): Promise<T> {
  const run = (locks[key] ?? Promise.resolve()).then(fn, fn);
  locks[key] = run.catch(() => {});
  return run;
}

/** Only a revert (the call itself fails) is a simulation result; RPC/network errors must throw so the job retries. */
export const isRevert = (e: unknown) =>
  e instanceof BaseError && !!e.walk((x) => x instanceof ExecutionRevertedError || x instanceof ContractFunctionRevertedError);

type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Fees for a replacement (+25%, ≥ the +10% nodes require), capped at the ceiling; null = the capped bump would be
 *  under +10% (nodes refuse it as underpriced): keep waiting on what was sent instead of re-sending. */
export function nextFees(f: Fees, ceiling: bigint) {
  const up = (x: bigint) => (x * 125n) / 100n;
  const maxFeePerGas = min(up(f.maxFeePerGas), ceiling);
  if (maxFeePerGas <= f.maxFeePerGas || maxFeePerGas * 10n < f.maxFeePerGas * 11n) return null;
  return { maxFeePerGas, maxPriorityFeePerGas: min(up(f.maxPriorityFeePerGas), maxFeePerGas) };
}

/** Pure: the fees of a replacement: per field the higher of the pending fees ×1.25 (nextFees) and a fresh quote capped
 *  at the ceiling. Both fields clear the +10% nodes require, and a pending tip of 0 (×1.25 = 0) still rises to the
 *  quote's floor (or to `floor` when there is no fresh quote). null = no valid replacement under the ceiling: keep
 *  waiting on what was sent. */
export function bumpFees(pending: Fees, fresh: Fees | null, ceiling: bigint, floor = 0n): Fees | null {
  const nf = nextFees(pending, ceiling);
  if (!nf) return null;
  const maxFeePerGas = fresh ? max(nf.maxFeePerGas, min(fresh.maxFeePerGas, ceiling)) : nf.maxFeePerGas;
  const tip = max(max(nf.maxPriorityFeePerGas, fresh?.maxPriorityFeePerGas ?? 0n), floor);
  return { maxFeePerGas, maxPriorityFeePerGas: min(tip, maxFeePerGas) };
}

/** eth_feeHistory as viem returns it, plus the reward percentiles that were asked for (one reward column each). */
export type FeeHistory = { baseFeePerGas: bigint[]; gasUsedRatio: number[]; reward?: bigint[][]; rewardPercentiles: number[] };
/** Pure: fees from eth_feeHistory, never from eth_maxPriorityFeePerGas (0 or a few thousand wei on public RPCs, and a
 *  0 tip is refused by geth pools). Tip = the upper median over the blocks of the reward at `percentile` (blocks under
 *  10% full ignored), never below `floorWei`; maxFee = mult × max(latest, next base fee) + tip; `expected` = next base
 *  fee + tip, what the gas guard prices. Throws on a missing or zero base fee or malformed data (the job retries). */
export function quoteFees(h: FeeHistory, o: { floorWei: bigint; mult: number; percentile: number }) {
  if (o.floorWei <= 0n || !(o.mult >= 1)) throw new Error(`fee quote: tip floor ${o.floorWei} wei must be > 0 and base fee multiplier ${o.mult} ≥ 1`);
  const base = h.baseFeePerGas;
  if (!Array.isArray(base) || base.length < 2 || base.some((b) => typeof b !== "bigint" || b <= 0n)) throw new Error("fee quote: missing or zero base fee");
  const col = h.rewardPercentiles.indexOf(o.percentile);
  if (col < 0 || !Array.isArray(h.gasUsedRatio)) throw new Error(`fee quote: malformed (percentile ${o.percentile} not asked, or no gasUsedRatio)`);
  if (h.reward !== undefined && (!Array.isArray(h.reward) || h.reward.some((r) => !Array.isArray(r) || typeof r[col] !== "bigint"))) throw new Error("fee quote: malformed reward rows");
  const tips = (h.reward ?? []).filter((_, i) => (h.gasUsedRatio[i] ?? 1) >= 0.1).map((r) => r[col]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tip = max(tips[tips.length >> 1] ?? 0n, o.floorWei);
  const [latest, next] = base.slice(-2);
  return { maxFeePerGas: (max(latest, next) * BigInt(Math.round(o.mult * 100))) / 100n + tip, maxPriorityFeePerGas: tip, expected: next + tip };
}

/** A fee quote from the chain (GAS.tip*, feeBlocks, baseFeeMult); `emergency` takes the high percentile and floor. */
async function fees(emergency?: boolean) {
  const percentile = emergency ? GAS.emergencyTipPercentile : GAS.tipPercentile;
  const h = await pub.getFeeHistory({ blockCount: GAS.feeBlocks, blockTag: "latest", rewardPercentiles: [percentile] });
  return quoteFees({ ...h, rewardPercentiles: [percentile] }, { floorWei: tipFloor(emergency), mult: GAS.baseFeeMult, percentile });
}
const tipFloor = (emergency?: boolean) => parseGwei(String(emergency ? GAS.emergencyTipFloorGwei : GAS.tipFloorGwei));

export async function send(c: Call): Promise<Sent> {
  const m = c.anyMode ? "live" : await mode();
  if (m === "halted") throw new Defer(10 * 60_000, "engine halted");
  if (c.key === "agent" && AGENT_HOLD.why) throw new Defer(60_000, AGENT_HOLD.why);
  const account = accounts[c.key];
  if (!account) throw new Error(`no ${c.key} key configured (${c.key.toUpperCase()}_PRIVATE_KEY)`);
  if (c.key === "agent") {
    const [onchain, paused] = await Promise.all([
      pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "agent" }),
      pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "agentPaused" }),
    ]);
    const why = agentCheck(onchain, paused, account.address);
    if (why) throw new Error(`refusing agent tx: ${why}`);
  }
  if (c.key === "funder") {
    const enabled = d.roles ? await pub.readContract({ address: d.roles, abi: ROLES_ABI, functionName: "isModuleEnabled", args: [account.address] }) : false;
    const why = funderCheck(c.to, enabled, d);
    if (why) {
      await enqueue("alert", { text: `Refusing a funder tx (${c.purpose}): ${why}.` }, { dedupeKey: `alert:funder:${new Date().toISOString().slice(0, 13)}` });
      throw Object.assign(new Error(`refusing funder tx: ${why}`), { final: true });
    }
  }
  const data = encodeFunctionData({ abi: c.abi as Abi, functionName: c.fn, args: c.args as never });
  const call = keccak256(encodePacked(["address", "bytes", "uint256"], [c.to, data, c.value ?? 0n])); // identity of this exact call
  const rec = { key: c.key, from: account.address, to: c.to, fn: c.fn, args: c.args ?? [], value: c.value ?? 0n, purpose: c.purpose, call };
  if (m === "live") {
    const done = await serialize(c.key, () => resolvePending(c.key, call));
    if (done) return done; // an earlier attempt of this exact call already landed
  }
  let gas: bigint;
  try {
    gas = await pub.estimateGas({ account: account.address, to: c.to, data, value: c.value });
  } catch (e) {
    if (!isRevert(e)) throw e;
    const error = ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).slice(0, 500);
    await append("tx", c.purpose, { ...rec, mode: m, status: "sim_revert", error });
    return { status: "sim_revert", error };
  }
  // the floor, before every guard: the gas guard prices the floored estimate; the daily cap reserves the limit sent
  // (gasLimit: max(raw estimate × 1.2, floor), the most the tx can burn), as the replacement and bump checks do
  const priced = c.gasMin && c.gasMin > gas ? c.gasMin : gas;
  const q = await fees(c.emergency);
  if (m === "dry_run") {
    await append("tx", c.purpose, { ...rec, mode: m, status: "dry_run", gas: priced, maxFee: q.maxFeePerGas, tip: q.maxPriorityFeePerGas });
    return { status: "dry_run" };
  }
  // the guard prices what the tx is expected to pay (next base fee + tip), not the buffered maxFee
  const ageMs = Date.now() - (c.since?.getTime() ?? Date.now());
  const why = gasGuard({ maxFee: q.expected, gas: priced, valueMoved: c.valueMoved, emergency: c.emergency, ageMs });
  if (why) throw new Defer(15 * 60_000, `gas guard: ${why}`);
  // the ceiling the guard used: emergency, or deferred past GAS.maxDelayMs; maxFee never goes above it
  const ceiling = parseGwei(String(c.emergency || ageMs >= GAS.maxDelayMs ? GAS.emergencyMaxGwei : GAS.maxGwei));
  if ((await spentToday(c.key)) + gasLimit(gas, c.gasMin) * min(q.maxFeePerGas, ceiling) > dailyCap(c.key)) throw new Defer(msToTomorrow(), `daily gas cap ${GAS.dailyCapEth[c.key]} ETH reached for ${c.key}`);
  return serialize(c.key, () => broadcast(c, rec, data, gas, q, ceiling));
}

type Pending = { status: string; call: Hex; nonce: number; hashes: Hex[]; maxFee: string; tip: string; purpose: string };
const lastLive = async (key: KeyName) =>
  (await sql<{ doc: Pending & Record<string, unknown> }[]>`select doc from log where kind = 'tx' and doc->>'key' = ${key} and doc->>'mode' = 'live' order by log.seq desc limit 1`)[0]?.doc;

/** A crash or timeout can leave a broadcast tx without an outcome record (its last record is `pending`). Before this
 *  key sends again: record the outcome if one of its hashes landed (and return it when it is this same call), flag
 *  an unknown fate if its nonce was consumed by something else, else leave the nonce to be replaced by this send. */
async function resolvePending(key: KeyName, call: Hex): Promise<Sent | null> {
  const p = await lastLive(key);
  if (p?.status !== "pending") return null;
  for (const hash of p.hashes) {
    const r = await pub.getTransactionReceipt({ hash }).catch(() => undefined);
    if (!r) continue;
    const status = r.status === "success" ? "mined" : "reverted";
    await append("tx", p.purpose, { ...p, status, hash, block: r.blockNumber, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, costWei: r.gasUsed * r.effectiveGasPrice, resolved: true });
    return p.call === call ? { status, hash } : null;
  }
  const next = await pub.getTransactionCount({ address: addressOf(key)!, blockTag: "latest" });
  if (next > p.nonce) {
    await append("tx", p.purpose, { ...p, status: "unknown", note: "nonce consumed by a tx we did not record" });
    if (p.call === call) throw Object.assign(new Error(`earlier ${p.purpose} tx (nonce ${p.nonce}) has an unknown fate: check the chain`), { final: true });
  }
  return null;
}

/** The limit sent: the estimate × 1.2, never below the call's floor. */
export const gasLimit = (estimate: bigint, gasMin = 0n) => ((estimate * 12n) / 10n > gasMin ? (estimate * 12n) / 10n : gasMin);

async function broadcast(c: Call, rec: Record<string, unknown>, data: Hex, gas: bigint, q: Fees, ceiling: bigint): Promise<Sent> {
  const wallet = wallets[c.key]!;
  const account = accounts[c.key]!;
  const latest = await pub.getTransactionCount({ address: account.address, blockTag: "latest" });
  if (c.replaces && latest > c.replaces.nonce) throw Object.assign(new Error(`nonce ${c.replaces.nonce} is already used: the earlier attempt is settled`), { final: true });
  const nonce = c.replaces?.nonce ?? latest;
  const capped = min(q.maxFeePerGas, ceiling); // the guard passed on the expected price; the buffer stops at the ceiling
  let f: Fees = { maxFeePerGas: capped, maxPriorityFeePerGas: min(q.maxPriorityFeePerGas, capped) };
  const prev = c.replaces ? { status: "pending", nonce, maxFee: c.replaces.maxFee, tip: c.replaces.tip } : await lastLive(c.key);
  if (prev?.status === "pending" && prev.nonce === nonce) {
    // still unmined: this send replaces it, so it must outbid it on both fields; a pending tip of 0 rises to this
    // quote's tip. At the ceiling no replacement is accepted: wait on it instead of sending into "underpriced"
    const nf = bumpFees({ maxFeePerGas: BigInt(prev.maxFee), maxPriorityFeePerGas: BigInt(prev.tip) }, f, ceiling, tipFloor(c.emergency));
    if (!nf) throw new Defer(5 * 60_000, `pending nonce ${nonce} at the ceiling (maxFee ${formatGwei(BigInt(prev.maxFee))} gwei): waiting for it`);
    if ((await spentToday(c.key)) + gasLimit(gas, c.gasMin) * nf.maxFeePerGas > dailyCap(c.key)) throw new Defer(msToTomorrow(), `daily gas cap ${GAS.dailyCapEth[c.key]} ETH reached for ${c.key} (replacing pending nonce ${nonce})`);
    f = nf;
  }
  const hashes: Hex[] = [];
  const deadline = Date.now() + GAS.timeoutMs;
  let resend = true;
  let sent = f; // the fees of the newest accepted hash: a refused replacement does not advance the record
  for (;;) {
    if (resend) {
      let note: string | undefined;
      try {
        hashes.push(await wallet.sendTransaction({ account, chain, to: c.to, data, value: c.value, gas: gasLimit(gas, c.gasMin), nonce, ...f }));
        sent = f;
      } catch (e) {
        // 'nonce too low' = an earlier hash of ours (or a manual tx) took the nonce: fall through to the receipt check;
        // 'underpriced' = a node refused the replacement: polling goes on with the earlier hashes, and the record says so
        const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
        if (!/nonce too low|already known|underpriced/i.test((e as Error).message) || !hashes.length) throw e;
        note = `replacement not accepted: ${msg.slice(0, 200)}`;
        console.warn(`${c.purpose} nonce ${nonce}: ${note}`);
      }
      // written before polling: a crash or timeout from here on is resolved by resolvePending, not re-sent blindly
      await append("tx", c.purpose, { ...rec, mode: "live", status: "pending", nonce, hashes, maxFee: sent.maxFeePerGas, tip: sent.maxPriorityFeePerGas, ...(note ? { note } : {}) });
    }
    const sentAt = await pub.getBlockNumber();
    // the receipts are checked at least once after each send, even past the deadline: a slow broadcast or record write
    // must not report a tx that is already mined as unmined
    for (;;) {
      for (const hash of hashes) {
        const r = await pub.getTransactionReceipt({ hash }).catch(() => undefined);
        if (!r) continue;
        const status = r.status === "success" ? "mined" : "reverted";
        await append("tx", c.purpose, {
          ...rec, mode: "live", status, hash, nonce, block: r.blockNumber, gasUsed: r.gasUsed,
          effectiveGasPrice: r.effectiveGasPrice, costWei: r.gasUsed * r.effectiveGasPrice, bumps: hashes.length - 1,
        });
        return { status, hash };
      }
      if (Date.now() >= deadline || (await pub.getBlockNumber()) >= sentAt + BigInt(GAS.bumpBlocks)) break;
      await new Promise((r) => setTimeout(r, GAS.pollMs));
    }
    if (Date.now() >= deadline) throw new Error(`tx not mined in ${GAS.timeoutMs / 1000} s (nonce ${nonce}, ${hashes.join(",")}); the next attempt resolves it first`);
    // ×1.25 merged with a fresh quote (a failed re-quote must not stop the bump; the tip floor still applies), within the
    // day's gas cap: past it, keep waiting at the current fees
    let nf = bumpFees(f, await fees(c.emergency).catch(() => null), ceiling, tipFloor(c.emergency));
    if (nf && (await spentToday(c.key)) + gasLimit(gas, c.gasMin) * nf.maxFeePerGas > dailyCap(c.key)) nf = null;
    resend = nf !== null;
    if (nf) f = nf;
  }
}

/** ETH balance of each configured key. */
export async function balances() {
  return Object.fromEntries(await Promise.all(Object.entries(accounts).map(async ([n, a]) => [n, Number(formatEther(await pub.getBalance({ address: a.address })))]))) as Partial<Record<KeyName, number>>;
}
