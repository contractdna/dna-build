import type { Metadata } from "next";
import { Shell } from "../_ui/Shell";
import { PageHead, Section, ui } from "../_ui/ui";
import { PAGE, PARTS } from "./content";
import rows from "./models.json";
import s from "./models.module.css";

export const metadata: Metadata = { title: PAGE.metaTitle, description: PAGE.metaDescription };

type Model = { id: string; provider: string };
const byPart = new Map(rows.map((r) => [r.part, r]));

const Cell = ({ m }: { m: Model | null }) =>
  m ? <><code className={s.id}>{m.id}</code><span className={s.provider}>{m.provider}</span></> : <span className={s.none}>none</span>;

export default function ModelsPage() {
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="mind" sample={false} title={PAGE.title} lede={PAGE.lede} />
        <Section title={PAGE.tableTitle}>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr><th scope="col">Part</th><th scope="col">What it does</th><th scope="col">Default model</th><th scope="col">Backup</th></tr>
              </thead>
              <tbody>
                {PARTS.map((p) => {
                  const r = byPart.get(p.part);
                  return r && (
                    <tr key={p.part}>
                      <th scope="row">{p.name}</th>
                      <td className={s.job}>{p.job}</td>
                      <td><Cell m={r.model} /></td>
                      <td><Cell m={r.backup} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className={s.source}>{PAGE.source}</p>
        </Section>
      </div>
    </Shell>
  );
}
