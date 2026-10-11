import type { Metadata } from "next";
import Link from "next/link";
import { getJournal } from "../_data/source";
import { IconNext } from "../_ui/icons";
import { Shell } from "../_ui/Shell";
import { fmtDate, PageHead, Section, ui } from "../_ui/ui";
import s from "./journal.module.css";

export const metadata: Metadata = {
  title: "Journal · DNA",
  description: "DNA's daily reports: ideas received, what was simulated and rejected, what it learned and what it will test next.",
};

export default async function JournalPage() {
  const { entries: all } = await getJournal();
  const entries = all.toSorted((a, b) => b.day - a.day);
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="journal"
          title="Journal"
          lede="A short report from the AI every day: what came in, what it tried, and what it learned."
        />
        <Section title="Daily reports" note={`${entries.length} days · newest first`}>
          {entries.length === 0 && <p className={`${ui.prose} ${ui.muted}`}>No report yet today. The AI writes one at the end of each UTC day.</p>}
          <ol className={s.list}>
            {entries.map((e) => (
              <li key={e.day} className={s.row}>
                <div className={s.when}>
                  <span className={s.code}>Day {e.day}</span>
                  <time dateTime={e.date} className={ui.dim}>{fmtDate(e.date)}</time>
                </div>
                <div className={s.main}>
                  <h3 className={s.h3}>
                    <Link href={`/journal/${e.day}`} className={s.open}><span className="sr-only">Day {e.day}: </span>{e.summary}<IconNext className={s.go} /></Link>
                  </h3>
                  <p className={s.learned}><span className={ui.dim}>Learned:</span> {e.learned}</p>
                </div>
                <dl className={s.stats}>
                  {e.stats.map((x) => <div key={x.label}><dt>{x.label}</dt><dd>{x.value}</dd></div>)}
                </dl>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </Shell>
  );
}
