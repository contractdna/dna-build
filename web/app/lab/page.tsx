import type { Metadata } from "next";
import Link from "next/link";
import { LIVE } from "../_data/flags";
import { Shell } from "../_ui/Shell";
import { PageHead, ui } from "../_ui/ui";

export const metadata: Metadata = {
  title: "Lab · DNA",
  description: "Every piece of evidence behind DNA in one place: the AI's reasoning, its experiments, memory, fee modules, autonomy, treasury, rules, journal and security log.",
};

// Four threads, one colour each (the homepage's topic colours). Each card's still is the scene's own rule card for that topic.
const GROUPS: { label: string; c: string; cards: { href: string; title: string; text: string; img: string }[] }[] = [
  { label: "Its mind", c: "var(--violet)", cards: [
    { href: "/mind", title: "AI thread", text: "Its reasoning, step by step, with the evidence for and against.", img: "thread" },
    { href: "/lab/experiments", title: "Experiments", text: "The ideas on the test bench right now, and their numbers.", img: "experiments" },
    { href: "/memory", title: "Memory", text: "Every test it has run, kept or killed, and the lesson it took.", img: "memory" },
  ] },
  { label: "Its body", c: "var(--teal)", cards: [
    { href: "/modules", title: "Modules", text: "The swappable parts of its hook: which run, which wait.", img: "modules" },
    { href: "/evolution", title: "Evolution", text: "Its family tree: every mutation, dead ones included.", img: "mystery" },
    { href: "/autonomy", title: "Autonomy", text: "How much it may do today, and what it must prove for more.", img: "autonomy" },
  ] },
  { label: "Its money", c: "var(--amber)", cards: [
    { href: "/treasury", title: "Treasury", text: "Where every fee goes, and what each vault holds.", img: "treasury" },
    { href: "/play", title: "Play", text: "The jackpot, the vote and the next mystery.", img: "play" },
    { href: "/bounties", title: "Bounties", text: "Paid work anyone can claim, with rewards held in a contract.", img: "ideas" },
    ...(LIVE ? [{ href: "/xp", title: "XP", text: "Points for helping DNA, counted from public on-chain events.", img: "play" }] : []), // XP is chain-derived: LIVE only
  ] },
  { label: "Its rules", c: "var(--rose)", cards: [
    { href: "/constitution", title: "Hard limits", text: "What the contracts make impossible, for the AI and for us.", img: "rules" },
    { href: "/security", title: "Security", text: "Who can stop what, how fast, and what has gone wrong.", img: "security" },
    { href: "/proof", title: "Proof", text: "Check where the AI's key lives and which code holds it.", img: "thread" },
    { href: "/models", title: "Models", text: "Which AI model does each job, with its backup.", img: "thread" },
    { href: "/journal", title: "Journal", text: "One short report a day: what came in, what was tried, what was learned.", img: "streak" },
  ] },
];

export default function LabPage() {
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="lab" back={null} sample={false} title="Lab" lede="Everything the AI does leaves evidence. Pick a thread and pull it." />
        {GROUPS.map((g) => (
          <section key={g.label} className={ui.section} aria-label={g.label}>
            <div className={ui.sectionHead}><h2 className={ui.label}>{g.label}</h2></div>
            <div className={ui.cards}>
              {g.cards.map((c) => (
                <Link key={c.href} href={c.href} className={ui.card} style={{ "--c": g.c } as React.CSSProperties}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- decorative still */}
                  <div className={ui.cardImg}><img src={`/dna/card-${c.img}.webp`} alt="" loading="lazy" /></div>
                  <h3 className={ui.cardTitle}>{c.title}</h3>
                  <p className={ui.cardText}>{c.text}</p>
                  <span className={ui.cardGo} aria-hidden>Open →</span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Shell>
  );
}
