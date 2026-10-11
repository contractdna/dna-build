import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getJournal } from "../../_data/source";
import { IconNext } from "../../_ui/icons";
import { Shell } from "../../_ui/Shell";
import { fmtDate, PageHead, Section, Stat, ui } from "../../_ui/ui";
import s from "../journal.module.css";

// Every day renders on request (LIVE: from the engine's journal records; the build has no database). Not
// generateStaticParams: that makes the route static (ISR), and a LIVE render's connection() then fails it with
// DYNAMIC_SERVER_USAGE on `next start` (next dev hides it). Unknown days: notFound() below.
export const dynamic = "force-dynamic";

// one sorted lookup for metadata and page; neighbours by index, since days may skip
async function find(day: string) {
  const { entries } = await getJournal();
  const all = entries.toSorted((a, b) => a.day - b.day);
  const i = all.findIndex((e) => String(e.day) === day);
  return i < 0 ? undefined : { e: all[i], prev: all[i - 1], next: all[i + 1] };
}

export async function generateMetadata({ params }: PageProps<"/journal/[day]">): Promise<Metadata> {
  const e = (await find((await params).day))?.e;
  if (!e) return { title: "Journal · DNA" };
  return { title: `Day ${e.day} · ${fmtDate(e.date)} · Journal · DNA`, description: e.summary };
}

export default async function JournalDayPage({ params }: PageProps<"/journal/[day]">) {
  const found = await find((await params).day);
  if (!found) notFound();
  const { e, prev, next } = found;

  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="journal"
          back={{ href: "/journal", label: "Journal" }}
          title={`Day ${e.day}`}
          lede={e.summary}
          aside={<time dateTime={e.date} className={s.code}>{fmtDate(e.date)}</time>}
        />
        <Section title="The day in numbers" note="engine log">
          <div className={ui.rowStats}>
            {e.stats.map((x) => <Stat key={x.label} label={x.label} value={x.value} />)}
          </div>
        </Section>
        <div className={`${ui.grid2} ${s.pair}`}>
          <Section title="What it learned"><p className={ui.prose}>{e.learned}</p></Section>
          <Section title="What it tries next"><p className={ui.prose}>{e.tomorrow}</p></Section>
        </div>
        <Section title="Autonomy" note="level change over the day (what the AI is allowed to do)">
          <p className={s.autonomy}>{e.autonomy}</p>
        </Section>
        <nav className={s.pager} aria-label="Journal days">
          {prev ? <Link href={`/journal/${prev.day}`} className={s.prev}><IconNext className={s.back} />Day {prev.day}</Link> : <span />}
          <Link href="/journal" className={ui.link}>All reports</Link>
          {next ? <Link href={`/journal/${next.day}`} className={s.next}>Day {next.day}<IconNext /></Link> : <span />}
        </nav>
      </div>
    </Shell>
  );
}
