import type { Metadata } from "next";
import Link from "next/link";
import { LIVE } from "../_data/flags";
import { getContracts, getIdeas, getIntake, getPool, getQueue } from "../_data/source";
import type { Idea } from "../_data/types";
import { Shell } from "../_ui/Shell";
import { Chip, fmtDate, fmtTime, PageHead, Section, short, ui } from "../_ui/ui";
import { WalletBar, WalletProvider } from "../_ui/Wallet";
import { RoundClock, StakeIdea, SubmitIdea } from "./IdeaForms";
import p from "./proposals.module.css";

export const metadata: Metadata = {
  title: "Ideas · DNA",
  description: "Stake DNA on the ideas you back. Rounds last 24 hours, and backers of accepted ideas split the stakes of rejected ones.",
};

// LIVE: staking and submitting go from the visitor's wallet to IdeaMarket (IdeaForms.tsx), once its address is read
const gateOf = (market: string | null) => (!LIVE ? "opens at launch · wallet required" : market ? "from your wallet · an approval, then the call" : "the market's address can't be read right now; try again in a minute");
// what each intake status means, in plain words (engine/src/ideas.ts)
const INTAKE: Record<string, string> = {
  gated: "stopped at the gate", screened: "read, not an idea", candidate: "candidate for the next round", picked: "picked for the next round",
  not_picked: "not in the round's top 16", submitted: "submitted on-chain", duplicate: "a duplicate", skipped: "skipped", full: "round full",
};
const DAY = 86_400_000;
const fmt = (n: number) => n.toLocaleString("en-US");
const QUEUE_CHIP = { executed: { value: "active", label: "executed" }, cancelled: { value: "rejected", label: "cancelled" }, pending: { value: "open", label: "pending" } } as const;
const FINAL = new Set<Idea["status"]>(["accepted", "rejected", "void"]);

// IdeaMarket constants (SPEC §10.2), shown verbatim.
const TERMS = [
  ["Submission fee", "1,000 DNA", "burned, non-refundable"],
  ["Opening stake", "≥ 10,000 DNA", "refundable per outcome"],
  ["Minimum stake", "1,000 DNA", "per stake"],
  ["Max per address", "1,000,000 DNA", "per round, opening stake included"],
  ["Max per idea", "2,000,000 DNA", "all stakers combined"],
  ["Slots per round", "112 + 16", "public + reserved for the agent"],
  ["Round", "24 hours", "stake only while the round is open"],
  ["Lock-up", "up to ~5 days", "24 h round + ≤ 3 d to resolve + 24 h"],
] as const;

export default async function ProposalsPage() {
  const [{ ideas, start, roundMs }, queue, intake, { ideaMarket }, pool] = await Promise.all([getIdeas(), getQueue(), getIntake(), getContracts(), getPool()]);
  const GATE = gateOf(ideaMarket);
  const token = pool?.token ?? null;
  const rounds = [...new Set(ideas.map((i) => i.round))].sort((x, y) => y - x);
  const roundEnd = (r: number) => new Date(Date.parse(start ?? "") + (r + 1) * roundMs).toISOString();
  // the round open right now (IdeaMarket: round r runs [START + L·r, START + L·(r+1))); null before the indexer read the clock
  const nowRound = start ? Math.max(0, Math.floor((Date.now() - Date.parse(start)) / roundMs)) : null;
  return (
    <Shell>
      <WalletProvider>
      <div className={ui.page}>
        <PageHead hero="ideas"
          back={null}
          title="Ideas"
          lede="Stake DNA on the ideas you think DNA should adopt. Each round lasts 24 hours."
          aside={<><Link className={ui.link} href="/rules">How ideas from X get in</Link> · <Link className={ui.link} href="/bounties">Looking for paid work? See bounties</Link> · <Link className={ui.link} href="/docs#rewards">Idea rewards: ETH for ideas that ship, once the games share turns on</Link></>}
        />

        <Section title="Before you stake">
          <ul className={`${ui.prose} ${p.risk} ${p.rules}`}>
            <li>The team&apos;s AI judges every round, and the brain signs each outcome. It&apos;s not a vote or an independent oracle.</li>
            <li>Each outcome is public for 1 hour before it goes on-chain, and 2 Safe owners can veto it. Then it&apos;s public for 24 more hours and the Safe can cancel it. Then it&apos;s final.</li>
            <li>Stakes are locked until the round resolves, up to about 5 days. You can&apos;t unstake.</li>
            <li>If the AI hasn&apos;t judged a closed round within 2 days, every idea in it is void and every stake is refunded.</li>
            <li>If the idea you back is rejected, your stake goes to backers of accepted ideas. If a round has no accepted idea, everyone is refunded. Only stake what you can afford to lose.</li>
          </ul>
          <dl className={p.terms}>
            {TERMS.map(([k, v, note]) => (
              <div key={k}><dt>{k}</dt><dd>{v}</dd><dd className={p.termNote}>{note}</dd></div>
            ))}
          </dl>
        </Section>

        {LIVE && (
          <Section title="Queued changes" note={`${queue.length} ops · 1 h timelock · the Safe can cancel`}>
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr><th scope="col">#</th><th scope="col">Op</th><th scope="col">Target</th><th scope="col">Proposer</th><th scope="col">Executable from</th><th scope="col">Status</th></tr>
                </thead>
                <tbody>
                  {queue.map((q) => (
                    <tr key={q.id}>
                      <td>{q.id}</td>
                      <th scope="row" className={ui.nowrap}>{q.op}</th>
                      <td className={ui.nowrap}>{q.target ? (q.target.startsWith("0x") ? short(q.target) : q.target) : <span className={ui.dim}>none</span>}</td>
                      <td className={ui.nowrap}>{short(q.proposer)}</td>
                      <td className={ui.nowrap}><time dateTime={q.eta}>{fmtDate(q.eta)} {fmtTime(q.eta)}</time></td>
                      <td><Chip {...QUEUE_CHIP[q.status]} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {LIVE && (
          <Section title="Ideas from X" note={`${intake.total} mentions read · ${intake.ideas} ideas`}>
            {intake.total === 0 ? <p className={`${ui.prose} ${ui.muted}`}>No X mentions read so far.</p> : (
              <ul className={ui.prose}>
                {intake.reasons.map((x) => <li key={x.status}><b>{x.n}</b> {INTAKE[x.status] ?? x.status.replace(/_/g, " ")}{x.example && <span className={ui.dim}> · {x.example}</span>}</li>)}
              </ul>
            )}
            <p className={`${ui.prose} ${ui.muted}`}>Every decision is a signed record with its public reason. At each round&apos;s close the top 16 go on-chain at the start of the next round. <Link className={ui.link} href="/rules">How ideas from X get in</Link></p>
          </Section>
        )}

        {LIVE && ideas.length === 0 && (
          <Section title={nowRound === null ? "This round" : `Round ${nowRound}`} note={nowRound === null ? undefined : <>open · <RoundClock end={roundEnd(nowRound)} /></>}>
            <p className={`${ui.prose} ${ui.muted}`}>No ideas on-chain in this round so far. Ideas from X that pass the filter go in at the start of the next round{ideaMarket && token ? <>; anyone can also submit one <a className={ui.link} href="#submit">below</a></> : null}.</p>
          </Section>
        )}

        {rounds.map((r) => {
          const list = ideas.filter((i) => i.round === r);
          const staked = fmt(list.reduce((sum, i) => sum + i.staked, 0));
          // no round clock read yet (start null): the counts without dates
          const end = start ? roundEnd(r) : null;
          const open = list.some((i) => i.status === "open");
          const note = open
            ? <>open{end && <> · <RoundClock end={end} /></>} · {list.length} ideas · {staked} DNA staked</>
            : list.every((i) => FINAL.has(i.status))
              ? `final · ${list.length} ideas · ${staked} DNA staked`
              : end ? `closed ${fmtDate(end)} · in research · outcome window ends ${fmtDate(new Date(Date.parse(end) + 3 * DAY).toISOString())}`
                : `closed · in research · ${list.length} ideas · ${staked} DNA staked`;
          return (
            <Section key={r} title={`Round ${r}`} note={note}>
              {open && ideaMarket && token && <WalletBar token={token} />}
              <ol className={p.list}>
                {list.map((i) => (
                  <li key={i.id} className={p.item}>
                    <div className={p.id}>#{i.id}</div>
                    <div>
                      <h3 className={p.h3}>{i.title}</h3>
                      <p className={`${ui.prose} ${ui.muted} ${p.summary}`}>{i.summary}</p>
                      {i.resolution && <p className={p.resolution}>{i.resolution}</p>}
                    </div>
                    <dl className={p.meta}>
                      <div><dt>Staked</dt><dd>{fmt(i.staked)} DNA</dd></div>
                      <div><dt>Stakers</dt><dd>{i.stakers}</dd></div>
                      <div><dt>Author</dt><dd>{short(i.author)}</dd></div>
                      <div><dt>Submitted</dt><dd><time dateTime={i.submitted}>{fmtDate(i.submitted)}</time></dd></div>
                    </dl>
                    <div className={p.act}>
                      <Chip value={i.status} />
                      {i.status === "open" && <StakeIdea id={i.id} round={r} gate={GATE} market={ideaMarket} token={token} />}
                    </div>
                  </li>
                ))}
              </ol>
            </Section>
          );
        })}

        <Section title="Submit an idea">
          <SubmitIdea gate={GATE} market={ideaMarket} token={token} />
        </Section>
      </div>
      </WalletProvider>
    </Shell>
  );
}
