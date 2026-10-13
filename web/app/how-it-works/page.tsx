import type { Metadata } from "next";
import Link from "next/link";
import { FEE } from "../_data/launchFee";
import { Shell } from "../_ui/Shell";
import { FeeBreakdown, PageHead, Section, ui } from "../_ui/ui";
import s from "./hiw.module.css";

export const metadata: Metadata = {
  title: "How it works · DNA",
  description: "DNA in plain words: how the AI tests fee changes, how the Sequencer builds new games, the hard limits, where fees go, and how to check it all.",
};

// Every fact here is the /docs dumb-mode chapter it comes from (web/app/docs/content.ts), in longer plain words.
const LOOP = [
  { name: "Propose", time: "any time", c: "var(--teal)", text: "The AI proposes new fee settings and publishes its reasoning." },
  { name: "Public hour", time: "1 hour", c: "var(--amber)", text: "It waits an hour where everyone can see it. The Safe can cancel it." },
  { name: "Shadow test", time: "2 hours", c: "var(--lilac)", text: "It runs next to the live fee on every 10th trade. Its fee is worked out, never charged." },
  { name: "Live test", time: "1 h queue + 4 hours", c: "var(--violet)", text: "Then it charges real trades on 1 in 6 blocks, never more than 1 point from the current fee." },
] as const;

const RULES = [
  { v: FEE.cap, text: `After the launch tax, DNA's fee can never go above ${FEE.cap} (${FEE.capAllIn} with Programmable's ${FEE.platform}).` },
  { v: "1B", text: "DNA, minted once. There is no way to mint more; burns only make it smaller." },
  { v: "1 hour", text: "Every change waits an hour in public. The Safe can cancel it." },
  { v: "Forever", text: "The launch liquidity, two positions owned by 0xdEaD, is locked for good. The liquidity added later can only grow." },
  { v: "90%", text: "Launch tax in the first block, down to 10% by block 8. All of it buys DNA back and burns it." },
  { v: "Nobody", text: "can move your DNA: not the AI, not the team. Removing liquidity can never be blocked." },
];

const SPLIT = [
  { pct: 35, name: "Burn", text: "buys DNA back and burns it", c: "var(--coral)" },
  { pct: 30, name: "Liquidity", text: "deepens the pool, never removed", c: "var(--teal)" },
  { pct: 25, name: "Treasury", text: "ETH to the Safe", c: "var(--amber)" },
  { pct: 10, name: "Games", text: "70% jackpot, 30% idea rewards", c: "var(--violet)" },
];

const GAMES = [
  { name: "Holder jackpot", c: "var(--amber)", href: "/play", go: "Play", facts: ["≥ 1,000 DNA average", "up to 3 ETH a draw", "every 12 to 24 h"],
    text: "Hold DNA and you're in, no sign-up. 10 winners split each draw equally, picked by Chainlink and paid automatically." },
  { name: "Staking", c: "var(--teal)", href: "/play", go: "Play", facts: ["≥ 10,000 DNA", "×2 / ×2.5 / ×3", "up to ×4 with a streak"],
    text: "Stake 10,000+ DNA for 12 hours, 3 days or 7 days to count ×2 to ×3, plus a streak up to ×4. Staking pays nothing out. It makes your DNA count more." },
  { name: "Mutation vote", c: "var(--violet)", href: "/play", go: "Play", facts: ["every 2 days", "3 options", "24 hours to vote"],
    text: "Stakers pick which fee mutation gets tested next. Voting opens once 1% of DNA is staked." },
  { name: "Mystery", c: "var(--lilac)", href: "/play", go: "Play", facts: ["once a week", "opens in about 2 days", "can't be swapped"],
    text: "A fee mutation sealed on-chain before anyone sees it. When it opens, your browser checks it matches." },
  { name: "Ideas", c: "var(--coral)", href: "/proposals", go: "Ideas", facts: ["post on X", "top 16 a round", "stake on ideas"],
    text: "Post an idea on X and tag @contractdna. The best 16 each round go to the idea market, where backers of picked ideas win the stakes of the rest." },
  { name: "Idea rewards", c: "var(--rose)", href: "/docs#rewards", go: "Docs", facts: ["30% of the games pot", "the brain sets each one", "1 public hour first"],
    text: "ETH for the people whose ideas DNA uses. A fee idea earns if it's kept after its test. A build idea earns when the Sequencer ships it." },
];

const CHECKS = [
  { href: "/live", name: "Watch it work", text: "What the AI is doing now, and why." },
  { href: "/sequencer", name: "See the whole engine", text: "One map of ideas, the brain, the sequencer, the public hour and the money." },
  { href: "/proof", name: "Check the machine", text: "The AI's key lives in a sealed machine. Your browser can check it." },
  { href: "/memory", name: "Read its memory", text: "Every test, kept or killed, and what it taught." },
  { href: "/announcements", name: "Follow the news", text: "Every draw, vote, reward and test, with its transaction." },
  { href: "/docs?mode=smart", name: "Read the numbers", text: "Every rule and figure with the contract constant that enforces it." },
];

export default function HowItWorksPage() {
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="how" back={null} sample={false}
          title="How it works"
          lede="DNA is an Ethereum token whose Uniswap hook keeps changing. An AI tests each change on real trades and keeps only what works. The sequencer builds new games from the best ideas. All in public, inside limits nobody can change."
          aside={<Link className={ui.link} href="/docs">Prefer it short or in full detail? The docs →</Link>}
        />

        <Section title="The loop" note="about 8 hours a turn · at most 3 a day">
          <div className={s.hook}>
            <p className={s.hookLead}>In CT terms, every mutation is a new hook.</p>
            <p className={s.hookText}>
              In code terms, it&apos;s a module, or new settings for one, plugged into DNA&apos;s one Uniswap v4 hook. The hook itself never changes.
              Right now the AI tunes settings on fee modules the Safe approved. New module code comes from the Sequencer and needs the Safe&apos;s signature.
            </p>
          </div>
          <ol className={s.loop}>
            {LOOP.map((x, i) => (
              <li key={x.name} style={{ "--c": x.c } as React.CSSProperties}>
                <span className={s.step} aria-hidden>{i + 1}</span>
                <h3 className={s.stage}>{x.name}</h3>
                <span className={s.time}>{x.time}</span>
                <p className={s.stageText}>{x.text}</p>
              </li>
            ))}
            <li className={s.verdict}>
              <span className={s.step} aria-hidden>5</span>
              <h3 className={s.stage}>The verdict</h3>
              <div className={s.fork}>
                <p data-kept><b>Kept</b> It did better. After one more public hour it becomes the live fee. Until level 8, the Safe signs this step.</p>
                <p data-killed><b>Killed</b> It broke or did worse: rolled back at once, and the lesson goes to memory.</p>
              </div>
            </li>
          </ol>
          <p className={s.foot}>Every turn is on the <Link className={ui.link} href="/evolution">family tree</Link>.</p>
        </Section>

        <Section title="The Sequencer" note={<Link className={ui.link} href="/sequencer">See the map →</Link>}>
          <p className={`${ui.prose} ${ui.muted}`}>
            The fee loop tunes the hook. The sequencer builds new games and modules. The brain picks an idea, the sequencer
            writes the contract, the page and the tests, a tester attacks them, and the brain decides whether it ships. The deploy and its
            funding wait one public hour. It&apos;s switched on and builds from the first winning idea.
          </p>
        </Section>

        <Section title="Hard limits" note={<Link className={ui.link} href="/constitution">Every rule and the code behind it →</Link>}>
          <dl className={s.rules}>
            {RULES.map((r) => <div key={r.v}><dt>{r.v}</dt><dd>{r.text}</dd></div>)}
          </dl>
          <p className={s.foot}>The hook is immutable. No proxy admin, no upgrade key, not even for us. These limits are constants in its code, and the AI can&apos;t change them either.</p>
        </Section>

        <Section title="Where fees go" note={<Link className={ui.link} href="/treasury">The live split →</Link>}>
          <FeeBreakdown />
          <p className={s.feeText}>
            The AI can tune DNA&apos;s part between 1% and 3.5% (hard cap {FEE.cap}). Programmable&apos;s {FEE.platform} goes to Programmable.
            DNA&apos;s part splits four ways:
          </p>
          <div className={s.split} role="img" aria-label="DNA's fee: 35% burn, 30% liquidity, 25% treasury, 10% games">
            {SPLIT.filter((x) => x.pct > 0).map((x) => <span key={x.name} style={{ flexGrow: x.pct, "--c": x.c } as React.CSSProperties} />)}
          </div>
          <ul className={s.splitKey}>
            {SPLIT.map((x) => (
              <li key={x.name} style={{ "--c": x.c } as React.CSSProperties}><b>{x.pct}%</b><span className={ui.strong}>{x.name}</span><span>{x.text}</span></li>
            ))}
          </ul>
        </Section>

        <Section title="The games" note="all on contracts nobody can change">
          <ul className={s.games}>
            {GAMES.map((g) => (
              <li key={g.name} style={{ "--c": g.c } as React.CSSProperties}>
                <h3 className={s.gameName}>{g.name}</h3>
                <div className={s.gameBody}>
                  <ul className={s.facts} aria-label={`${g.name} in numbers`}>{g.facts.map((f) => <li key={f}>{f}</li>)}</ul>
                  <p className={s.gameText}>{g.text}</p>
                  <Link className={s.go} href={g.href}>{g.go}<span aria-hidden> →</span></Link>
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Genome Vaults" note={<Link className={ui.link} href="/vaults">The 50 slots →</Link>}>
          <p className={`${ui.prose} ${ui.muted}`}>
            Fifty vaults, each an NFT. Lock 200,000 DNA to mint one; burn it any time and the DNA comes straight back with the ETH the
            vault has not claimed. The Safe sends the vaults ETH from the treasury&apos;s fee share, split equally across every eligible
            vault; a new vault joins at the next fund. No owner mint, no upgrade, and nobody can touch the deposit but the owner. All 50
            are equal, and nothing is promised.
          </p>
        </Section>

        <Section title="How to check us">
          <ul className={s.checks}>
            {CHECKS.map((c) => (
              <li key={c.href}><Link href={c.href}><span className={s.checkName}>{c.name}<span aria-hidden> →</span></span><span className={s.checkText}>{c.text}</span></Link></li>
            ))}
          </ul>
        </Section>

        <Section title="The risks">
          <p className={s.risk}>This can go to zero. It&apos;s a new coin run by an experimental AI, and code can have bugs. The jackpot is a draw, not income: most holders never win. Not financial advice. Only put in what you can afford to lose.</p>
          <nav className={s.next} aria-label="Next">
            <Link className={ui.button} href="/live">See it live</Link>
            <Link className={ui.button} href="/docs">Read the docs</Link>
            <Link className={ui.button} href="/play">Play</Link>
          </nav>
        </Section>
      </div>
    </Shell>
  );
}
