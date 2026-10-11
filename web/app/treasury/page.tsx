import type { Metadata } from "next";
import type { SplitShare } from "../_data/types";
import { getTreasury } from "../_data/source";
import { Shell } from "../_ui/Shell";
import { FEE } from "../_data/launchFee";
import { Chip, FeeBreakdown, fmtDate, fmtTime, PageHead, Section, short, ui } from "../_ui/ui";
import { CopyAddress } from "./CopyAddress";
import t from "./treasury.module.css";

export const metadata: Metadata = {
  title: "Treasury · DNA",
  description: "Where DNA's fees go: vault balances, the fee split inside its immutable bounds, recent flows and spending limits.",
};

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** The homepage's root colours: one per destination (unknown destinations stay neutral). */
const ROOT: Record<string, string> = { "buyback-burn": "var(--coral)", "auto-liquidity": "var(--teal)", treasury: "var(--amber)", games: "var(--violet)" };

/** One destination on a 0–100% scale: allowed range bracketed, current share filled in its root colour. */
function SplitBar({ s }: { s: SplitShare }) {
  const x = (bps: number) => (bps / 10000) * 400;
  const [lo, hi, now] = [x(s.min), x(s.max), x(s.bps)];
  return (
    <svg className={t.bar} viewBox="0 0 400 28" preserveAspectRatio="none" role="img"
      aria-label={`${s.dest}: ${pct(s.bps)} of project fees, allowed ${pct(s.min)} to ${pct(s.max)}`}>
      <line className={t.track} x1="0" x2="400" y1="14" y2="14" />
      <rect className={t.range} x={lo} width={hi - lo} y="6" height="16" />
      <rect className={t.now} x="0" width={now} y="10" height="8" />
      <path className={t.bracket} d={`M${lo + 5} 3H${lo}V25H${lo + 5}M${hi - 5} 3H${hi}V25H${hi - 5}`} />
    </svg>
  );
}

export default async function TreasuryPage() {
  const { vaults, split, flows, limits } = await getTreasury();
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="treasury"
          title="Treasury"
          lede="Where every fee goes: buying back and burning DNA, adding liquidity, the treasury and the games."
          detail="Every project fee lands in vaults (contracts that hold the fees) the AI cannot drain. A permissionless distribute call splits them between buyback-burn, auto-liquidity, the treasury and the games, and each share can only move inside bounds fixed in immutable code."
        />

        <Section title="Fee per swap">
          <FeeBreakdown />
          <p className={`${ui.prose} ${ui.muted} ${t.explain}`}>
            DNA&apos;s fee is {FEE.ours} ({FEE.oursLaunch} in the first hour, sliding down) and can never pass {FEE.cap} (only the launch tax, blocks 0 to 8, was above it). Programmable&apos;s {FEE.platform} goes
            to Programmable, not to these vaults. Liquidity providers earn no swap fee here: every DNA fee goes through the vaults.
          </p>
        </Section>

        <Section title="How fees are split" note="share of project fees · bounds immutable">
          <ul className={t.split}>
            {split.map((s) => (
              <li key={s.dest} className={t.share} style={{ "--c": ROOT[s.dest] ?? "var(--silver)" } as React.CSSProperties}>
                <div className={t.shareHead}>
                  <span className={ui.strong}>{s.dest}</span>
                  <span className={t.sharePct} style={{ color: "var(--c)" }}>{pct(s.bps)}</span>
                  <span className={t.bounds}>bounds {pct(s.min)} – {pct(s.max)}</span>
                </div>
                <SplitBar s={s} />
              </li>
            ))}
          </ul>
          <div className={t.axis} aria-hidden><span>0%</span><span>50%</span><span>100%</span></div>
        </Section>

        <Section title="The vaults" note={`${vaults.length} contracts`}>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr><th scope="col">Vault</th><th scope="col">Address</th><th scope="col">Balance</th><th scope="col">Note</th></tr>
              </thead>
              <tbody>
                {vaults.map((v) => (
                  <tr key={v.name}>
                    <td className={`${ui.strong} ${ui.nowrap}`}>{v.name}</td>
                    <td className={ui.nowrap}><CopyAddress address={v.address} label={short(v.address)} /></td>
                    <td className={`${ui.strong} ${ui.nowrap}`}>{v.balance} <span className={ui.dim}>{v.unit}</span></td>
                    <td>{v.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <div className={t.pair}>
          <Section title="Recent flows" className={t.flat}>
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr><th scope="col">Time</th><th scope="col">Kind</th><th scope="col">Amount</th><th scope="col">Tx</th></tr>
                </thead>
                <tbody>
                  {[...flows].sort((a, b) => b.at.localeCompare(a.at)).map((f) => (
                    <tr key={`${f.tx}-${f.kind}`}>
                      <td className={ui.nowrap}><time dateTime={f.at}>{fmtDate(f.at)} {fmtTime(f.at)}</time></td>
                      <td><Chip value={f.kind} /></td>
                      <td className={`${ui.strong} ${ui.nowrap}`}>{f.amount}</td>
                      <td className={ui.nowrap}><CopyAddress address={f.tx} label={short(f.tx)} what="transaction hash" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
          <Section title="Limits" className={t.flat}>
            <dl className={t.limits}>
              {limits.map((l) => (
                <div key={l.label}><dt>{l.label}</dt><dd>{l.value}</dd></div>
              ))}
            </dl>
          </Section>
        </div>
      </div>
    </Shell>
  );
}
