import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LIVE } from "../../../_data/flags";
import { getDraw } from "../../../_data/source";
import release from "../../../proof/release.json";
import { Shell } from "../../../_ui/Shell";
import { fmtDate, fmtTime, PageHead, Section, ui } from "../../../_ui/ui";
import s from "../../play.module.css";
import { DrawCheck } from "../DrawCheck";

export const metadata: Metadata = {
  title: "Jackpot draw · DNA",
  description: "One holder-jackpot draw: the ticket list, the Chainlink VRF word, the 10 winners and the payouts, checked in your browser.",
};

const TX = "https://etherscan.io/tx/";
// the public source under the project's own org
const CLI = (id: string) => `# github.com/contractdna/dna-build (engine/)\nnode scripts/verify-draw.ts --window ${id} --rpc <your node>,<a second node>`;
const PAID = { pushed: "sent straight to the wallet", claimed: "claimed", expired: "not claimed in 7 days: back in the pot", claimable: "the wallet refused the transfer: claimable for 7 days" };

export default async function DrawPage({ params }: PageProps<"/play/draw/[id]">) {
  const { id } = await params;
  if (!/^\d{1,9}$/.test(id)) notFound();
  const d = await getDraw(Number(id));
  if (!d && LIVE) notFound();
  const when = (iso: string) => `${fmtDate(iso)}, ${fmtTime(iso)}`;
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead
          hero="play"
          back={{ href: "/play", label: "Play" }}
          sample={false}
          title={`Draw, window ${id}`}
          lede={d ? `${d.winners.length} ${d.winners.length === 1 ? "winner" : "winners"}, ${d.shareEth} ETH each` : "Every jackpot draw gets this page: the list it was drawn from, the random word, the 10 winners, and a check you run yourself."}
          aside={d ? <span className={ui.status}>{when(d.at)}</span> : <span className={ui.status}><span className={ui.demo}>[Demo]</span> Draws start with the jackpot at launch.</span>}
        />

        {d && (
          <Section title="The draw">
            <dl className={s.facts}>
              <div><dt>Window</dt><dd>{d.window}</dd></div>
              <div><dt>Prize</dt><dd>{d.prizeEth} ETH, split equally: {d.shareEth} ETH to each of up to 10 winners (unfilled places and dust back in the pot)</dd></div>
              <div><dt>Winners</dt><dd><ol className={s.drawWinners}>{d.winners.map((w) => <li key={w.rank}><span className={s.mono}>{w.account}</span> · {PAID[w.paid]}</li>)}</ol></dd></div>
              <div><dt>Tickets drawn</dt><dd>{d.ticketsUsed} of {d.list.totalTickets} (ticket j = keccak256(word, j) mod total; a wallet already picked or excluded is skipped)</dd></div>
              <div><dt>Random word</dt><dd>{d.rand}</dd></div>
              <div><dt>List</dt><dd>{d.list.holders} holders, cap {d.list.capBps / 100}% per wallet · root {d.list.root} · <a className={ui.link} href={d.list.uri} target="_blank" rel="noopener noreferrer">the full list</a></dd></div>
              <div><dt>Transactions</dt><dd>
                <a className={ui.link} href={`${TX}${d.tx.posted}`} target="_blank" rel="noopener noreferrer">list posted</a>
                {d.tx.requested && <> · <a className={ui.link} href={`${TX}${d.tx.requested}`} target="_blank" rel="noopener noreferrer">randomness requested</a></>}
                {d.tx.fulfilled && <> · <a className={ui.link} href={`${TX}${d.tx.fulfilled}`} target="_blank" rel="noopener noreferrer">Chainlink VRF answered</a></>}
                {" · "}<a className={ui.link} href={`${TX}${d.tx.drawn}`} target="_blank" rel="noopener noreferrer">winners paid</a>
              </dd></div>
            </dl>
          </Section>
        )}

        <Section title="Check it yourself">
          {d
            ? <DrawCheck window={d.window} gamePot={d.gamePot} blocks={d.blocks} logSigner={release.logSigner} />
            : <p className={`${ui.prose} ${ui.muted}`}>The in-browser check opens with the first draw.</p>}
          <p className={`${ui.prose} ${ui.muted}`}>The browser checks the list against the chain, the random word, all 10 winners and their proofs. Rebuilding the list itself means replaying every DNA transfer since launch, so that runs on your machine, from any Ethereum node:</p>
          <code className={s.cmd}>{CLI(id)}</code>
          <p className={`${ui.prose} ${ui.muted}`}>How the list is built: <Link className={ui.link} href="/play">the jackpot rules</Link>.</p>
        </Section>
      </div>
    </Shell>
  );
}
