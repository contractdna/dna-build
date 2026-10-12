// Event posts on X, written by code from the fact sheet (src/voice.ts factSheet): no model, no persona voice. One fixed
// template per kind says what happened and its numbers, in sentence case, with no closing line; code appends the tx
// (or record) link after it as before. ETH to 3 significant digits, DNA whole with thousands separators; every number is
// the fact sheet's own. The writer keeps what is not an event: replies, the nightly reflection, a take on crypto Twitter.
// Each template has shorter variants (free text, a title or a reason, dropped first): the first that fits the room left by
// the appended link and passes the post filters goes out; none does, or no template: nothing goes out (never the model).
import { ENCLAVE } from "./enclave.ts";
import { allyIssues, claimFacts, claimIssues, postFilter, weightedLength } from "./voice.ts";

/** Events the writer still words (not events: a take, the nightly reflection). Replies never come here. */
export const MODEL_POSTS = new Set(["ct", "reflection"]);

type F = Record<string, unknown>;
const num = (v: unknown, o: Intl.NumberFormatOptions) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US", o) : "?");
/** ETH to 3 significant digits (0.1964 → "0.196", 1234.5 → "1,230"). */
export const eth = (v: unknown) => num(v, { maximumSignificantDigits: 3 });
/** DNA whole, with thousands separators (486886.7 → "486,886"). */
export const dna = (v: unknown) => num(typeof v === "number" ? Math.floor(v) : v, { maximumFractionDigits: 0 });
/** Counts, hours, percents: as the fact holds them, with separators. */
const n = (v: unknown) => num(v, { maximumFractionDigits: 4 });
const count = (v: unknown, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** A model- or person-written line, at most `max` characters (cut at a word), without its own end punctuation. */
const clip = (v: unknown, max = 80) => {
  const t = str(v)?.replace(/[.;:,!?]+$/, "");
  if (!t) return undefined;
  return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, "").replace(/[\s.;:,]+$/, "")}...`;
};
const quoted = (v: unknown, max = 80) => { const t = clip(v, max); return t ? `"${t}"` : undefined; };
type Fee = { basePct?: number; multiplier?: number; capPct?: number };
/** A fee vector: base and cap in %, the multiplier as a plain factor (said after the word, never with an x). */
const feeText = (fee: unknown) => {
  const f = (fee ?? {}) as Fee;
  return [typeof f.basePct === "number" && `base ${n(f.basePct)}%`, typeof f.multiplier === "number" && `multiplier ${n(f.multiplier)}`, typeof f.capPct === "number" && `cap ${n(f.capPct)}%`].filter(Boolean).join(", ");
};
const splitText = (s: unknown) => {
  const x = s as Record<string, number> | undefined;
  return x ? `buyback ${n(x.buybackPct)}%, liquidity ${n(x.liquidityPct)}%, treasury ${n(x.treasuryPct)}%, games ${n(x.gamesPct)}%` : "";
};
const clock = (t: unknown) => {
  const c = t as { utcHour?: number; utcMinute?: number } | undefined;
  return typeof c?.utcHour === "number" && typeof c.utcMinute === "number" ? `${String(c.utcHour).padStart(2, "0")}:${String(c.utcMinute).padStart(2, "0")} UTC` : undefined;
};
const isoMinute = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? `${v.slice(0, 10)} ${v.slice(11, 16)} UTC` : undefined);
/** The live fee: above the 5% cap it is the launch tax of the pool's first blocks, never a bare trading fee. */
const liveFeeText = (fee: unknown) => {
  const f = (fee ?? {}) as Fee;
  if (typeof f.basePct !== "number") return undefined;
  return f.basePct > 5 ? `Live fee ${n(f.basePct)}%: the launch tax of the pool's first blocks, all of it to buyback and burn.` : `Live fee: ${feeText(f)}.`;
};

type Part = string | false | undefined | null;
/** The sentences in order, then the same with each `drop` part left out in turn (longest first). */
const variants = (parts: Part[], drop: Part[] = []): string[] => {
  let keep = parts.filter((p): p is string => !!p);
  const out = [keep.join(" ")];
  for (const d of drop) if (d && keep.includes(d)) { keep = keep.filter((p) => p !== d); out.push(keep.join(" ")); }
  return out;
};

/** The template's text for a post's fact sheet, longest variant first; null: not a code-written kind. */
export function eventVariants(f: F): string[] | null {
  const title = quoted(f.title);
  switch (f.event) {
    // chain progress (src/status.ts progressFacts): one window's fee distributions, buybacks and liquidity adds
    case "fees_distributed": return [`Fees distributed (last ${n(f.hours)} h${Number(f.distributions) > 1 ? `, ${count(f.distributions, "distribution")}` : ""}): ${eth(f.totalEth)} ETH total. ${eth(f.buybackEth)} ETH to buyback, ${eth(f.liquidityEth)} ETH to liquidity, ${eth(f.treasuryEth)} ETH to treasury, ${eth(f.gamesEth)} ETH to games.`];
    case "burn_summary": return [Number(f.buybacks) > 1
      ? `Buyback and burn (last ${n(f.hours)} h, ${count(f.buybacks, "buyback")}): ${eth(f.spentEth)} ETH bought ${dna(f.burnedDna)} DNA, and all of it was burned.`
      : `Buyback and burn: ${eth(f.spentEth)} ETH bought ${dna(f.burnedDna)} DNA, and it was burned.`];
    // contracts/src/LiquidityVault.sol: ETH-only liquidity in the pool, no withdraw, decrease or collect path
    case "liquidity_added": return [`Liquidity added${Number(f.adds) > 1 ? ` (last ${n(f.hours)} h, ${count(f.adds, "add")})` : ""}: ${eth(f.ethAdded)} ETH went into the pool as permanent liquidity. It can never be withdrawn.`];
    case "progress_day": {
      const fees = f.distributions !== undefined && `Fees distributed: ${eth(f.totalEth)} ETH total. ${eth(f.buybackEth)} ETH to buyback, ${eth(f.liquidityEth)} ETH to liquidity, ${eth(f.treasuryEth)} ETH to treasury, ${eth(f.gamesEth)} ETH to games.`;
      const feesShort = f.distributions !== undefined && `Fees distributed: ${eth(f.totalEth)} ETH total.`;
      const burn = f.buybacks !== undefined && `Buyback and burn: ${eth(f.spentEth)} ETH bought ${dna(f.burnedDna)} DNA, all of it burned.`;
      const liq = f.adds !== undefined && `Liquidity added: ${eth(f.ethAdded)} ETH as permanent liquidity.`;
      const head = `Last ${n(f.hours)} h on-chain.`;
      return [...variants([head, fees, burn, liq]), ...variants([head, feesShort, burn, liq])];
    }
    // the twice-daily status (src/status.ts statusFacts): figures only
    case "status": {
      const s = (f.sequencer ?? {}) as { stage?: string; round?: number; title?: string };
      const t = f.testing as { stage?: string; plate?: string } | undefined;
      const head = `Status, last ${n(f.hours)} h: ${count(f.swaps, "swap")}, ${eth(f.volumeEth)} ETH volume, ${eth(f.feesEth)} ETH in fees, ${dna(f.burnedDna)} DNA burned.`;
      const tax = typeof f.launchTaxSwaps === "number" && `${count(f.launchTaxSwaps, "swap")} paid the launch tax (${eth(f.launchTaxVolumeEth)} ETH volume): ${eth(f.launchTaxEth)} ETH to buyback and burn.`;
      const pots = typeof f.buybackPotEth === "number" && `Buyback pot ${eth(f.buybackPotEth)} ETH${typeof f.jackpotPotEth === "number" ? `, jackpot pot ${eth(f.jackpotPotEth)} ETH` : ""}.`;
      const games = typeof f.gamesLive === "number" && `${count(f.gamesLive, "game")} live.`;
      const fee = liveFeeText(f.liveFee);
      const test = t?.stage && `Testing: a ${t.stage} test${t.plate ? ` on plate ${t.plate}` : ""}.`;
      const busy = s.stage === "building" || s.stage === "shipping";
      const seqTitled = busy && `The sequencer is ${s.stage}${quoted(s.title, 60) ? ` ${quoted(s.title, 60)}` : ""}${s.round ? ` (round ${n(s.round)})` : ""}.`;
      const seq = busy ? `The sequencer is ${s.stage}${s.round ? ` (round ${n(s.round)})` : ""}.` : s.stage === "idle" ? "The sequencer is idle." : undefined;
      return [...variants([head, tax, pots, games, fee, test, seqTitled]), ...variants([head, tax, pots, games, fee, test, seq], [seq, test, games, pots, fee])];
    }
    case "recap": {
      const c = (v: unknown, one: string, many: string) => (typeof v === "number" ? count(v, one, many) : undefined);
      const more = (v: unknown, one: string, many: string) => (Number(v) > 0 ? c(v, one, many) : undefined);
      const built = [c(f.gamesShipped, "game shipped", "games shipped"), c(f.siteChanges, "site change", "site changes"), more(f.modulesProposed, "module proposed to the Safe", "modules proposed to the Safe"),
        more(f.modulesApproved, "module approved", "modules approved"), more(f.handedOver, "engine change handed over", "engine changes handed over"), c(f.buildsKilled, "build dropped", "builds dropped"), c(f.gamesRetired, "game retired", "games retired")].filter(Boolean).join(", ");
      const head = `Week in review (last ${n(f.days)} days): ${built}.`;
      const exp = `Experiments: ${n(f.experimentsKept)} kept, ${n(f.experimentsKilled)} killed.`;
      const now = `Now ${count(f.gamesLive, "game")} live.`;
      const shipped = (Array.isArray(f.shipped) ? f.shipped : []).map((x) => quoted(x, 40)).filter(Boolean);
      const ship = shipped.length > 0 && `Shipped: ${shipped.join(", ")}.`;
      const fee = liveFeeText(f.liveFee);
      return variants([head, ship, exp, now, fee], [ship, fee]);
    }
    case "milestone": return [f.label === "the jackpot pot in ETH"
      ? `Milestone: the jackpot pot passed ${eth(f.mark)} ETH (now ${eth(f.value)} ETH).`
      : `Milestone: ${dna(f.mark)} DNA burned in total (now ${dna(f.value)} DNA).`];
    case "digest": {
      const exp = (Number(f.survived) > 0 || Number(f.extinct) > 0) && `Experiments closed: ${n(f.survived)} kept, ${n(f.extinct)} killed.`;
      const jackpot = Number(f.winners) > 0 && `Jackpot: ${count(f.winners, "winner")}, ${eth(f.ethPaid)} ETH paid.`;
      const burned = Number(f.dnaBurned) > 0 && `${dna(f.dnaBurned)} DNA burned.`;
      const kinds = ([["money", "money"], ["games", "games"], ["experiments", "experiments"], ["other", "other"]] as const).filter(([k]) => Number(f[k]) > 0).map(([k, w]) => `${n(f[k])} ${w}`).join(", ");
      const rest = Number(f.total) > 0 && `${count(f.total, "more update")} did not fit in today's posts${kinds ? ` (${kinds})` : ""}. All of them are on the site.`;
      const restShort = Number(f.total) > 0 && `${count(f.total, "more update")} did not fit in today's posts. All of them are on the site.`;
      return [...variants(["Daily digest.", exp, jackpot, burned, rest]), ...variants(["Daily digest.", exp, jackpot, burned, restShort])];
    }
    // the game layer (src/games.ts gameFacts); code appends the proof or list link before the tx
    case "jackpot_params": return [`Jackpot window ${n(f.window)} rules: cap ${n(f.capPct)}% per wallet, minimum average balance ${dna(f.minBalance)} DNA, ${count(f.exchangesExcluded, "exchange wallet")} excluded.${isoMinute(f.startsAt) ? ` It starts ${isoMinute(f.startsAt)}.` : ""}`];
    case "jackpot_list": return [`Jackpot window ${n(f.window)} list: ${count(f.holders, "holder")}, ${count(f.totalTickets, "ticket")} (cap ${n(f.capPct)}% per wallet). The draw opens in ${count(f.vetoHours, "hour")}.`];
    case "jackpot_drawn": return [`Jackpot window ${n(f.window)} drawn: ${count(f.winners, "winner")}, ${eth(f.shareEth)} ETH each (${eth(f.prizeEth)} ETH in all).${Number(f.claimable) > 0 ? ` ${count(f.claimable, "prize")} can be claimed within ${count(f.claimDays, "day")}.` : ""}`];
    case "jackpot_voided": return [`Jackpot window ${n(f.window)}: the draw was not settled in time, so ${eth(f.prizeEth)} ETH went back to the pot.`];
    // GamePot's claim ids cover a draw's share and an idea reward whose push failed; no `kind` yet, so the wording names both
    case "prize_claimed": case "prize_expired": {
      const what = f.kind === "prize" ? `Jackpot prize #${n(f.drawId)}` : f.kind === "reward" ? `Idea reward (claim #${n(f.drawId)})` : `Claim #${n(f.drawId)} (a jackpot share or an idea reward)`;
      return [f.event === "prize_claimed" ? `${what} was claimed: ${eth(f.prizeEth)} ETH.`
        : `${what} was not claimed within ${count(f.claimDays, "day")}: ${eth(f.prizeEth)} ETH went to the jackpot pot.`];
    }
    case "reward_paid": return [f.claimable === true
      ? `Idea reward #${n(f.reward)}: ${eth(f.rewardEth)} ETH. The wallet could not take it, so it can be claimed (claim #${n(f.claim)}) within ${count(f.claimDays, "day")}.`
      : `Idea reward #${n(f.reward)} paid: ${eth(f.rewardEth)} ETH.`];
    case "ballot_opened": {
      const opts = (Array.isArray(f.options) ? f.options : []).map((o) => clip(o, 40)).filter(Boolean);
      const when = `Voting opens in ${count(f.opensInHours, "hour")} and lasts ${count(f.votingHours, "hour")}.`;
      return [`New ballot: ${opts.join(" / ")}. ${when}`, `New ballot. ${when}`];
    }
    case "ballot_result": {
      const tail = `won with ${dna(f.winnerWeight)} of ${dna(f.totalWeight)} vote weight${str(f.outcome) ? `: ${f.outcome}` : ""}.`;
      return [`Ballot #${n(f.ballot)}: ${quoted(f.winner, 60) ?? "the winning option"} ${tail}`, `Ballot #${n(f.ballot)}: the winning option ${tail}`];
    }
    case "mystery_sealed": return [`A mystery mutation was sealed. It opens in ${count(f.revealInDays, "day")}.`];
    case "mystery_revealed": return [feeText(f.fee) ? `A mystery mutation was revealed: ${feeText(f.fee)}.` : "A mystery mutation was revealed."];
    case "mystery_result": return str(f.outcome) ? [`Mystery #${n(f.mystery)}: ${f.outcome}${str(f.reason) ? ` (${f.reason})` : ""}.`] : [];
    case "idea_round": return [f.refunded === true
      ? `Idea round ${n(f.round)} closed: no idea accepted, every stake refunded.`
      : `Idea round ${n(f.round)} closed: ${n(f.accepted)} of ${count(f.ideas, "idea")} accepted. Stakers of accepted ideas get their stake back plus ${n(f.payoutPct)}%.`];
    // fee mechanics (src/x.ts resolve): the engine's own queued ops, tests going live, results, vetoes, rollbacks
    case "queued": {
      const what = `Queued${str(f.plate) ? ` on plate ${f.plate}` : ""}. ${cap(str(f.change) ?? "a registry change")}.${feeText(f.fee) ? ` Fee: ${feeText(f.fee)}.` : ""}`;
      // a test runs (it has hours); anything else (a live settings change, a promotion) takes effect
      const when = clock(f.activatesAt) && `It can ${typeof f.hours === "number" ? "run" : "take effect"} from ${clock(f.activatesAt)} unless the Safe cancels it first.`;
      const hours = typeof f.hours === "number" && `A test runs at least ${count(f.hours, "hour")}.`;
      const pays = str(f.pays) && `Who pays: ${f.pays}.`;
      return variants([what, when, hours, pays], [pays, hours]);
    }
    case "test_live": {
      const what = `Test live${str(f.plate) ? ` on plate ${f.plate}` : ""}. ${cap(str(f.change) ?? "a fee test")}.${feeText(f.fee) ? ` Fee: ${feeText(f.fee)}.` : ""}`;
      // a canary's auto-rollback (src/voice.ts factSheet sets `rollback` for it only; a shadow test charges nothing)
      const hours = typeof f.hours === "number" && `It runs at least ${count(f.hours, "hour")}${str(f.rollback) ? `, with ${f.rollback}` : ""}.`;
      const pays = str(f.pays) && `Who pays: ${f.pays}.`;
      return variants([what, hours, pays], [pays, hours]);
    }
    case "outcome": {
      const kept = f.outcome === "kept (promoted)";
      const why = str(f.reason) && f.reason !== f.outcome && !(kept && f.reason === "promoted to the live fee") ? ` (${f.reason})` : "";
      const what = `Experiment${str(f.plate) ? ` on plate ${f.plate}` : ""}: ${kept ? "kept, and promoted to the live fee" : f.outcome}${why}.`;
      const fee = feeText(f.fee) && `Fee tested: ${feeText(f.fee)}${typeof f.samples === "number" ? `, over ${count(f.samples, "swap")}` : ""}.`;
      const source = str(f.source) && `Source: ${f.source}.`;
      return variants([what, fee, source], [source, fee]);
    }
    case "cancelled": return [`Vetoed: the Safe's owners cancelled a queued change${str(f.plate) ? ` on plate ${f.plate}` : ""}${str(f.change) ? ` (${f.change})` : ""}. Nothing changed.`];
    case "rolled_back": return [`Rolled back: the ${f.route === "split" ? "split" : "fee"} module. ${cap(str(f.pays) ?? "")}${str(f.pays) ? "." : ""}`.trim()];
    case "module_approved": return [`The Safe approved new ${f.kind === "split" ? "split" : "fee"} module code. It can now be registered and tested; the current fee stays as it is.`];
    // the engine's own code and the rules it runs under (src/upgrades.ts); with no notes the post is upgrades' fixedLine
    case "update_queued": case "update_allowed": case "update_running": case "update_cancelled": {
      const notes = (Array.isArray(f.notes) ? f.notes : []).map((x) => clip(x)).filter((x): x is string => !!x);
      const when = clock(f.activatesAt) ? `It can land from ${clock(f.activatesAt)} unless the Safe cancels it first.` : "Its public hour is over; it lands once someone executes it.";
      const say = (k: number) => (k ? ` What it changes: ${notes.slice(0, k).join("; ")}.` : "");
      const make = (k: number) => f.event === "update_queued" ? `Engine update queued.${say(k)} ${when}`
        : f.event === "update_allowed" ? `Engine update allowed: the timelock executed it, and the engine switches to it on its next restart.${say(k)}`
        : f.event === "update_running" ? `Engine update is in: the engine now runs the new version.${say(k)}`
        : "The Safe cancelled the queued engine update. Nothing changed.";
      return notes.map((_, i) => make(notes.length - i)).concat(make(0));
    }
    case "change_queued": case "change_cancelled": case "change_done": {
      const nums = [typeof f.level === "number" && `level ${n(f.level)}`, typeof f.hours === "number" && `every ${count(f.hours, "hour")}`, feeText(f.fee), splitText(f.split)].filter(Boolean).join("; ");
      const what = `${str(f.change) ?? "a registry change"}${nums ? ` (${nums})` : ""}`;
      if (f.event === "change_cancelled") return [`The Safe cancelled ${what}. Nothing changed.`];
      if (f.event === "change_done") return [`In effect: ${what}.`];
      const when = clock(f.activatesAt) ? `It can take effect from ${clock(f.activatesAt)} unless the Safe cancels it first.` : "Its public hour is over; it takes effect once executed.";
      return [`${f.who === "me" ? "The engine queued" : "The Safe queued"} ${what}. ${when}`];
    }
    case "day_changes": {
      // the first lines that fit, each cut at 120 (a line's figures are never cut short to fit more lines)
      const lines = (Array.isArray(f.changes) ? f.changes : []).map((x) => clip(x, 120)).filter((x): x is string => !!x).map(cap);
      // `date`: the UTC day the changelog covers (src/upgrades.ts changelog; a row queued before it was carried: yesterday)
      const day = typeof f.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? `on ${f.date} (UTC)` : "yesterday (UTC)";
      return [...lines.map((_, i) => `What changed ${day}: ${lines.slice(0, lines.length - i).join("; ")}.${i ? " The rest is on the site." : ""}`), `What changed ${day} is on the site.`];
    }
    // the sequencer (src/announce.ts SeqFacts) and live idea mode
    case "seq_online": return ["The sequencer is switched on. It builds up to 3 ideas at once, and a game ships only after every check and a public hour."];
    case "seq_started": {
      const why = clip(f.why, 120);
      return [title && why && `The sequencer started building ${title}. Why this one: ${why}.`, title && `The sequencer started building ${title}.`, "The sequencer started a new build."].filter((x): x is string => !!x);
    }
    case "seq_pr": {
      const failed = typeof f.checksFailed === "number" && f.checksFailed > 0 ? ` ${count(f.checksFailed, "check")} failed.` : "";
      return [`${title ? `Build ${title}` : "A build"}, round ${n(f.round)}: the pull request is up and goes through the checks and the brain's review.${failed}`];
    }
    case "seq_verdict": {
      const why = clip(f.why, 120);
      const t = title ?? "the build";
      const make = (w?: string) => f.verdict === "ship" ? `The brain approved ${t}. It ships after a public hour unless the Safe vetoes it.`
        : f.verdict === "rework" ? `The brain sent ${t} back for another round${w ? `: ${w}` : ""}.` : `The brain dropped ${t}${w ? `: ${w}` : ""}. Nothing shipped.`;
      return [make(why), make()];
    }
    case "seq_declined": { const why = clip(f.why, 120); return [why && `The sequencer will not build ${title ?? "an accepted idea"}: ${why}.`, `The sequencer will not build ${title ?? "an accepted idea"}.`].filter((x): x is string => !!x); }
    case "idea_judged": {
      const why = clip(f.why, 120);
      const what = f.verdict === "queued" ? (str(f.instead) ? `An idea can't be built as written. Its closest buildable version${title ? `, ${title},` : ""} is queued for the sequencer, credited to its author.` : `Idea ${title ?? "from the site"} was accepted and is queued for the sequencer.`)
        : `Idea ${title ?? "from the site"} was not taken.`;
      return variants([what, why && `Why: ${why}.`], [why && `Why: ${why}.`]);
    }
    case "seq_killed": return [`The sequencer tried ${title ?? "a build"} for ${count(f.rounds, "round")}. It did not make the bar, and nothing shipped.`];
    case "seq_shipped": return [`New game: ${title ?? "a new game"} is live.${typeof f.fundEth === "number" ? ` Its first ${eth(f.fundEth)} ETH of funding waits a public hour.` : " It is waiting for funding."}`];
    case "game_retired": {
      const back = typeof f.returnedEth === "number" ? ` ${eth(f.returnedEth)} ETH went back to the treasury (the Safe).` : "";
      const t = title ?? "a game";
      // the idle rule (src/sequencer.ts retireDue): live idleHours or more, nobody played in the last idleHours; `days`: its age
      const idle = typeof f.idleHours === "number" ? `had no players in its last ${count(f.idleHours, "hour")}` : "had no recent players";
      return [f.rule === "evict" ? `Game retired: ${t} made room for a new game, as it had the fewest players of the live games.${back} Anything won stays claimable.`
        : `Game retired: ${t} ${idle}, after ${count(f.days, "day")} live.${back} Anything won stays claimable.`];
    }
    case "seq_released": return [f.target === "module"
      ? `A fee or split module from the sequencer waits for the Safe${title ? `: ${title}` : ""}. Nothing changes until the Safe approves its code.`
      : `A site change from the sequencer is live${title ? `: ${title}` : ""}.`];
    case "seq_handoff": return [`An engine change from the sequencer waits for an owner's review${title ? `: ${title}` : ""}. It runs only after an owner merges it and the code timelock passes.`];
    case "site_changed": {
      const t = clip(f.title, 60), s = clip(f.summary, 160);
      return [t && s && `The website changed: ${t}. ${cap(s)}.`, t && `The website changed: ${t}.`, "The website changed."].filter((x): x is string => !!x);
    }
    // the treasury's DNA (src/status.ts treasuryFacts): a buy on the pool, a transfer or a sale out
    case "treasury_buy": return [`The treasury (the Safe) bought ${dna(f.dnaAmount)} DNA on the pool for ${eth(f.ethSpent)} ETH with its own ETH${typeof f.supplyPct === "number" ? ` (${n(f.supplyPct)}% of supply)` : ""}: the team's own buy, not organic demand.`];
    case "treasury_transfer": {
      const pct = typeof f.supplyPct === "number" ? ` (${n(f.supplyPct)}% of supply)` : "";
      if (typeof f.soldEth === "number") return [`The treasury (the Safe) sold ${dna(f.dnaAmount)} DNA${pct} on the pool for ${eth(f.soldEth)} ETH.`];
      const to = clip(f.label, 40);
      return [`The treasury (the Safe) sent ${dna(f.dnaAmount)} DNA${pct} to ${to ?? "a wallet with no public label"}.`, `The treasury (the Safe) sent ${dna(f.dnaAmount)} DNA${pct} to a wallet.`];
    }
    // launch day and the once-ever firsts (src/status.ts)
    case "online": return ["The engine is live and runs on its own from here. Its contracts were deployed by the team and connected by the Safe's owners."];
    case "contracts_connected": return ["The Safe's owners connected the registry and the vaults to the hook in a single batch and queued the first fee plates."];
    case "keys_handed": return [ENCLAVE.on ? "The Safe's owners handed the agent role to the enclave's own key (SetAgent). Nobody outside the enclave holds it." : "The Safe's owners handed the agent role to the engine's own key (SetAgent)."];
    case "first_idea_round": return ["The first idea landed in the idea market. The round runs, then the brain decides."];
    case "first_burn": return ["The first buyback: fee ETH bought DNA, and all of it was burned."];
    // the lab (src/lab.ts labFacts): simulated only
    case "lab": {
      const b = (f.best ?? {}) as { fee?: Fee; ethUpPct?: number; ethDownPct?: number; swapsUpPct?: number; swapsDownPct?: number; verdict?: string };
      const move = (up?: number, down?: number) => (typeof up === "number" ? `+${n(up)}%` : typeof down === "number" ? `-${n(down)}%` : undefined);
      const moves = [move(b.ethUpPct, b.ethDownPct) && `ETH a day ${move(b.ethUpPct, b.ethDownPct)}`, move(b.swapsUpPct, b.swapsDownPct) && `swaps ${move(b.swapsUpPct, b.swapsDownPct)}`].filter(Boolean).join(", ");
      const head = `Lab, last ${n(f.hours)} h, simulated only: ${count(f.tested, "fee candidate")} tested, ${n(f.rejected)} rejected.`;
      const best = b.fee && `Best in simulation: ${feeText(b.fee)}${moves ? `; ${moves}` : ""}${b.verdict ? ` (${b.verdict})` : ""}.`;
      const red = typeof f.redTeamFindings === "number" && `Red team: ${count(f.redTeamFindings, "finding")}${typeof f.redTeamOpen === "number" ? ` (${n(f.redTeamOpen)} open)` : ""}.`;
      const research = typeof f.researchFindings === "number" && `Research: ${count(f.researchFindings, "finding")} read.`;
      return variants([head, best, red, research, "The fee in effect did not change."], [research, red, best]);
    }
    // the social layer (src/x-social.ts): code appends who gave the idea, or the titles and handles
    case "idea_of_day": return [title && `Idea of the day: ${title}, scored ${n(f.score)} of ${n(f.scoreOf)}.`, `Idea of the day, scored ${n(f.score)} of ${n(f.scoreOf)}.`].filter((x): x is string => !!x);
    case "shoutout": return [`This week's top idea-givers: ${count(f.givers, "person", "people")}, ${count(f.ideas, "idea")} in all.`];
    default: return null;
  }
}

/** Fact sheet fields written by a model or a person (screened by factSheet, never code's own words). A treasury
 *  transfer's `label` has its own variant without it (a milestone's label is code's). */
const FREE_TEXT = ["title", "why", "summary", "notes", "changes", "shipped", "options", "winner", "sequencer"];
/** Every number in a template is the fact sheet's own (formatted here), so the filter's number rule is not asked again. */
const ANY_NUMBER = { has: () => true } as unknown as Set<string>;
/** Why a code-written post can't go out ([] = ok): the post filters minus the number rule (src/voice.ts postFilter; its
 *  number words, banned terms, link, ally, price and claim rules all hold), the claim and ally checks. `room`: what
 *  is left of 280 after code's appended text. */
export const eventIssues = (f: F, text: string, room = 280) =>
  [...postFilter(text, ANY_NUMBER, 280 - room, { claim: claimFacts(f) }), ...claimIssues(f, text), ...allyIssues(f, text)];

/** The code-written post for a fact sheet within `room` weighted chars: the longest variant that fits and passes
 *  eventIssues. null: the writer words it (MODEL_POSTS). `skip`: nothing goes out (no template for this kind, or no
 *  variant fits and passes): an unchecked text is never posted, and an event never falls back to the model. */
export function eventPost(f: F, room = 280): string | { skip: "no template" | "no template variant fits" } | null {
  if (MODEL_POSTS.has(String(f.event))) return null;
  const v = eventVariants(f);
  if (!v) return { skip: "no template" };
  // last: the same template without any model- or person-written text (titles, reasons, notes, labels, options)
  // a clipped line ends in its ellipsis, not "...." (NFKC makes any "…" three dots before a post goes out)
  const all = [...v, ...(eventVariants({ ...f, ...Object.fromEntries(FREE_TEXT.map((k) => [k, undefined])) }) ?? [])].map((t) => t.replace(/\.{4}/g, "..."));
  return all.find((t) => weightedLength(t) <= room && !eventIssues(f, t, room).length) ?? { skip: "no template variant fits" };
}
