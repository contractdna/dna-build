import type { Metadata } from "next";
import Link from "next/link";
import { getRules } from "../_data/source";
import { Shell } from "../_ui/Shell";
import { FEE } from "../_data/launchFee";
import { FeeBreakdown, PageHead, Section, ui } from "../_ui/ui";

export const metadata: Metadata = {
  title: "Hard limits · DNA",
  description: "DNA's hard limits: what its immutable contracts make impossible, and the code that enforces each one.",
};

export default async function ConstitutionPage() {
  const rules = await getRules();
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="rules"
          title="Hard limits"
          lede="The limits written into DNA's contracts. Nobody can change them: not the AI, not the team."
          detail="The hook is immutable. No proxy admin, no upgrade key, not even for us. DNA evolves inside these limits and cannot change them. Each rule is enforced by immutable contract code, not by promises; changing one would require a new pool and a voluntary migration."
        />
        <Section title="Written into the code" note={`${rules.length} rules · enforced on-chain`}>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr><th scope="col">Rule</th><th scope="col">Value</th><th scope="col">Enforced by</th></tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td className={`${ui.prose} ${ui.strong}`}>{r.rule}</td>
                    <td className={ui.nowrap}>{r.value}</td>
                    <td className={ui.nowrap}><span className={ui.strong}>{r.contract}</span><div className={ui.source}>{r.fn}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title="Fee per trade" note={`capped after the launch tax: ${FEE.cap} ours, ${FEE.capAllIn} all-in`}>
          <FeeBreakdown />
        </Section>
        <Section title="What the limits leave open">
          <p className={`${ui.prose} ${ui.muted}`}>
            Inside these limits, which modules run and their settings go through the public hour: set by the Safe, or by the AI as far
            as its level allows. See <Link className={ui.link} href="/autonomy">autonomy</Link> and <Link className={ui.link} href="/modules">modules</Link>.
          </p>
        </Section>
      </div>
    </Shell>
  );
}
