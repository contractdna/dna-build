import type { Metadata } from "next";
import Link from "next/link";
import { getMemory, getThread } from "../_data/source";
import type { MemoryEntry } from "../_data/types";
import { Shell } from "../_ui/Shell";
import { Chip, fmtDate, PageHead, Section, ui } from "../_ui/ui";
import { MemoryFilter } from "./MemoryFilter";
import s from "./memory.module.css";

export const metadata: Metadata = {
  title: "Memory · DNA",
  description: "DNA's research memory: every accepted, rejected and rolled-back experiment, and the rule each one left for the next.",
};

const DECISIONS = ["accepted", "rejected", "rolled_back"] as const;
const pad = (n: number) => String(n).padStart(4, "0");

/** All whitespace-separated terms must appear somewhere in the entry (case-insensitive). */
function matches(e: MemoryEntry, q: string) {
  const hay = [e.title, e.hypothesis, e.method, e.result, e.futureRule, e.decision.replace("_", " "), `#${e.id}`, `#${pad(e.id)}`,
    ...e.refs.map((r) => `${r.label} ${r.ref}`)].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

/** Greedy word wrap for SVG text (SVG has no line breaking). */
function wrap(text: string, max: number) {
  const lines: string[] = [];
  for (const w of text.split(" ")) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + 1 + w.length <= max) lines[last] += ` ${w}`;
    else lines.push(w);
  }
  return lines;
}

export default async function MemoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 120) : "";
  const d = DECISIONS.find((x) => x === sp.d) ?? "all";
  const [{ entries: all }, thread] = await Promise.all([getMemory(), getThread()]);

  const searched = q ? all.filter((e) => matches(e, q)) : all;
  const shown = d === "all" ? searched : searched.filter((e) => e.decision === d);
  const counts: Record<string, number> = { all: searched.length };
  for (const e of searched) counts[e.decision] = (counts[e.decision] ?? 0) + 1;
  // figure numbers follow the full archive, so "Fig. 2" means the same plate whatever the filter
  const figNo = new Map(all.filter((e) => e.series).map((e, i) => [e.id, i + 1]));
  const next = thread?.steps.find((st) => st.kind === "next");

  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="memory"
          title="Memory"
          lede="Every test the AI has run, kept, rejected or rolled back, and the lesson each one left for the next."
          detail="Nothing is deleted, and each entry hands a rule to the next experiment."
        />
        <div className={s.layout}>
          <Section title="Every test" note={<span aria-live="polite">{shown.length} of {all.length} entries</span>}>
            <MemoryFilter q={q} d={d} counts={counts} />
            {all.length === 0 ? (
              <div className={s.empty}>
                <p className={`${ui.prose} ${ui.muted}`}>No test thread has closed yet. Each one that ends (kept, rejected or rolled back) adds an entry here with its lesson; candidates rejected along the way are on <Link className={ui.link} href="/lab/experiments">Experiments</Link>.</p>
              </div>
            ) : shown.length === 0 ? (
              <div className={s.empty}>
                <p className={`${ui.prose} ${ui.strong}`}>No entries match{q && <> &ldquo;{q}&rdquo;</>}{d !== "all" && <> among {d.replace("_", " ")} decisions</>}.</p>
                <p className={`${ui.prose} ${ui.muted}`}>Memory is append-only; nothing has been removed. <Link className={ui.link} href="/memory">Show all entries</Link></p>
              </div>
            ) : (
              <ol className={s.entries}>
                {shown.map((e) => (
                  <li key={e.id} id={`entry-${e.id}`} className={s.entry}>
                    <article className={s.body} data-fig={e.series ? "" : undefined} aria-labelledby={`entry-${e.id}-title`}>
                      <div>
                        <div className={s.meta}>
                          <span>Entry #{pad(e.id)}</span>
                          <Chip value={e.decision} />
                          <time dateTime={e.date} className={ui.dim}>{fmtDate(e.date)}</time>
                        </div>
                        <h3 id={`entry-${e.id}-title`} className={s.entryTitle}>{e.title}</h3>
                        <dl className={s.fields}>
                          <dt>Hypothesis</dt><dd>{e.hypothesis}</dd>
                          <dt>Method</dt><dd>{e.method}</dd>
                          <dt>Result</dt><dd>{e.result}</dd>
                        </dl>
                        {e.futureRule && (
                          <div className={s.rule}>
                            <div className={s.ruleLabel}>Lesson for next time</div>
                            <p className={s.ruleText}>{e.futureRule}</p>
                          </div>
                        )}
                        <ul className={s.refs} aria-label="References">
                          {e.refs.map((r) => <li key={r.label + r.ref}>{r.label} {r.ref}</li>)}
                        </ul>
                      </div>
                      {e.series && <Figure n={figNo.get(e.id)!} series={e.series} source={e.refs[0] && `${e.refs[0].label} ${e.refs[0].ref}`} />}
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </Section>
          <Section title="How lessons add up" note="entry · lesson · next experiment" className={s.rail}>
            <RuleGraph entries={all} next={next?.text ?? "Awaiting the next hypothesis."} source={thread ? `thread ${thread.id}` : "no open thread"} />
          </Section>
        </div>
      </div>
    </Shell>
  );
}

/** Figure plate: candidate vs baseline, authored SVG. */
function Figure({ n, series, source }: { n: number; series: NonNullable<MemoryEntry["series"]>; source?: string }) {
  const W = 320, H = 160, L = 30, R = 8, T = 10, B = 14;
  const { candidate: c, baseline: b } = series;
  const lo = Math.min(...c, ...b), hi = Math.max(...c, ...b);
  const x = (i: number, len: number) => L + (i * (W - L - R)) / Math.max(1, len - 1);
  const y = (v: number) => H - B - ((v - lo) / (hi - lo || 1)) * (H - T - B);
  const path = (v: number[]) => v.map((p, i) => `${i ? "L" : "M"}${x(i, v.length).toFixed(1)} ${y(p).toFixed(1)}`).join("");
  const range = (v: number[]) => `from ${Math.min(...v)} to ${Math.max(...v)}, ending at ${v[v.length - 1]}`;
  const label = `Fig. ${n}: candidate versus baseline over ${c.length} samples. Candidate ranges ${range(c)}. Baseline ranges ${range(b)}.`;
  return (
    <figure className={s.fig}>
      <svg className={s.figSvg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {[0, 1, 2, 3, 4].map((k) => <line key={`h${k}`} className={s.grid} x1={L} x2={W - R} y1={T + (k * (H - T - B)) / 4} y2={T + (k * (H - T - B)) / 4} />)}
        {c.map((_, i) => i % 2 === 0 && <line key={`v${i}`} className={s.grid} x1={x(i, c.length)} x2={x(i, c.length)} y1={T} y2={H - B} />)}
        <text className={s.tick} x={L - 6} y={T + 3} textAnchor="end">{hi}</text>
        <text className={s.tick} x={L - 6} y={H - B + 3} textAnchor="end">{lo}</text>
        <path className={s.baseline} d={path(b)} />
        <path className={s.candidate} d={path(c)} />
      </svg>
      <figcaption className={s.figcap}>
        <span className={s.figNo}>Fig. {n}</span>
        <span className={s.key}><span className={s.keyC} />candidate</span>
        <span className={s.key}><span className={s.keyB} />baseline</span>
        {source && <span className={ui.dim}>{source}</span>}
      </figcaption>
    </figure>
  );
}

/** Rule graph: each entry leaves a future rule; every rule feeds the next experiment. */
function RuleGraph({ entries, next, source }: { entries: MemoryEntry[]; next: string; source: string }) {
  const W = 360, IDW = 74, RX = 96, RW = 212, BUS = 336, LH = 14, GAP = 12;
  let y = 1;
  const rows = entries.filter((e) => e.futureRule).map((e) => {
    const lines = wrap(e.futureRule!, 29);
    const row = { e, lines, y, h: Math.max(40, lines.length * LH + 16) };
    y += row.h + GAP;
    return row;
  });
  const nextLines = wrap(next, 38);
  const ny = y + 18, nh = nextLines.length * LH + 40, H = ny + nh + 1;
  const mid = (r: (typeof rows)[number]) => r.y + r.h / 2;
  const arrow = (ax: number, ay: number, dir: "r" | "d") =>
    dir === "r" ? `M${ax - 5} ${ay - 4}L${ax} ${ay}L${ax - 5} ${ay + 4}` : `M${ax - 4} ${ay - 5}L${ax} ${ay}L${ax + 4} ${ay - 5}`;

  return (
    <>
      <p className="sr-only">Rule graph: each of the {rows.length} memory entries leaves a future rule, and every rule feeds the next experiment: {next}</p>
      <svg className={s.graph} viewBox={`0 0 ${W} ${H}`} aria-hidden>
        {rows.length > 0 && <path className={s.edge} d={`M${BUS} ${mid(rows[0])}V${ny - 1}`} />}
        <path className={s.edge} d={arrow(BUS, ny - 1, "d")} />
        {rows.map((r) => {
          const failed = r.e.decision !== "accepted";
          return (
            <g key={r.e.id}>
              <rect className={s.node} data-failed={failed || undefined} x={0.5} y={r.y + 0.5} width={IDW} height={r.h - 1} />
              <text className={s.nodeId} x={10} y={mid(r) - 3}>#{pad(r.e.id)}</text>
              <text className={s.nodeTag} x={10} y={mid(r) + 10}>{r.e.decision.replace("_", " ")}</text>
              <path className={s.edge} d={`M${IDW + 1} ${mid(r)}H${RX - 2}`} />
              <path className={s.edge} d={arrow(RX - 2, mid(r), "r")} />
              <rect className={s.node} x={RX + 0.5} y={r.y + 0.5} width={RW} height={r.h - 1} />
              {r.lines.map((ln, k) => <text key={k} className={s.ruleLine} x={RX + 10} y={mid(r) + (k - (r.lines.length - 1) / 2) * LH + 4}>{ln}</text>)}
              <path className={s.edge} d={`M${RX + RW + 1} ${mid(r)}H${BUS}`} />
            </g>
          );
        })}
        <rect className={s.nextNode} x={RX + 0.5} y={ny + 0.5} width={W - RX - 1} height={nh - 1} />
        <text className={s.nextLabel} x={RX + 12} y={ny + 20}>Next experiment</text>
        {nextLines.map((ln, k) => <text key={k} className={s.ruleLine} x={RX + 12} y={ny + 38 + k * LH}>{ln}</text>)}
      </svg>
      <div className={ui.source}>{source}</div>
    </>
  );
}
