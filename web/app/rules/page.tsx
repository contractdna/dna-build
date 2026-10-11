import type { Metadata } from "next";
import Link from "next/link";
import { FEE } from "../_data/launchFee";
import { Shell } from "../_ui/Shell";
import { PageHead, Section, ui } from "../_ui/ui";

export const metadata: Metadata = {
  title: "Rules for ideas and replies · DNA",
  description: "How an idea posted on X reaches DNA's idea market, why most do not, and how often the AI posts and replies.",
};

// The values below are the engine's (engine/src/ideas.ts GATE, engine/src/config.ts X); engine/test/ideas.test.ts
// fails if this page and those values drift apart.
const GATE = [
  ["Verified badge", "The author has X's blue badge. Business (gold) and government (grey) badges count too."],
  ["Account age", "The account is at least 30 days old."],
  ["Followers", "The account has at least 50 followers."],
  ["One per round", "At most 1 idea per person per round (a round is 24 hours)."],
  ["No links", "Write the idea in the post itself. A post with a link is dropped."],
  ["No duplicates", "An idea that repeats one already in the round (same title, or mostly the same words) is dropped."],
] as const;

const SCREEN = [
  ["Fee idea", "a concrete, sincere change to the fee or split settings: how the fee moves, or where it goes. Goes on."],
  ["Build idea", "a concrete, sincere new game, utility or module the Sequencer could build as its own contract. Goes on, and the Sequencer builds it."],
  ["Impossible", `needs something the hard limits forbid, and only that: changing the hook or the token (a fee above ${FEE.cap}, for example), minting, holding people's funds, or anything illegal.`],
  ["Joke", "not meant seriously."],
  ["Shill", "promotes a token, a project or a person."],
  ["Spam", "anything else that is not an idea."],
] as const;

export default function IdeaRulesPage() {
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="ideas"
          back={{ href: "/proposals", label: "Ideas" }}
          sample={false}
          title="Rules for ideas and replies"
          lede="Anyone can suggest a change on X. A public filter decides which ideas reach the idea market, and every decision is written down with its reason."
          detail="Three steps: a fixed gate, a screen by the AI, and a pick of the best when the round closes. The team doesn't hand-pick ideas."
        />

        <Section title="How to submit an idea">
          <p className={`${ui.prose} ${ui.muted}`}>
            Post your idea on X and tag <a className={ui.link} href="https://x.com/contractdna" target="_blank" rel="noopener noreferrer">@contractdna</a>.
            Say what should change and why, in plain words. One post, one idea.
          </p>
        </Section>

        <Section title="1. The gate" note="fixed rules, checked by code">
          <ul className={ui.prose}>
            {GATE.map(([k, v]) => <li key={k}><span className={ui.strong}>{k}:</span> {v}</li>)}
          </ul>
        </Section>

        <Section title="2. The screen" note="the AI reads the post">
          <p className={`${ui.prose} ${ui.muted}`}>
            A sandboxed reader with no tools sorts each post into one of six kinds. Fee and build ideas are restated neutrally and
            scored 0 to 10 on clarity, feasibility and value, for a score out of 30.
          </p>
          <ul className={ui.prose}>
            {SCREEN.map(([k, v]) => <li key={k}><span className={ui.strong}>{k}:</span> {v}</li>)}
          </ul>
        </Section>

        <Section title="3. The pick" note="top 16 per round">
          <p className={`${ui.prose} ${ui.muted}`}>
            When a round closes, its 16 highest-scoring fee and build ideas are submitted to the idea market at the start of the next
            round, so each gets a full round of staking. The rest are marked &quot;not in the top 16&quot; with their score.
          </p>
        </Section>

        <Section title="Every decision is public">
          <p className={`${ui.prose} ${ui.muted}`}>
            Each post&apos;s outcome (gated, screened out, picked or not, submitted) is written to the public log with the reason, for
            example &quot;fewer than 50 followers&quot; or &quot;screened as shill&quot;. The AI never replies to tell you an idea was
            rejected.
          </p>
        </Section>

        <Section title="How the AI posts and replies">
          <ul className={ui.prose}>
            <li>At most 15 posts of its own a day, at least 20 minutes apart. Money results go first, then votes, mysteries and games, then the AI dev team and experiments, then the status, recap and milestones, then the rest; posts not out by 23:00 UTC roll into one daily digest post. Everything is on <Link className={ui.link} href="/announcements">News</Link>.</li>
            <li>What it posts about: on-chain results and human-approved drafts; the AI dev team when it starts a build, ships one or drops one (never each round); its own improvements only once they ship, go to the Safe for approval (and again when the Safe approves the code), or are handed to the owners for review; a status at 14:00 and 22:00 UTC with the last 12 hours (skipped when nothing moved); a recap on Sundays at 18:00 UTC; milestones in total DNA burned (once each) and the jackpot pot (once per climb between draws). Every number comes from the chain or the signed log, never from the AI, and each post links its transaction or signed record.</li>
            <li>For each jackpot draw it posts the window&apos;s rules before it opens, the ticket list after it closes, then the 10 winners with a <Link className={ui.link} href="/play">proof page</Link>.</li>
            <li>It replies only to a post that tags it or quotes it (X&apos;s rule for automated accounts), from people who pass the gate&apos;s account checks (badge, 30-day account, 50 followers).</li>
            <li>Until X approves its AI replies, it answers only large accounts (a badge and 25,000 followers or 250 lists), and a signer releases each of those replies first. The words are still the AI&apos;s.</li>
            <li>At most 2 replies to the same person a day, one per conversation. A large account gets a thread: one reply to each new post that tags it, up to 40 a day, until the other side looks like a bot, repeats itself, echoes the AI&apos;s words back, tries to give it orders, or the thread has run for a day.</li>
            <li>Reply &quot;stop&quot; and it never replies to you again.</li>
            <li>A safety ceiling of 200 replies a day and 30 an hour across everyone.</li>
          </ul>
        </Section>

        <Section title="Getting paid for an idea" note="idea rewards">
          <ul className={ui.prose}>
            <li>A fee idea that is kept after its test, or a build idea that ships, can earn its author ETH from the idea reserve (30% of the games pot, which fills from the games share of fees). The brain sets the amount inside the contract&apos;s limits. Every payment waits one public hour and the Safe can cancel it.</li>
            <li>Idea market ideas pay the wallet that submitted them. X ideas pay the wallet your X account linked: post <span className={ui.strong}>@contractdna</span> with one wallet address and nothing else. Code reads it, not the AI, and the post must pass the same account checks as ideas.</li>
            <li>The link between your X account and that wallet is public. Use a fresh wallet if you want.</li>
            <li>Your first wallet counts at once and gets one reply on X. A different wallet takes effect 48 hours after the post and is announced on the site only. Posting your current wallet again within those 48 hours cancels the change. At most 3 wallet posts count a day.</li>
            <li>A reward with no linked wallet, or no room under the contract&apos;s caps, waits up to 30 days. Then it&apos;s dropped and the money stays in the reserve.</li>
          </ul>
        </Section>

        <Section title="Staking on ideas">
          <p className={`${ui.prose} ${ui.muted}`}>
            You can back ideas with DNA on-chain. Submitting one directly takes a 10,000 DNA opening stake plus a 1,000 DNA fee that
            is burned. Terms and open rounds: the <Link className={ui.link} href="/proposals">ideas page</Link>.
          </p>
        </Section>
      </div>
    </Shell>
  );
}
