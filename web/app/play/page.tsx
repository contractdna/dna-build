import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { LIVE } from "../_data/flags";
import { FEE } from "../_data/launchFee";
import type { PlayLive } from "../_data/live";
import { getPlay, getTreasury } from "../_data/source";
import { Shell, X_URL } from "../_ui/Shell";
import { PoisonNote, WalletBar, WalletProvider } from "../_ui/Wallet";
import { fmtDate, fmtTime, PageHead, Section, short, ui } from "../_ui/ui";
import { Countdown } from "./Countdown";
import { MysteryCheck } from "./MysteryCheck";
import { NewGames } from "./NewGames";
import s from "./play.module.css";
import { DNA, STAKE_VAULT } from "./stake";
import { StakePanel } from "./StakePanel";

export const metadata: Metadata = {
  title: "Play · DNA",
  description: "Hold DNA to enter the holder jackpot, stake to count more, vote on the next mutation and check the weekly mystery.",
};

const STEPS = [
  { n: "01", title: "Hold DNA", text: "Hold 1,000+ DNA. Your tickets follow your average balance over the window, so buying a minute before the draw gets you almost nothing." },
  { n: "02", title: "Stake for more", text: "Stake 10,000+ DNA for 12 hours (×2), 3 days (×2.5) or 7 days (×3). After the term it counts at least ×2 until you withdraw, any time you like. A stake can vote once it's 12 hours old." },
  { n: "03", title: "Your streak grows", text: "×1.25 after 2 days, ×1.5 after 5, ×2 after 10, on top of the term. Never above ×4. Tickets and votes use the same weight." },
];

// the short rules; the rest sits behind "Full rules"
const RULES = [
  ["Winners", "10 different wallets per draw, equal shares. The prize is at least 0.25 ETH and at most 3 ETH. Each draw first pays its Chainlink fee from the pot (up to 0.1364 ETH), so a draw needs at least 0.25 ETH after that fee."],
  ["Who can win", "Anyone averaging 1,000+ DNA over the window. Not the Safe or its signers, the AI's wallets, DNA's contracts or the exchange wallets listed before the window."],
  ["Fair odds", "No wallet holds more than 2% of the tickets (1% once a recent draw had 100+ wallets). Fewer than 50 eligible wallets: no draw, the pot rolls over."],
  ["Draw timing", "Every 12 to 24 hours. The AI sets the timing and posts each window's rules before it opens. A window whose rules were not posted before it opened is not drawn; its pot carries over."],
  ["Payout", "Sent to each winner automatically. A wallet that can't receive ETH has 7 days to claim."],
  ["Proof", "Every draw gets a page you can check in your browser."],
  ["Who can play", "18+ only. Check that it's legal where you live."],
];
const FULL_RULES = [
  ["The list", "After each window the AI builds the ticket list from every DNA transfer and posts its fingerprint on-chain. The Safe has 1 hour to veto it while an independent watchdog rebuilds it. Then anyone can start the draw."],
  ["Randomness", "One Chainlink VRF word, delivered after the list is fixed, picks all 10 winning tickets, so nobody can change the list to win."],
  ["Paid from", `The games pot gets a share of DNA's fee: 70% jackpot, 30% idea rewards. That share is 0% today; games share turns on later. Programmable's ${FEE.platform} pays nothing here. If the games share is ever rolled back, the games stop and nothing else does.`],
  ["Prize cap", "The pot holds up to 15 ETH. Anything above goes to buyback and burn."],
  ["Gas", "Draws wait while gas would cost more than 20% of the prize."],
  ["Short list", "Fewer than 10 wallets in the list: the unfilled shares stay in the pot."],
  ["Unclaimed", "An unclaimed share goes back to the pot after 7 days."],
];

const when = (iso: string) => `${fmtDate(iso)}, ${fmtTime(iso)}`;
// no game state: mock mode (before launch), or LIVE while the indexer has not read the game contracts
const PRE = { at: null, pre: true, status: LIVE ? "No data" : "Opens at launch" } as const;
const UNREAD = <>The contract runs on its own; this page can&apos;t read its state right now. Check back in a minute.</>;

/** One game as a player sees it: where it stands, how long until the next step, and what to do now. */
type Game = {
  title: string; c: string; how: string;
  states: string[]; at: number | null;  // the current state's index (null: none current)
  pre?: boolean;                        // no game state to show (see PRE)
  status: string;                       // the chip
  fact?: { value: string; label: string };
  timer?: { label: string; to: string };
  move: React.ReactNode;                // what to do next
  extra?: React.ReactNode;
};

function jackpot(p?: PlayLive, gamesBps = 0): Game {
  const base = { title: "Holder jackpot", c: "var(--amber)", states: ["Window open", "Ticket list", "Drawing", "Paying out"],
    how: "Hold at least 1,000 DNA on average through a draw window and you're in. Staking counts ×2 to ×4. Each draw picks 10 wallets with Chainlink randomness and splits the prize equally, up to 3 ETH, sent straight to them." };
  if (!p) return { ...base, ...PRE, move: LIVE ? UNREAD : <>Nothing to do yet. At launch: hold at least 1,000 DNA through a draw window and you are in.</> };
  const j = p.jackpot, at = ["window open", "list posted", "drawing", "settling"].indexOf(j.stage);
  const open = j.stage === "window open", skipped = open && !j.drawn; // this window is never drawn (engine paramsOf)
  // GamePot.requestDraw: a draw waits (the pot accrues) until the pot covers 0.25 ETH after the VRF top-up
  const low = j.prizeEth === null
    ? <> The pot is under {j.gateEth} ETH: a draw needs at least 0.25 ETH after the Chainlink fee, so draws wait until it fills from the games share of fees{gamesBps === 0 ? <>, which is 0% for now and turns on later</> : null}.</>
    : null;
  return {
    ...base, at, status: base.states[at],
    fact: { value: `${j.potEth} ETH`, label: `in the pot · ${j.prizeEth === null ? `a draw needs ${j.gateEth} ETH` : `prize about ${j.prizeEth} ETH`} · window ${j.window}` },
    timer: !open ? undefined
      : skipped ? (j.next.drawn ? { label: `Window ${j.next.window} closes in`, to: j.next.endsAt } : undefined)
      : j.windowEndsAt ? { label: "Window closes in", to: j.windowEndsAt } : undefined,
    move: [
      skipped
        ? <>This window isn&apos;t drawn (its rules were not posted before it opened). Its pot carries over.{" "}
          {j.next.drawn
            ? <>The {j.lastWin ? "next" : "first"} draw is after the next window closes at {when(j.next.endsAt)}. Hold at least 1,000 DNA on average through that window to be in it.</>
            : <>It goes to the next window whose rules are posted before it opens.</>}{low}</>
        : <>Hold at least 1,000 DNA on average until the window closes. Staked DNA counts double or more.{low}</>,
      <>The list is posted and fixed. The draw can start once the 1-hour veto has passed.</>,
      <>Chainlink is picking the winning tickets. Nobody can change the list now.</>,
      <>The 10 winners are known; their shares are on their way to their wallets.</>,
    ][at],
  };
}

function vote(p?: PlayLive): Game {
  const base = { title: "Mutation vote", c: "var(--violet)", states: ["Ballot posted", "Voting", "Result"],
    how: "Every two days the AI puts three fee mutations on a ballot. Stakers vote for 24 hours and the winner is tested next. Until 1% of DNA is staked, the AI picks and says so." };
  if (!p) return { ...base, ...PRE, move: LIVE ? UNREAD : <>Nothing to do yet. Votes open once 1% of all DNA is staked; until then the AI picks, and says so.</> };
  if (!p.locked.votesOpen) {
    return { ...base, at: null, status: "AI picks for now", fact: { value: `${p.locked.stakedPct}%`, label: "of DNA staked · votes open at 1%" },
      move: <>Stake DNA to open the vote: at 1% staked, the next ballot is yours.</> };
  }
  const b = p.ballot;
  if (!b) return { ...base, at: null, status: "No ballot yet", move: <>The next ballot is announced in the <Link className={ui.link} href="/announcements">news</Link> the moment it is posted.</> };
  const at = b.status === "veto window" ? 0 : b.status === "voting" ? 1 : 2;
  return {
    ...base, at, status: b.status === "veto window" ? "Ballot posted" : b.status === "voting" ? "Voting" : b.status,
    timer: at === 0 ? { label: "Voting opens in", to: b.start } : at === 1 ? { label: "Voting closes in", to: b.end } : undefined,
    move: at === 0 ? <>Stake now so your position is 12 hours old when voting opens.</>
      : at === 1 ? <>Vote with your staked DNA before it closes. You can change your vote until then.</>
      : <>{b.result ?? "Counting is done."}</>,
    extra: <ol className={s.options}>{b.options.map((o) => <li key={o.name}><span>{o.name}</span><span className={ui.dim}>{o.weight} vote weight</span></li>)}</ol>,
  };
}

function mystery(p?: PlayLive): Game {
  const base = { title: "Mystery mutation", c: "var(--lilac)", states: ["Sealed", "Revealing", "Testing"],
    how: "Once a week the AI seals a hidden fee mutation on-chain. It opens about two days later and nobody can swap it in between. When it opens, your browser checks it matches the seal." };
  if (!p) return { ...base, ...PRE, move: LIVE ? UNREAD : <>Nothing to do yet. The first one is sealed after launch.</> };
  const m = p.mystery;
  if (!m) return { ...base, at: null, status: "None sealed", move: <>The next seal is announced in the <Link className={ui.link} href="/announcements">news</Link>.</> };
  const open = Date.now() >= Date.parse(m.revealAt);
  // rejected, broken or cancelled: no stage is current, the chip says why
  const at = m.status === "sealed" ? (open ? 1 : 0) : m.status === "revealed" ? 1 : m.status === "queued for testing" ? 2 : null;
  const revealEnd = new Date(Date.parse(m.revealAt) + 86_400_000).toISOString();
  return {
    ...base, at, status: m.status === "sealed" ? (open ? "Revealing" : "Sealed") : m.status,
    timer: m.status === "sealed" ? (open ? { label: "Reveal window closes in", to: revealEnd } : { label: "Opens in", to: m.revealAt }) : undefined,
    move: m.status === "sealed" ? (open ? <>Anyone with the secret can reveal it now; the AI does it first.</> : <>Nothing to do but wait. Keep the seal below: you can check it when it opens.</>)
      : m.salt && m.payload ? <>Check the seal in your browser: it must match what was sealed {fmtDate(m.revealAt)}.</> : <>{m.status}.</>,
    extra: <>
      <p className={s.mono}>sealed {m.commitment}</p>
      {m.salt && m.payload && <MysteryCheck commitment={m.commitment} salt={m.salt} payload={m.payload} />}
    </>,
  };
}

function Panel({ g }: { g: Game }) {
  return (
    <article className={s.game} style={{ "--c": g.c } as React.CSSProperties} data-pre={g.pre || undefined}>
      <header className={s.gameHead}>
        <h3 className={ui.cardTitle}>{g.title}</h3>
        <span className={s.state}>{g.status}</span>
      </header>
      <ol className={s.track} aria-label={`${g.title}: stages`}>
        {g.states.map((x, i) => {
          const done = g.at !== null && i < g.at;
          return <li key={x} aria-current={i === g.at ? "step" : undefined} data-done={done || undefined}>{x}{done && <span className="sr-only"> (done)</span>}</li>;
        })}
      </ol>
      {(g.fact || g.timer) && (
        <div className={s.readout}>
          {g.fact && <p className={s.fact}>{g.fact.value} <span>{g.fact.label}</span></p>}
          {g.timer && <p className={s.timer}><Countdown to={g.timer.to} className={s.clock} /> <span>{g.timer.label.toLowerCase()}</span></p>}
        </div>
      )}
      {g.extra}
      <p className={s.move}><span className={s.moveLabel}>Your move</span>{g.move}</p>
      <p className={s.how}>{g.how}</p>
    </article>
  );
}

export default async function PlayPage() {
  const [live, { split }] = await Promise.all([getPlay(), getTreasury()]);
  const games = [jackpot(live, split.find((x) => x.dest === "games")?.bps ?? 0), vote(live), mystery(live)];
  const last = live?.jackpot.lastWin; // the latest draw's winners (up to 10)
  const winners = last ? last.winners : [];
  // the first draw: after the open window if it is drawn, else after the next one if that one is
  const j = live?.jackpot, first = j?.stage !== "window open" ? null
    : j.drawn ? `window ${j.window} closes` : j.next.drawn ? `window ${j.next.window} closes (${when(j.next.endsAt)})` : null;
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead
          hero="play"
          back={null}
          sample={false}
          title="Play"
          lede="Hold DNA to play. Stake it to count more. The games run on contracts nobody can change, us included."
          aside={live
            ? <span className={ui.status}>Live: read from the game contracts · {live.locked.dna} DNA staked in {live.locked.positions} positions</span>
            : LIVE ? <span className={ui.status}>The game contracts are running; their state can&apos;t be read right now.</span>
              : <span className={ui.status}><span className={ui.demo}>[Pre-launch]</span> The games open at launch. Nothing below is live yet.</span>}
        />

        <Section title="The games" note={live ? "live from the game contracts" : LIVE ? "how each game runs" : "how each game will run, and your first move"}>
          <div className={s.games}>{games.map((g) => <Panel key={g.title} g={g} />)}</div>
        </Section>

        <Section title="Jackpot winners" note={<Link className={ui.link} href="/announcements">Every draw in the news →</Link>}>
          {winners.length === 0 ? (
            <p className={s.none}>
              {LIVE ? `No draws yet. The first one comes after ${first ?? "the first window with posted rules closes"} and its list survives the 1-hour veto.` : "No draws yet: the first window opens at launch."}{" "}
              <a className={ui.link} href={X_URL} target="_blank" rel="noopener noreferrer">Follow on X</a> to hear the first one.
            </p>
          ) : (
            <ol className={s.winners}>
              {winners.slice(0, 10).map((w) => (
                <li key={w.rank}>
                  <Link href={`/play/draw/${last!.window}`}>
                    <span className={s.wPrize}>{last!.shareEth} ETH</span>
                    <span className={s.wWho}>{short(w.account)}</span>
                    <span className={ui.dim}>window {last!.window} · {when(last!.at)}{w.pushed ? "" : " · claim pending"}</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section title="How to join">
          <ol className={s.steps}>
            {STEPS.map((x) => (
              <li key={x.n}><span className={s.n}>{x.n}</span><h3 className={ui.cardTitle}>{x.title}</h3><p className={ui.prose}>{x.text}</p></li>
            ))}
          </ol>
        </Section>

        {/* one wallet for the stake panel and the Sequencer's games below it */}
        <WalletProvider>
          <div id="stake">
            <Section title="Stake" note={LIVE ? <a className={ui.link} href={`https://etherscan.io/address/${STAKE_VAULT}`} target="_blank" rel="noopener noreferrer">ConvictionVault on Etherscan</a> : "pre-launch"}>
              <WalletBar token={DNA} />
              <StakePanel />
              <p className={`${ui.prose} ${ui.muted}`}>
                Staked DNA stays in the ConvictionVault contract until you withdraw it. It raises your jackpot tickets and your vote weight; it pays nothing by itself.
                Every button here sends a transaction with no ETH, to the vault or the exact DNA approval a stake needs. No signature, and never an approval beyond the amount you stake.
              </p>
              <PoisonNote />
            </Section>
          </div>
          <Suspense fallback={null}><NewGames /></Suspense>
        </WalletProvider>

        <Section title="The rules" note={<Link className={ui.link} href="/constitution">Hard limits →</Link>}>
          <dl className={s.rules}>
            {RULES.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
          <details className={ui.more}>
            <summary>Full rules</summary>
            <dl className={s.rules}>
              {FULL_RULES.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
          </details>
          <p className={`${ui.prose} ${ui.muted}`}>Every draw, reward and vote result lands on <Link className={ui.link} href="/announcements">News</Link>. How X ideas get in: <Link className={ui.link} href="/rules">rules for ideas</Link>.</p>
        </Section>
      </div>
    </Shell>
  );
}
