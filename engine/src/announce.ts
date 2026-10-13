// Public announcements: everything that matters reaches the site at once and X by priority.
//  - The site: one `announce` log record per event key, with a plain-text title built by code from the fact sheet (no
//    model), the tx link and, where there is one, a proof link.
//  - X: the outbox drains by priority (money > ballot / mystery results and games > the sequencer and experiments >
//    status, recap and milestones > everything else) within the daily cap, keeping the day's last post for a digest
//    of what did not fit (src/x.ts). Nothing is dropped.
import { IDEAS_LIVE, LLM, LOG_BASE_URL, X } from "./config.ts";
import { edb as sql } from "./db.ts";
import { publicTextIssues, utf8Cut } from "./llm.ts";
import { ENCLAVE } from "./enclave.ts";
import { append } from "./log.ts";
import { VAULT_TYPE } from "./vaults.ts";

/** X priority per announcement type (lower first). */
export const PRIORITY: Record<string, number> = {
  // a take on crypto Twitter (src/ct.ts): after every event, the progress post included
  ct: 4.5,
  jackpot_drawn: 1, reward_paid: 1, idea_round: 1, prize_expired: 1, prize_claimed: 1, jackpot_voided: 1,
  jackpot_params: 2, jackpot_list: 2,
  ballot_result: 2, mystery_revealed: 2, mystery_result: 2, ballot_opened: 2,
  outcome: 3, queued: 3, test_live: 3, cancelled: 3, rolled_back: 3,
  // a change to the engine's own code or to the rules it runs under (src/upgrades.ts): first, while its hour runs
  update_queued: 0.9, update_allowed: 0.9, update_running: 0.9, update_cancelled: 0.9, change_queued: 0.9, change_cancelled: 0.9, change_done: 0.9, day_changes: 3,
  // the Sequencer: a new game and a retired one go to X with the games; a day with nothing good enough too
  seq_shipped: 2, game_retired: 2, seq_nothing_today: 3,
  // the sequencer: switched on (once), a build started (round 1) and one that missed the bar; self-improvement only
  // once it ships (a site change live), is proposed to the Safe (a module), or is handed to the owners (an engine change)
  seq_online: 3, site_changed: 3, seq_started: 3, seq_killed: 3, seq_released: 3, seq_handoff: 3,
  // module code the Safe approved by hash (a chain event): it can be registered, nothing is live yet
  module_approved: 3,
  // the twice-daily status, the weekly recap and milestones: below money and games, above the rest
  status: 3.5, recap: 3.5, milestone: 3.5,
  // the nightly reflection after the day's journal
  reflection: 3.5,
  // the social layer (src/x-social.ts): the idea of the day and the weekly idea-givers' shoutout
  idea_of_day: 3.5, shoutout: 3.5,
  // launch day (src/status.ts): the engine going live is the opening post (first of all, once), then the Safe's first
  // batch (once)
  online: 0.5, contracts_connected: 1,
  // once-ever firsts (src/status.ts FIRST_KEYS): announce-worthy, each once
  keys_handed: 1, first_idea_round: 1, first_burn: 1,
  fees_distributed: 3.5, burn_summary: 3.5, liquidity_added: 3.5,
  // the treasury's DNA (src/status.ts treasuryFacts): a buy on the pool, a transfer out
  treasury_buy: 3.5, treasury_transfer: 3.5,
  // the Genome Vaults (src/vaults.ts): the Safe's fund is money; a mint and a burn go with the games
  vault_funded: 1, vault_minted: 2, vault_burned: 2,
  // the lab (src/lab.ts): the brain's simulated fee candidates, every 2 h on a launch day, every 6 h after
  lab: 3.5,
  // chain progress, one combined post every 6 h (src/status.ts)
  progress_day: 3.5,
  // live idea mode (config.ts IDEA_MODE): a site idea's verdict and an idea the brain chose not to build go out too, and
  // every step of a build (its pull request, each verdict), so the whole way from idea to game is in public
  ...(IDEAS_LIVE ? { idea_judged: 3.5, seq_declined: 3, seq_pr: 3, seq_verdict: 3 } : {}),
};
/** Goes to X (by priority): every type with a priority. The rest (the Sequencer's per-round steps, accepted ideas,
 *  wallet links) stays on the site. */
export const onX = (type: string) => type in PRIORITY;

/** The Sequencer's announcement facts (what its state machine passes to announce(); W6's notebook reads them back).
 *  Every one names the signed record it rests on (`record`: that log record's seq, a decimal string, what
 *  GET /api/log/<seq> takes, the X post's proof link). Site only, except the types in PRIORITY above. */
export type SeqFacts =
  | { event: "seq_online"; record: string }
  | { event: "seq_started"; build: string; title: string; reason?: string; record: string }
  | { event: "seq_declined"; idea: string; title: string; reason: string; record: string }
  | { event: "seq_killed"; build: string; title: string; rounds: number; record: string }
  | { event: "seq_building"; build: string; title: string; round: number; record: string }
  | { event: "seq_pr"; build: string; title: string; round: number; pr: number; failed: string[]; record: string }
  | { event: "seq_verdict"; build: string; title: string; round: number; verdict: "ship" | "rework" | "kill"; reason: string; record: string }
  | { event: "seq_shipped"; build: string; title: string; slug: string; game: string; fundEth: number | null; record: string }
  | { event: "game_retired"; build: string; title: string; slug: string; game: string; days: number; returnedEth: number | null; record: string; rule?: "idle" | "evict"; idleHours?: number }
  | { event: "seq_nothing_today"; day: string; tried: number; record: string }
  | { event: "seq_released"; build: string; title: string; target: "site" | "module"; record: string }
  | { event: "seq_handoff"; build: string; title: string; pr: number; record: string };
/** The key each Sequencer announcement is stored under (one per build, round and stage; one per day for the empty day;
 *  one ever for switching on). */
export const seqKey = (f: SeqFacts) =>
  f.event === "seq_online" ? "seq:online" : f.event === "seq_nothing_today" ? `seq:nothing:${f.day}` : f.event === "seq_declined" ? `seq:declined:${f.idea}` : "round" in f ? `seq:${f.build}:r${f.round}:${f.event}` : `seq:${f.build}:${f.event}`;
/** A signed log record on the site (the proof link of a post that rests on one). */
export const recordUrl = (seq: string) => `${LOG_BASE_URL}/api/log/${seq}`;
/** The game events by their announcement type (the outbox stores the chain event's name). */
const GAME_TYPE: Record<string, string> = {
  ListPosted: "jackpot_list", Drawn: "jackpot_drawn", DrawVoided: "jackpot_voided", PrizeClaimed: "prize_claimed", PrizeExpired: "prize_expired", RewardPaid: "reward_paid",
  BallotProposed: "ballot_opened", BallotRun: "ballot_result", BallotSkipped: "ballot_result", Sealed: "mystery_sealed", Revealed: "mystery_revealed",
  Run: "mystery_result", Rejected: "mystery_result", RoundFinalized: "idea_round",
};
/** An outbox event's announcement type (before it is resolved). */
export const typeOf = (ev: Record<string, unknown>) => (ev.event === "game" ? GAME_TYPE[String(ev.name)] ?? "game" : ev.event === "vault" ? VAULT_TYPE[String(ev.name)] ?? "vault" : String(ev.event));
/** The digest takes the day's last post slot; it is never in the way of a higher-priority event. */
export const priorityOf = (ev: Record<string, unknown>) => (ev.event === "digest" ? 0 : PRIORITY[typeOf(ev)] ?? 4);
/** Digest buckets. */
export const bucketOf = (type: string) => {
  const p = PRIORITY[type] ?? 4;
  return p === 1 ? "money" : p === 2 ? "games" : p === 3 ? "experiments" : "other";
};

/** Model-written text on one public line: NFKC, no control or format characters, one space between words, at most
 *  max UTF-8 bytes. */
export const plain = (s: unknown, max: number) =>
  utf8Cut(String(s ?? "").normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim(), max);
/** A reason in a line: plain, at most `max` bytes, cut at a word with an ellipsis. */
export const clipReason = (s: unknown, max: number) => { const t = plain(s, 4000); return Buffer.byteLength(t) <= max ? t : `${utf8Cut(t, max - 3).replace(/\s+\S*$/, "")}…`; };
/** A game's title for a line that goes to X: quoted, or null when it is empty or carries a link, handle or cashtag. */
const xTitle = (s: unknown) => { const t = plain(s, 120); return t && !publicTextIssues(t).length ? `"${t}"` : null; };
const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 3 }) : String(v ?? "?"));
/** A status number exactly as the fact sheet holds it (small fee amounts keep their digits). */
const e = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 6 }) : String(v ?? "?"));
const count = (v: unknown, one: string, many: string) => `${e(v)} ${v === 1 ? one : many}`;
/** Chain progress (src/status.ts), each kind present in `f`: fee splits by leg, buybacks and burns, liquidity adds. */
const progressParts = (f: Record<string, unknown>) => [
  f.distributions !== undefined && `${count(f.distributions, "fee distribution", "fee distributions")} sent ${e(f.totalEth)} ETH: ${e(f.buybackEth)} to buyback-and-burn, ${e(f.liquidityEth)} to liquidity, ${e(f.treasuryEth)} to the treasury, ${e(f.gamesEth)} to games`,
  f.buybacks !== undefined && `${count(f.buybacks, "buyback", "buybacks")} spent ${e(f.spentEth)} ETH and burned ${e(f.burnedDna)} DNA`,
  f.adds !== undefined && `${count(f.adds, "liquidity add", "liquidity adds")} put ${e(f.ethAdded)} ETH into the pool`,
].filter((x): x is string => !!x);
/** The live fee for a site line: above the 5% cap it is a launch guard's launch tax; unread, no number. */
const feeLine = (fee: { basePct?: number } | undefined) =>
  typeof fee?.basePct === "number" ? `live fee ${e(fee.basePct)}%${fee.basePct > 5 ? " (the launch tax)" : ""}` : "live fee not read";
/** The site's plain-text line for a resolved fact sheet (code, never a model; every number is the fact's own). The
 *  winners' full addresses come from the raw chain event (the settle's Winner rows). */
export function titleOf(f: Record<string, unknown>, raw: Record<string, unknown> = {}): string {
  const args = (raw.args ?? {}) as Record<string, unknown>;
  switch (f.event) {
    // src/upgrades.ts: code's line, the release notes, the chain's numbers
    case "update_queued": case "update_allowed": case "update_running": case "update_cancelled": case "change_queued": case "change_cancelled": case "change_done": {
      const t = f.activatesAt as { utcHour: number; utcMinute: number } | undefined;
      const when = t ? `; it can land from ${String(t.utcHour).padStart(2, "0")}:${String(t.utcMinute).padStart(2, "0")} UTC unless the Safe cancels it first` : "";
      const notes = Array.isArray(f.notes) && f.notes.length ? `: ${f.notes.map((x) => plain(x, 80)).join("; ")}` : f.event === "update_cancelled" ? "" : " (no release notes yet)";
      if (f.event === "update_queued") return `An update to the engine's code is queued${notes}${when}`;
      if (f.event === "update_allowed") return `The engine update is allowed: the timelock executed it, and the engine switches to it on its next restart${notes}`;
      if (f.event === "update_running") return `The engine update is in: the engine now runs it${notes}`;
      if (f.event === "update_cancelled") return `The Safe cancelled the queued engine update${notes}; nothing changed`;
      const fee = f.fee as { basePct: number; multiplier: number; capPct: number } | undefined, split = f.split as Record<string, number> | undefined;
      const nums = [f.level !== undefined && `level ${e(f.level)}`, f.hours !== undefined && `every ${e(f.hours)} hours`, fee && `base ${e(fee.basePct)}%, multiplier ${e(fee.multiplier)}×, cap ${e(fee.capPct)}%`,
        split && `buyback ${e(split.buybackPct)}%, liquidity ${e(split.liquidityPct)}%, treasury ${e(split.treasuryPct)}%, games ${e(split.gamesPct)}%`].filter(Boolean);
      const what = `${plain(f.change, 160)}${nums.length ? ` (${nums.join("; ")})` : ""}`;
      if (f.event === "change_queued") return `${f.who === "me" ? "The AI proposed" : "The Safe queued"} ${what}${when}`;
      return f.event === "change_cancelled" ? `The Safe cancelled ${what}; nothing changed` : `${f.who === "me" ? "In effect, as the AI proposed" : "The Safe"}: ${what}`;
    }
    case "day_changes": return `What changed on ${f.day}: ${(f.changes as string[]).map((x) => plain(x, 160)).join("; ")}`;
    case "jackpot_params": return `Jackpot window ${f.window} (starts ${f.startsAt}): cap ${n(f.capPct)}% per wallet, minimum average balance ${n(f.minBalance)} DNA, ${f.exchangesExcluded} exchange wallets excluded`;
    case "jackpot_list": return `Jackpot window ${f.window}: ${n(f.holders)} holders, ${n(f.totalTickets)} tickets (cap ${n(f.capPct)}%); the draw opens in ${f.vetoHours} hour`;
    case "jackpot_drawn": {
      const who = ((args.paid ?? []) as { account?: string }[]).map((p) => p.account).filter(Boolean).join(", ");
      return `Jackpot window ${f.window}: ${f.winners} ${f.winners === 1 ? "winner" : "winners"}, ${n(f.shareEth)} ETH each${who ? `: ${who}` : ""}${f.claimable ? `; ${f.claimable} claimable for ${f.claimDays} days` : ""}`;
    }
    case "jackpot_voided": return `Jackpot window ${f.window}: the draw was not settled in 7 days; ${n(f.prizeEth)} ETH returned to the pot`;
    // a claim id is a draw's share or an idea reward whose push failed; no `kind` yet, so the wording names both
    case "prize_claimed": case "prize_expired": {
      const what = f.kind === "prize" ? `Jackpot prize #${f.drawId}` : f.kind === "reward" ? `Idea reward (claim #${f.drawId})` : `Claim #${f.drawId} (a jackpot share or an idea reward)`;
      return f.event === "prize_claimed" ? `${what}: ${n(f.prizeEth)} ETH was claimed` : `${what}: ${n(f.prizeEth)} ETH not claimed in ${f.claimDays} days, went to the jackpot pot`;
    }
    case "reward_paid": {
      const to = typeof args.to === "string" && /^0x[0-9a-fA-F]{40}$/.test(args.to) ? ` to ${args.to.slice(0, 6)}…${args.to.slice(-4)}` : "";
      return `Idea reward paid: ${n(f.rewardEth)} ETH${to}${f.claimable ? `; the wallet could not take it: claim #${f.claim} within ${f.claimDays} days` : ""}`;
    }
    case "ballot_opened": return `New ballot: ${(f.options as string[] | undefined)?.join(" / ") ?? "three options"}; voting opens in ${f.opensInHours} hour and lasts ${f.votingHours} hours`;
    case "ballot_result": return `Ballot #${f.ballot}: "${f.winner ?? "the winning option"}" won with ${n(f.winnerWeight)} of ${n(f.totalWeight)} vote weight; ${f.outcome}`;
    case "mystery_sealed": return `A mystery mutation was sealed; it opens in ${f.revealInDays} days`;
    case "mystery_revealed": return "A mystery mutation was revealed";
    case "mystery_result": return `Mystery #${f.mystery}: ${f.outcome}${f.reason ? ` (${f.reason})` : ""}`;
    case "idea_round": return f.refunded
      ? `Idea round ${f.round}: no idea accepted, every stake refunded`
      : `Idea round ${f.round}: ${f.accepted} of ${f.ideas} ideas accepted; stakers of accepted ideas get their stake back plus ${n(f.payoutPct)}%`;
    case "outcome": return `Experiment on plate ${f.plate}: ${f.outcome}${f.reason ? ` (${f.reason})` : ""}${f.source ? `, from ${f.source}` : ""}`;
    case "queued": return `The AI queued ${f.change ?? "a change"}${f.plate ? ` on plate ${f.plate}` : ""} (op #${f.opId})`;
    case "test_live": return `Test live on plate ${f.plate}: ${f.change}`;
    case "cancelled": return `The Safe cancelled op #${f.opId}`;
    case "rolled_back": return `The ${f.route} module was rolled back`;
    // site only (never queued for X: the daily post cap stays for money and results)
    case "idea_testing": {
      const fee = f.fee as { basePct: number; multiplier: number; capPct: number };
      return `Idea #${f.idea} was accepted and goes into testing on plate ${f.plate}: base ${n(fee.basePct)}%, multiplier ${n(fee.multiplier)}×, cap ${n(fee.capPct)}%`;
    }
    case "binding_linked": return f.change === "rebind"
      ? `X account ${f.xUserId} changed its payout wallet to ${f.wallet}; it takes effect at ${f.effectiveAt}, 48 hours from now, unless the account binds back`
      : f.change === "cancel" ? `X account ${f.xUserId} cancelled its pending wallet change; ${f.wallet} stays` : `X account ${f.xUserId} linked its payout wallet ${f.wallet}`;
    // the Sequencer (src/announce.ts SeqFacts)
    // titles and reasons are model-written: plain() on every one; the X-bound lines drop a title with a link in it
    case "seq_building": return `The sequencer started building "${plain(f.title, 120)}"${Number(f.round) > 1 ? ` (round ${f.round})` : ""}`;
    case "seq_pr": {
      const failed = (Array.isArray(f.failed) ? f.failed : []).filter((g): g is string => typeof g === "string" && /^G\d{1,2}$/.test(g));
      return `"${plain(f.title, 120)}", round ${f.round}: pull request #${f.pr} is up; ${failed.length ? `${failed.length} ${failed.length === 1 ? "check" : "checks"} failed (${failed.join(", ")})` : "every check passed"}`;
    }
    case "seq_verdict": {
      const t = plain(f.title, 120), why = clipReason(f.reason, 160);
      return f.verdict === "ship" ? `The brain approved "${t}". It goes live after one public hour unless the Safe vetoes it`
        : f.verdict === "rework" ? `The brain sent "${t}" back for another round: ${why}` : `The brain dropped "${t}": ${why}`;
    }
    case "seq_shipped": {
      const at = typeof f.game === "string" && /^0x[0-9a-fA-F]{40}$/.test(f.game) ? ` at ${f.game.slice(0, 6)}…${f.game.slice(-4)}` : "";
      const t = xTitle(f.title);
      return `${t ? `New game: ${t} is live` : "A new game is live"}${at}. ${typeof f.fundEth === "number" ? `Its first ${n(f.fundEth)} ETH waits one public hour` : "It is waiting for funding"}`;
    }
    case "game_retired": {
      const t = xTitle(f.title);
      const back = typeof f.returnedEth === "number" ? `; ${n(f.returnedEth)} ETH went back to the treasury (the Safe)` : "";
      // an eviction: a new game took its slot (at most 3 live), not a game nobody played
      if (f.rule === "evict") return `${t ?? "A game"} was retired to make room for a new game: it had the fewest players of the live games${back}. Anything won stays claimable`;
      // the idle rule: live idleHours or more and nobody played in the last idleHours (`days`: its age)
      const idle = typeof f.idleHours === "number" ? `no players in its last ${f.idleHours} hours` : "no recent players";
      return `${t ?? "A game"} was retired: ${idle}, after ${f.days} ${f.days === 1 ? "day" : "days"} live${back}. Anything won stays claimable`;
    }
    case "seq_handoff": return `An engine change the sequencer made waits for an owner's review: "${plain(f.title, 120)}" (pull request #${Number(f.pr)}). It runs only after an owner merges it and the code timelock passes`;
    case "seq_released": return f.target === "module" ? `A fee or split module the sequencer made waits for the Safe: "${plain(f.title, 120)}". Nothing changes until the Safe approves it` : `A site change the sequencer made is live: "${plain(f.title, 120)}"`;
    case "seq_nothing_today": return Number(f.tried) > 0 ? "Nothing good enough today: no new game shipped" : "No new game today: nothing was ready to build";
    case "treasury_buy": return `The treasury (the Safe) bought ${e(f.dnaAmount)} DNA on the pool for ${e(f.ethSpent)} ETH${typeof f.supplyPct === "number" ? ` (${e(f.supplyPct)}% of supply)` : ""}`;
    case "treasury_transfer": {
      const to = typeof f.label === "string" ? plain(f.label, 40) : typeof f.recipient === "string" && /^0x[0-9a-fA-F]{40}$/.test(f.recipient) ? `${f.recipient.slice(0, 6)}…${f.recipient.slice(-4)}` : "a wallet";
      const pct = typeof f.supplyPct === "number" ? ` (${e(f.supplyPct)}% of supply)` : "";
      return typeof f.soldEth === "number" ? `The treasury (the Safe) sold ${e(f.dnaAmount)} DNA${pct} on the pool for ${e(f.soldEth)} ETH` : `The treasury (the Safe) sent ${e(f.dnaAmount)} DNA${pct} to ${to}`;
    }
    case "site_changed": { const s = plain(f.summary, 200); return `The website changed: ${plain(f.title, 60)}${s ? `. ${s}` : ""}`; }
    case "seq_online": return "The sequencer is switched on: it builds up to 3 ideas at once, and a game ships only after every check and one public hour";
    case "seq_started": {
      const t = xTitle(f.title), why = clipReason(f.reason, 200);
      return `${t ? `The sequencer started building ${t}` : "The sequencer started a new build"}${why ? `. Why this one: ${why}` : ""}`;
    }
    case "seq_declined": { const t = xTitle(f.title); return `The sequencer will not build ${t ?? "an accepted idea"}: ${clipReason(f.reason, 200) || "no reason given"}`; }
    case "idea_judged": {
      const t = xTitle(f.title), why = clipReason(f.reason, 200), again = f.again === true ? "Judged again under the new rules: " : "";
      // a variant: the idea could not be built as written; its closest buildable version (the title) is queued instead
      if (f.verdict === "queued" && f.instead) return `${again}Idea #${Number(f.idea)} can't be built as written; its closest buildable version${t ? ` ${t}` : ""} is queued for the sequencer, credited to its author${why ? `: ${why}` : ""}`;
      return f.verdict === "queued" ? `${again}Idea ${t ?? `#${Number(f.idea)}`} was accepted and is queued for the sequencer${why ? `: ${why}` : ""}` : `${again}Idea ${t ?? `#${Number(f.idea)}`} was not taken${why ? `: ${why}` : ""}`;
    }
    case "idea_of_day": return `Idea of the day: ${xTitle(f.title) ?? "an idea from X"}, scored ${n(f.score)} of ${n(f.scoreOf)}`;
    case "shoutout": return `Weekly shoutout to the top ${count(f.givers, "idea-giver", "idea-givers")} on X (${count(f.ideas, "idea", "ideas")} this week)`;
    case "seq_killed": return `The sequencer tried ${xTitle(f.title) ?? "a build"} for ${count(f.rounds, "round", "rounds")}; it did not make the bar and nothing shipped`;
    case "module_approved": {
      const h = typeof f.codehash === "string" && /^0x[0-9a-fA-F]{64}$/.test(f.codehash) ? ` ${f.codehash.slice(0, 6)}…${f.codehash.slice(-4)}` : "";
      return `The Safe approved ${f.kind === "split" ? "split" : "fee"} module code${h}. It can now be registered and tested on a plate; the live fee is unchanged`;
    }
    // src/status.ts: every number is code's (chain rows, the snapshot, signed records)
    case "status": {
      const fee = f.liveFee as { basePct?: number } | undefined;
      const t = f.testing as { stage?: string; plate?: string } | undefined;
      const dev = (f.devTeam ?? {}) as { stage?: string; round?: number; title?: string };
      const title = xTitle(dev.title);
      const team = dev.stage === "idle" || !dev.stage ? "the sequencer is idle"
        : `the sequencer is ${dev.stage === "shipping" ? "shipping" : "building"}${title ? ` ${title}` : ""}${dev.round ? ` (round ${dev.round})` : ""}`;
      return `Last ${f.hours} h: ${count(f.swaps, "swap", "swaps")}, ${e(f.volumeEth)} ETH volume, ${e(f.feesEth)} ETH in fees, ${e(f.burnedDna)} DNA burned; buyback pot ${e(f.buybackPotEth)} ETH${typeof f.jackpotPotEth === "number" ? `, jackpot pot ${e(f.jackpotPotEth)} ETH` : ""}; `
        + `${count(f.gamesLive, "game", "games")} live; ${feeLine(fee)}${t?.stage ? ` (${t.stage} on plate ${t.plate})` : ""}; ${team}`
        + (typeof f.launchTaxEth === "number" ? `; ${count(f.launchTaxSwaps, "swap", "swaps")} paid the launch tax (${e(f.launchTaxVolumeEth)} ETH volume): ${e(f.launchTaxEth)} ETH sent to buyback-and-burn` : "");
    }
    case "recap": {
      const more = [[f.modulesProposed, "module proposed to the Safe", "modules proposed to the Safe"], [f.modulesApproved, "module approved", "modules approved"], [f.handedOver, "engine change handed over", "engine changes handed over"]]
        .filter(([v]) => Number(v) > 0).map(([v, one, many]) => `, ${count(v, String(one), String(many))}`).join("");
      return `Week: ${count(f.gamesShipped, "game shipped", "games shipped")}, ${count(f.siteChanges, "site change", "site changes")}${more}, ${count(f.buildsKilled, "build killed", "builds killed")}, ${count(f.gamesRetired, "game retired", "games retired")}; `
        + `experiments ${e(f.experimentsKept)} kept, ${e(f.experimentsKilled)} killed; ${count(f.gamesLive, "game", "games")} live, ${feeLine(f.liveFee as { basePct?: number } | undefined)}`;
    }
    // launch day and chain progress (src/status.ts): code's words, the chain's numbers
    case "reflection": return `Nightly reflection for ${f.date}: learned: ${plain(f.learned, 200) || "nothing new"}; next: ${plain(f.tomorrow, 200) || "observe"}`;
    case "lab": {
      const b = (f.best ?? {}) as { fee?: { basePct?: number; multiplier?: number; capPct?: number }; ethUpPct?: number; ethDownPct?: number; swapsUpPct?: number; swapsDownPct?: number; verdict?: string };
      const move = (up: unknown, down: unknown) => (typeof up === "number" ? `+${e(up)}%` : typeof down === "number" ? `-${e(down)}%` : "?");
      const best = b.fee ? `; best in simulation: base ${e(b.fee.basePct)}%, multiplier ${e(b.fee.multiplier)}×, cap ${e(b.fee.capPct)}%: ETH a day ${move(b.ethUpPct, b.ethDownPct)}, swaps ${move(b.swapsUpPct, b.swapsDownPct)}${b.verdict ? ` (${b.verdict})` : ""}` : "";
      const more = [typeof f.redTeamFindings === "number" && `red team: ${count(f.redTeamFindings, "finding", "findings")}${typeof f.redTeamOpen === "number" ? ` (${e(f.redTeamOpen)} open)` : ""}`,
        typeof f.researchFindings === "number" && `research: ${count(f.researchFindings, "finding", "findings")} read`].filter(Boolean).map((x) => `; ${x}`).join("");
      return `Lab, last ${f.hours} h: ${count(f.tested, "fee candidate", "fee candidates")} simulated, ${e(f.rejected)} rejected${best}${more}. Simulated only: the live fee is unchanged`;
    }
    case "online": return "The engine is live and runs on its own from here; its contracts were deployed by the team and connected by the Safe's owners";
    case "keys_handed": return ENCLAVE.on ? "The Safe's owners handed the agent role to the enclave's own key (SetAgent); nobody outside the enclave holds it" : "The Safe's owners handed the agent role to the engine's own key (SetAgent)";
    case "first_idea_round": return "The first idea landed in the idea market";
    case "first_burn": return "The first buyback: fee ETH bought DNA and all of it was burned";
    case "contracts_connected": return "The Safe's owners connected the registry and the vaults to the hook and queued the first fee plates";
    case "fees_distributed": case "burn_summary": case "liquidity_added": case "progress_day": return `Last ${f.hours} h: ${progressParts(f).join("; ")}`;
    // the Genome Vaults (src/vaults.ts): the event's numbers, the live count as read when it was resolved
    case "vault_minted": return `Genome Vault minted: slot ${f.slot}${f.maxLive !== undefined ? ` of ${f.maxLive}` : ""}${f.lockedDna !== undefined ? `, ${e(f.lockedDna)} DNA locked in it` : ""}${f.live !== undefined ? `; ${count(f.live, "vault", "vaults")} live` : ""}`;
    case "vault_funded": return Number(f.vaults) > 0
      ? `Genome Vaults funded: ${e(f.ethTotal)} ETH from the treasury, ${e(f.perVaultEth)} ETH to each of ${count(f.vaults, "eligible vault", "eligible vaults")}, any remainder from earlier funds included`
      : `Genome Vaults funded: ${e(f.ethTotal)} ETH from the treasury; no vault was eligible yet, so it carries to the next fund`;
    case "vault_burned": {
      // "is theirs": a receiver that refuses ETH is credited for a withdraw instead (Owed)
      const got = [f.lockedDna !== undefined && `its owner got the ${e(f.lockedDna)} DNA back`, Number(f.ethReturned) > 0 && `the ${e(f.ethReturned)} ETH it had not collected is its owner's`].filter(Boolean).join("; ");
      return `Genome Vault burned${f.slot !== undefined ? `: slot ${f.slot} is free again` : ""}${got ? `; ${got}` : ""}${f.live !== undefined ? `; ${count(f.live, "vault", "vaults")} live` : ""}`;
    }
    case "milestone": return f.metric === "jackpot_pot"
      ? `Milestone: the jackpot pot passed ${e(f.threshold)} ETH (now ${e(f.value)} ETH)`
      : `Milestone: ${e(f.threshold)} DNA burned in total (now ${e(f.value)})`;
    default: return String(f.event);
  }
}

/** The site's record for an event: once per key (a replayed range or a retried send never doubles it). */
export async function announce(key: string, facts: Record<string, unknown>, o: { raw?: Record<string, unknown>; tx?: string | null; proof?: string | null } = {}) {
  const [done] = await sql`select 1 from log where kind = 'announce' and ref = ${key}`;
  if (done) return false;
  const type = String(facts.event);
  if (type === "seq_nothing_today") return false; // never an empty day about ourselves (src/upgrades.ts changelog)
  const { append: _, ...shown } = facts;
  await append("announce", key, { type, title: titleOf(facts, o.raw), facts: shown, tx: o.tx ?? null, proof: o.proof ?? null, priority: PRIORITY[type] ?? 4, at: new Date().toISOString() });
  return true;
}

/** The proof link a fact sheet's appended text carries (jackpot proof page, idea round report), if any. */
export const proofOf = (append: unknown) => (typeof append === "string" ? (append.match(/(?:proof|report) (https?:\/\/\S+)/)?.[1] ?? null) : null);

/** Where the digest points: the full list. */
export const ANNOUNCEMENTS_URL = `${LOG_BASE_URL}/announcements`;
const DAY_MS = 86_400_000;
/** A launch day: a UTC day that intersects the launch window (X.launchWindowMs from `launchAt`, LLM_LAUNCH_AT). Decided
 *  per whole day, so the cap never changes mid-day (a day's count would otherwise sit above a smaller cap, and the
 *  digest lose its slot). */
export const launchDay = (now = Date.now(), launchAt = LLM.launchAt) => {
  if (launchAt === undefined) return false;
  const day = now - (((now % DAY_MS) + DAY_MS) % DAY_MS);
  return day < launchAt + X.launchWindowMs && day + DAY_MS > launchAt;
};
/** The post caps at `now`: the launch window's on a launch day, else the normal ones. */
export const postCaps = (now = Date.now(), launchAt = LLM.launchAt) =>
  launchDay(now, launchAt) ? { daily: X.launchDailyPosts, spacingMs: X.launchSpacingMs } : { daily: X.dailyPosts, spacingMs: X.spacingMs };
/** Posts an event may take today: the cap minus the digest's slot. */
export const eventPosts = (now = Date.now(), launchAt = LLM.launchAt) => Math.max(0, postCaps(now, launchAt).daily - 1);
