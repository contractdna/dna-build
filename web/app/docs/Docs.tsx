"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef } from "react";
import { FeeBreakdown, PageHead, ui } from "../_ui/ui";
import { CHAPTERS, type Chapter, MODE_LABEL, MODES, type Mode, PAGE, parseMode, STORAGE_KEY } from "./content";
import s from "./docs.module.css";

// The mode lives in the URL (?mode=dumb|smart, shareable) and in localStorage. The buttons are GET-form submits, so
// they work without JS; with JS they switch in place through the History API (Next keeps useSearchParams in sync).
const readSaved = () => { try { return parseMode(localStorage.getItem(STORAGE_KEY)); } catch { return null; } };
const save = (m: Mode) => { try { localStorage.setItem(STORAGE_KEY, m); } catch { /* private mode: URL still works */ } };

/** The chapter at the top of the screen (under the sticky bar), so a mode switch can keep the reader in place. */
function chapterInView() {
  let id: string | null = null;
  for (const c of CHAPTERS) {
    const el = document.getElementById(c.id);
    if (el && el.getBoundingClientRect().top <= 160) id = c.id;
  }
  return id;
}

export function Docs() {
  const mode = parseMode(useSearchParams().get("mode"));
  const keep = useRef<string | null>(null);

  // no mode in the URL: restore the saved one (first load only, so Back can still reach the chooser)
  useEffect(() => {
    if (mode) return;
    const saved = readSaved();
    if (!saved) return;
    keep.current = location.hash.slice(1) || null;
    history.replaceState(null, "", `?mode=${saved}${location.hash}`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount only

  useLayoutEffect(() => {
    const id = keep.current;
    keep.current = null;
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [mode]);

  const pick = (m: Mode) => (e: React.MouseEvent) => {
    e.preventDefault();
    save(m);
    if (m === mode) return;
    keep.current = mode ? chapterInView() : location.hash.slice(1) || "chapters"; // from the chooser: jump to the content
    // from the chooser: a new history entry (Back returns to it); between modes: replace, so Back leaves the page
    history[mode ? "replaceState" : "pushState"](null, "", `?mode=${m}${location.hash}`);
  };

  if (!mode) {
    return (
      <PageHead hero="journal" back={null} sample={false} title={PAGE.title} lede={PAGE.lede}
        aside={
          <form className={s.chooser} action="/docs" method="get" aria-label={PAGE.chooserLabel}>
            {MODES.map((m) => (
              <button key={m} className={s.big} type="submit" name="mode" value={m} onClick={pick(m)}>
                <span className={s.bigLabel}>{MODE_LABEL[m].button}</span>
                <span className={s.bigHint}>{MODE_LABEL[m].hint}</span>
              </button>
            ))}
          </form>
        } />
    );
  }

  return (
    <>
      <PageHead hero="journal" back={null} sample={false} title={PAGE.title} lede={PAGE.lede} />
      <div className={s.bar}>
        <form className={s.toggle} action="/docs" method="get" aria-label={PAGE.toggleLabel}>
          {MODES.map((m) => (
            <button key={m} type="submit" name="mode" value={m} aria-pressed={m === mode} onClick={pick(m)}>{MODE_LABEL[m].button}</button>
          ))}
        </form>
      </div>

      <nav id="chapters" className={s.toc} aria-label={PAGE.chaptersLabel}>
        <ol>
          {CHAPTERS.map((c, i) => <li key={c.id}><a href={`#${c.id}`}><span className={s.num}>{num(i)}</span>{c.title}</a></li>)}
        </ol>
      </nav>

      {CHAPTERS.map((c, i) => (
        <section key={c.id} id={c.id} className={s.chapter} aria-labelledby={`${c.id}-h`} data-risk={c.id === "risks" || undefined}>
          <h2 id={`${c.id}-h`} className={s.h2}><span className={s.num}>{num(i)}</span>{c.title}</h2>
          {mode === "dumb" ? <Dumb c={c} /> : <Smart c={c} />}
          {c.id === "fees" && <FeeBreakdown className={s.fee} />}
        </section>
      ))}
    </>
  );
}

const num = (i: number) => String(i + 1).padStart(2, "0");

const Dumb = ({ c }: { c: Chapter }) => <div className={s.dumb}>{c.dumb.map((l) => <p key={l}>{l}</p>)}</div>;


function Smart({ c }: { c: Chapter }) {
  const x = c.smart;
  return (
    <div className={s.smart}>
      <p className={s.lead}>{x.lead}</p>
      {x.formula && <pre className={s.formula}>{x.formula.join("\n")}</pre>}
      {x.flow && (
        <figure className={s.flow}>
          <ol className={s.steps}>{x.flow.steps.map((t) => <li key={t}>{t}</li>)}</ol>
          <ul className={s.branches}>{x.flow.branches.map((b) => <li key={b.when}><span>{b.when}</span>{b.then}</li>)}</ul>
        </figure>
      )}
      <dl className={s.facts}>
        {x.facts.map((f) => (
          <div key={f.k}>
            <dt>{f.k}</dt>
            <dd>{f.v}{f.at && <code>{f.at}</code>}</dd>
          </div>
        ))}
      </dl>
      {x.notes?.map((n) => <p key={n} className={`${ui.prose} ${ui.muted}`}>{n}</p>)}
      <p className={s.links}>
        <span>{PAGE.sourceLabel}</span>
        {x.links.map((l) => !l.href
          ? <span key={l.label} className={s.file}>{l.label}</span>
          : l.href.startsWith("/")
            ? <Link key={l.href} className={ui.link} href={l.href}>{l.label}</Link>
            : <a key={l.href} className={ui.link} href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a>)}
        {x.links.some((l) => !l.href) && <em className={s.pending}>{PAGE.sourcePending}</em>}
      </p>
    </div>
  );
}
