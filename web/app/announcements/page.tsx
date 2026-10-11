import type { Metadata } from "next";
import Link from "next/link";
import { getAnnouncements } from "../_data/source";
import { IconExternal } from "../_ui/icons";
import { Shell } from "../_ui/Shell";
import { PageHead, ui } from "../_ui/ui";
import s from "./news.module.css";

export const metadata: Metadata = {
  title: "News · DNA",
  description: "Every result as it happens: jackpot winners, idea rewards, votes, mysteries, idea rounds and experiments, each with its transaction.",
};

// The engine writes one record per event the moment it sees it (engine/src/announce.ts); X gets at most 15 posts a day,
// money first, and a daily digest of the rest. This page has all of them.
const KIND: Record<number, string> = { 1: "money", 2: "vote / mystery", 3: "test", 4: "update" };
const stamp = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

/** News as a terminal: the section's helix field in the head, then a feed of monospace rows on a near-solid panel. */
export default async function AnnouncementsPage() {
  const { entries } = await getAnnouncements();
  const counts = [1, 2, 3, 4].map((k) => [KIND[k], entries.filter((a) => (KIND[a.priority] ?? "update") === KIND[k]).length] as const);
  return (
    <Shell mainClass={s.main}>
      <div className={`${ui.page} ${s.page}`}>
        <PageHead
          hero="news"
          back={null}
          title="News"
          lede="Every result, the moment it happens: who won, what passed, what was killed, and the transaction behind each."
          detail="X gets at most 15 posts a day, money first. This page gets everything."
        />

        <section className={s.term} aria-labelledby="feed-title">
          <header className={s.bar}>
            <h2 id="feed-title" className={s.cmd}><span className="sr-only">Announcements</span><span aria-hidden><span className={s.host}>dna@news</span>:~$ tail -f announcements</span></h2>
            <span className={s.meta}>{entries.length} events · newest first</span>
          </header>
          <p className={s.stats}>
            {counts.map(([k, n]) => <span key={k}><b>{n}</b> {k}</span>)}
          </p>
          {entries.length === 0 ? (
            <p className={s.empty}>› nothing announced yet. A line appears here the moment the AI does something on-chain.</p>
          ) : (
            <ol className={s.feed} aria-label="Announcements, newest first">
              {entries.map((a) => {
                const k = KIND[a.priority] ?? "update";
                return (
                  <li key={a.key} className={s.row}>
                    <span className={s.prompt} aria-hidden>›</span>
                    <time className={s.time} dateTime={a.at}>{stamp(a.at)}</time>
                    <span className={s.tag} data-k={a.priority}>{k}</span>
                    <span className={s.what}>{a.title}</span>
                    {(a.tx || a.proof) && (
                      <span className={s.links}>
                        {a.tx && <a href={a.tx} target="_blank" rel="noopener noreferrer">{a.tx.includes("/tx/") ? "tx" : "details"}<IconExternal /></a>}
                        {a.proof && (a.proof.startsWith("/")
                          ? <Link href={a.proof}>proof</Link>
                          : <a href={a.proof} target="_blank" rel="noopener noreferrer">report<IconExternal /></a>)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          <p className={s.wait}><span className={s.prompt} aria-hidden>›</span><span className={s.cursor} aria-hidden />waiting for the next event</p>
        </section>
      </div>
    </Shell>
  );
}
