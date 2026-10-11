import type { Metadata } from "next";
import Link from "next/link";
import { LIVE } from "../_data/flags";
import { getXp } from "../_data/source";
import { Shell } from "../_ui/Shell";
import { PageHead, Section, short, Stat, ui } from "../_ui/ui";

export const metadata: Metadata = {
  title: "XP · DNA",
  description: "Contributor XP from public on-chain events: DNA staked on ideas, accepted ideas, bounty work submitted and bounties won. Weights are published; XP is a record, not a token.",
};

// Same weights as the `xp` view (engine/migrations/004_agents.sql).
const WEIGHTS = [
  ["Staking", "1 XP per 1,000 DNA", "IdeaMarket Staked (opening stakes included)"],
  ["Accepted idea", "500 XP", "author of an idea accepted in a finalized round"],
  ["Bounty work", "50 XP", "BountyBoard WorkSubmitted"],
  ["Bounty won", "1,000 XP", "BountyBoard BountyAwarded (winner)"],
] as const;
const fmt = (n: number) => n.toLocaleString("en-US");

export default async function XpPage() {
  const rows = await getXp();
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="play"
          title="XP"
          lede="Points for helping DNA evolve, counted from public on-chain events only."
          detail="Anyone can recompute them from the chain with the published weights. XP is a record, not a token: it cannot be transferred or sold."
        />
        <Section title="Weights" note="published · applied to finalized events">
          <div className={ui.rowStats}>
            {WEIGHTS.map(([k, v, src]) => <Stat key={k} label={k} value={v} source={src} />)}
          </div>
        </Section>
        <Section title="Leaderboard" note={LIVE ? `${rows.length} addresses · top 100` : "fills from chain events after launch"}>
          {rows.length === 0 ? (
            <p className={`${ui.prose} ${ui.muted}`}>No XP yet. Stake on an idea or submit bounty work on <Link className={ui.link} href="/proposals">proposals</Link> and <Link className={ui.link} href="/bounties">bounties</Link>.</p>
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr><th scope="col">#</th><th scope="col">Address</th><th scope="col">XP</th><th scope="col">Staking</th><th scope="col">Ideas</th><th scope="col">Work</th><th scope="col">Bounties</th></tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.addr}>
                      <td>{i + 1}</td>
                      <th scope="row" className={ui.nowrap}>{short(r.addr)}</th>
                      <td className={ui.strong}>{fmt(r.xp)}</td>
                      <td>{fmt(r.staking)}</td><td>{fmt(r.ideas)}</td><td>{fmt(r.work)}</td><td>{fmt(r.bounties)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </Shell>
  );
}
