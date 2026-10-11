import type { Metadata } from "next";
import type { SecurityItem } from "../_data/types";
import { getSecurity } from "../_data/source";
import { Shell } from "../_ui/Shell";
import { Chip, fmtDate, PageHead, Section, ui } from "../_ui/ui";
import s from "./security.module.css";

export const metadata: Metadata = {
  title: "Security · DNA",
  description: "DNA's security log: red-team findings, rollbacks, Safe overrides and standing disclosures, each with severity and status.",
};

const GROUPS: { kind: SecurityItem["kind"]; title: string; noun: string }[] = [
  { kind: "red-team", title: "Red-team findings", noun: "finding" },
  { kind: "rollback", title: "Rollbacks", noun: "rollback" },
  { kind: "guardian", title: "Safe overrides", noun: "override" },
  { kind: "disclosure", title: "Disclosures", noun: "disclosure" },
];

export default async function SecurityPage() {
  const items = await getSecurity();
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="security"
          title="Security"
          lede="What went wrong, what the Safe stopped, what the red team found attacking the system on purpose, and the known limits."
        />
        {GROUPS.map((g) => {
          // open first, then newest first
          const list = items.filter((i) => i.kind === g.kind)
            .sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || b.date.localeCompare(a.date));
          const open = list.filter((i) => i.status === "open").length;
          return (
            <Section key={g.kind} title={g.title} note={`${list.length} ${g.noun}${list.length === 1 ? "" : "s"}${open ? ` · ${open} open` : ""}`}>
              {list.length === 0 ? <p className={`${ui.prose} ${ui.muted}`}>None recorded.</p> : (
                <ol className={s.list}>
                  {list.map((i) => (
                    <li key={i.id} className={s.item}>
                      <div className={s.ref}>
                        <span className={ui.strong}>{i.id}</span>
                        <time dateTime={i.date}>{fmtDate(i.date)}</time>
                      </div>
                      <div>
                        <h3 className={s.h3}>{i.title}</h3>
                        <p className={`${ui.prose} ${ui.muted} ${s.detail}`}>{i.detail}</p>
                        {i.ref && <p className={s.source}>{i.ref}</p>}
                      </div>
                      <div className={s.chips}>
                        <Chip value={i.severity} label={`severity ${i.severity}`} />
                        <Chip value={i.status} />
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          );
        })}
      </div>
    </Shell>
  );
}
