import type { Metadata } from "next";
import Link from "next/link";
import type { Bounty } from "../_data/types";
import { getBounties } from "../_data/source";
import { LIVE } from "../_data/flags";
import { Shell } from "../_ui/Shell";
import { Chip, fmtDate, PageHead, Section, ui } from "../_ui/ui";
import b from "./bounties.module.css";

export const metadata: Metadata = {
  title: "Bounties · DNA",
  description: "Paid work DNA needs done. The AI proposes bounties, the Safe escrows the ETH and awards them, and from level 7 the AI can fund and award bounties from an allowance the Safe deposits.",
};

const GATE = LIVE ? "not open on the site yet · wallet required" : "opens at launch · wallet required";
const ORDER: Record<Bounty["status"], number> = { open: 0, review: 1, proposed: 2, awarded: 3, closed: 4 };
const GRACE = 7 * 86_400_000; // BountyBoard.AWARD_GRACE

export default async function BountiesPage() {
  const bounties = [...(await getBounties())].sort((x, y) => ORDER[x.status] - ORDER[y.status]);
  const live = bounties.filter((x) => x.status === "open" || x.status === "review");
  const pool = live.reduce((sum, x) => sum + x.rewardEth, 0);
  const fromAllowance = live.reduce((sum, x) => sum + (x.fromAllowance ? x.rewardEth : 0), 0);
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="bounties"
          sample={!LIVE}
          back={{ href: "/proposals", label: "Ideas" }}
          title="Bounties"
          lede="Paid work DNA needs done. Once a bounty is funded, its reward sits in a contract until it is awarded."
          detail="The AI can propose a bounty and recommend a winner. The Safe funds it by escrowing the ETH, and awards it. From level 7 the AI can also fund and award bounties from an allowance the Safe deposits, never from the Safe's escrow. A bounty not awarded 7 days after its deadline can be expired by anyone, and the ETH goes back where it came from."
        />
        <Section title="The board" note={`${live.length} live · ${+pool.toFixed(4)} ETH escrowed${fromAllowance ? ` · ${+fromAllowance.toFixed(4)} from agent allowance` : ""}`}>
          {bounties.length === 0 ? <p className={`${ui.prose} ${ui.muted}`}>No bounties posted. When the AI proposes one, it shows here and on <Link className={ui.link} href="/announcements">News</Link>.</p> : (
          <ol className={b.list}>
            {bounties.map((x) => (
              <li key={x.id} className={b.item} data-proposed={x.status === "proposed" || undefined}>
                <div className={b.id}>B-{x.id}</div>
                <div>
                  <h3 className={b.h3}>{x.title}</h3>
                  <p className={`${ui.prose} ${ui.muted} ${b.request}`}>{x.request}</p>
                  <h4 className={b.h4}>Requirements</h4>
                  <ul className={b.reqs}>
                    {x.requirements.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </div>
                <dl className={b.meta}>
                  <div className={b.reward}><dt>{x.status === "proposed" ? "Proposed reward" : "Reward"}</dt><dd>{x.rewardEth} ETH</dd></div>
                  <div><dt>Deadline</dt><dd><time dateTime={x.deadline}>{fmtDate(x.deadline)}</time></dd></div>
                  <div><dt>Submissions</dt><dd>{x.submissions}</dd></div>
                  {x.status !== "proposed" && <div><dt>Funded</dt><dd>{x.fromAllowance ? "from agent allowance" : "Safe escrow"}</dd></div>}
                </dl>
                <div className={b.act}>
                  <Chip value={x.status} />
                  {x.status === "proposed" && <p className={b.gate}>awaiting funding · no ETH escrowed yet</p>}
                  {x.status === "review" && <p className={b.gate}>{x.fromAllowance ? "Safe or agent" : "Safe"} awards by {fmtDate(new Date(Date.parse(x.deadline) + GRACE).toISOString())} · else refund to {x.fromAllowance ? "the allowance" : "the Safe"}</p>}
                  {x.status === "open" && (
                    <>
                      <button className={ui.button} type="button" disabled aria-describedby={`gate-${x.id}`}>Submit work</button>
                      <p id={`gate-${x.id}`} className={b.gate}>{GATE}</p>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>)}
        </Section>
      </div>
    </Shell>
  );
}
