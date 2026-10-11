import type { Metadata } from "next";
import { LIVE } from "../_data/flags";
import { getClones, getPool } from "../_data/source";
import { Shell } from "../_ui/Shell";
import { PageHead, Section, short, ui } from "../_ui/ui";
import { CopyAddress } from "../treasury/CopyAddress";
import { poolId, poolKey, UNREAD } from "./swap";
import { SwapBox } from "./SwapBox";
import t from "./trade.module.css";

export const metadata: Metadata = {
  title: "Trade · DNA",
  description: "Buy or sell DNA in its own pool, the one whose fees fund the buyback, liquidity and the games. Other DNA pools pay DNA nothing.",
};

const ZERO = /^0x0{40}$/i;
const LP_FEE = (pips: number | null) => (pips === null ? "dynamic" : `${(pips / 1e4).toFixed(2)}%`);
const SHOWN = 50;
const dna = (wei: bigint) => (Number(wei / BigInt(10) ** BigInt(15)) / 1e3).toLocaleString("en-US", { maximumFractionDigits: 0 });

export default async function TradePage() {
  const [pool, { clones, leakage }] = await Promise.all([getPool(), getClones()]);
  const id = pool ? poolId(poolKey(pool.token, pool.hook)) : null;
  const volume = new Map(leakage?.byClone.map((c) => [c.id, BigInt(c.dna)]));
  // the busiest copies first (by DNA traded in the leakage window, then newest); the rest are counted, not listed
  const shown = [...clones].sort((a, b) => { const d = (volume.get(b.id) ?? BigInt(0)) - (volume.get(a.id) ?? BigInt(0)); return d > BigInt(0) ? 1 : d < BigInt(0) ? -1 : b.block - a.block; }).slice(0, SHOWN);
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="treasury" back={null} sample={false}
          title="Trade"
          lede="Buy or sell DNA in its own pool: the one whose fees fund the buyback, liquidity and the games."
          detail="The swap goes from your wallet straight to Uniswap's Universal Router and into DNA's pool, nothing in between. Wallets and aggregators may not find this pool for the first days, until they add support for its hook."
        />

        <Section title="Swap" note={pool ? "Uniswap v4 · Universal Router" : LIVE ? undefined : "pre-launch"}>
          <SwapBox token={pool?.token ?? null} hook={pool?.hook ?? null} />
        </Section>

        <Section title="The official pool">
          {pool && id ? (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <tbody>
                  <tr><th scope="row">Token</th><td><CopyAddress address={pool.token} label={short(pool.token)} /></td></tr>
                  <tr><th scope="row">Hook</th><td><CopyAddress address={pool.hook} label={short(pool.hook)} /></td></tr>
                  <tr><th scope="row">Pool id</th><td><CopyAddress address={id} label={short(id)} what="pool id" /></td></tr>
                  <tr><th scope="row">Pair</th><td>ETH / DNA · fee set by the hook · tick spacing 1</td></tr>
                </tbody>
              </table>
            </div>
          ) : <p className={`${ui.prose} ${ui.muted}`}>{LIVE ? UNREAD : "Set at launch."}</p>}
        </Section>

        <Section title="Other DNA pools" note={leakage ? `blocks ${leakage.fromBlock.toLocaleString("en-US")}–${leakage.toBlock.toLocaleString("en-US")}` : undefined}>
          <p className={ui.prose}>
            Anyone can open another DNA pool, on Uniswap or elsewhere, and nobody can stop it. Trades there pay nothing to DNA: no buyback, no
            liquidity, no jackpot. Their fees go to whoever put money in them. The official pool is the one above. We list the others here so
            you can tell them apart, and never link to them.
          </p>
          {leakage && <p className={t.leak}>Last ~24 h: {leakage.pct}% of DNA volume went through other pools.</p>}
          {clones.length === 0 ? <p className={`${ui.prose} ${ui.muted}`}>None seen{pool ? " yet" : ""}.</p> : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead><tr><th>Venue</th><th>Pool</th><th>Paired with</th><th>LP fee</th><th>Hook</th><th>DNA traded (window)</th><th>Opened at block</th></tr></thead>
                <tbody>
                  {shown.map((c) => (
                    <tr key={c.id}>
                      <td className={ui.nowrap}>{c.venue}</td>
                      <td className={t.hash}>{short(c.id)}</td>
                      <td className={t.hash}>{ZERO.test(c.other) ? "ETH" : short(c.other)}</td>
                      <td>{LP_FEE(c.fee)}</td>
                      <td className={t.hash}>{c.version !== 4 ? "n/a" : c.hooks && !ZERO.test(c.hooks) ? short(c.hooks) : "none"}</td>
                      <td>{dna(volume.get(c.id) ?? BigInt(0))}</td>
                      <td>{c.block.toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {clones.length > SHOWN && <p className={`${ui.prose} ${ui.muted}`}>and {(clones.length - SHOWN).toLocaleString("en-US")} more (all of them: /api/clones).</p>}
            </div>
          )}
        </Section>
      </div>
    </Shell>
  );
}
