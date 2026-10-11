"use client";

import Link from "next/link";
import { LIVE } from "../_data/flags";
import { FEE, FEE_LINE, LAUNCH_FEE, pct } from "../_data/launchFee";
import type { Experiment, MemoryEntry, Thread } from "../_data/types";
import { useLive } from "../_live/LiveProvider";
import { sentence, STATE } from "../_live/plain";
import { Chip, PageHead, PlatformChip, Section, ui } from "../_ui/ui";
import s from "./live.module.css";

export type Fee = { module: string; params: { key: string; value: string }[] } | null;

/** The essence of the four proof pages, built on the server from the same getters (page.tsx). */
export type Proof = {
  thread: null | { id: string; title: string; status: Thread["status"]; idea?: string; against?: string; forN: number; againstN: number; confidence: number | null; next?: string };
  bench: { experiments: Pick<Experiment, "id" | "module" | "status" | "metrics">[] };
  lessons: { entries: { id: number; title: string; decision: MemoryEntry["decision"]; lesson: string }[] };
  limits: { id: string; value: string; rule: string }[];
};

/** A bead colour per kind of event: what it means, not decoration. */
const bead = (t: string) =>
  /reject|rolled back|rollback|stopped|ended|vetoed|paused/i.test(t) ? "var(--rose)"
  : /\btest|canary|candidate/i.test(t) ? "var(--violet)"
  : /simulat|replay/i.test(t) ? "var(--lilac)"
  : /\bbot\b|MEV/i.test(t) ? "var(--amber)"
  : /fee|buyback|burn|liquidity|distribut/i.test(t) ? "var(--coral)"
  : "var(--teal)";

const signed = (d: number, unit: "%" | "bps") => `${d < 0 ? "−" : "+"}${Number(Math.abs(d).toFixed(2))}${unit === "%" ? "%" : " bps"}`;
const SEGMENTS = 20;
/** The engine stores the task cut at 200 characters: end a cut one on the last whole word, with an ellipsis. */
const whole = (t: string) => (t.length < 200 ? t : `${t.slice(0, t.lastIndexOf(" ") > 0 ? t.lastIndexOf(" ") : t.length).replace(/[\s"'“”‘’,;:.\-–—]+$/u, "")}…`);

/** /live: the shared live core (LiveProvider) in plain words. Mock mode is labelled a demo and shows no on-chain numbers. */
export function LiveView({ fee, baseline, proof }: { fee: Fee; baseline: number | null; proof: Proof }) {
  const { core, stale } = useLive();
  const st = STATE[core.state];
  const lines = core.log.toReversed();
  const { thread, bench, lessons, limits } = proof;

  return (
    <>
      <PageHead hero="live"
        back={null}
        sample={false}
        title="Live"
        lede="What the AI is doing right now, in plain words."
        detail={LIVE
          ? "Read from the chain and the AI's public log as it happens. Every claim links to its evidence in the Lab."
          : "DNA hasn't launched. This page plays a simulated loop so you can see how it will work. None of it is real trading data."}
        aside={LIVE
          ? <span className={ui.status} role={stale ? "status" : undefined}>{stale ? "Data delayed: the indexer is behind." : "Live from the chain."}</span>
          : <span className={ui.status}><span className={ui.demo}>[Demo]</span> Simulated until launch.</span>}
      />

      <div className={s.now}>
        <article className={s.card} aria-live="polite">
          <div className={`${ui.label} ${s.nowLabel}`}>The AI</div>
          <p className={s.big}><span className={s.pulse} aria-hidden />{st.now}</p>
          <p className={s.text}>{st.detail}</p>
        </article>

        <article className={s.card}>
          <div className={ui.label}>{LIVE ? "DNA's fee now" : "DNA's fee at launch"}</div>
          {LIVE && fee ? (
            <>
              <p className={s.fee}>{fee.module}</p>
              <dl className={s.params}>{fee.params.map((p) => <div key={p.key}><dt>{p.key}</dt><dd>{p.value}</dd></div>)}</dl>
              <PlatformChip />
              <p className={s.text}>Set by the active fee module, inside its range. After the launch tax (blocks 0 to 8), DNA&apos;s fee can never go above {FEE.cap}.</p>
            </>
          ) : (
            <>
              <p className={s.figure}>{baseline != null ? pct(baseline) : `${FEE.oursLaunch} → ${FEE.ours}`}</p>
              <PlatformChip />
              <p className={s.text}>
                {baseline == null
                  ? `A trade pays ${FEE_LINE}.`
                  : baseline > LAUNCH_FEE.baseline
                    ? `No fee module is active: the launch fee applies. A trade pays ${FEE_LINE}.`
                    : `No fee module is active, so the built-in baseline applies: a trade pays ${FEE.ours} + ${FEE.platform} = ${FEE.total}.`}{" "}
                After the launch tax (blocks 0 to 8), DNA&apos;s fee can never go above {FEE.cap}.
              </p>
            </>
          )}
          {core.state === "canary" && <p className={`${ui.status} ${s.running}`}>A test fee is running on 1 in 6 blocks, never more than 1 point from the current fee.</p>}
        </article>

        <article className={s.card}>
          <div className={ui.label}>Current task</div>
          {core.task
            ? <p className={s.quote}>&ldquo;{whole(core.task)}&rdquo;</p>
            : <p className={s.text}>Between cycles: the next task shows here when the engine starts it.</p>}
          {core.goal && <p className={s.text}><span className={ui.dim}>Today&apos;s goal:</span> {core.goal}</p>}
        </article>
      </div>

      <Section title="What it just did" note={LIVE ? `block ${core.block.toLocaleString("en-US")}` : "simulated"}>
        <ol className={s.feed}>
          {lines.map((l) => (
            <li key={l.id} style={{ "--c": bead(l.text) } as React.CSSProperties}><time className={s.time}>{l.time}</time><span className={s.say}>{sentence(l.text)}</span></li>
          ))}
        </ol>
      </Section>

      {/* the four proof pages, their essence inline; each panel links to its full page */}
      <Section title="Check the proof" note={LIVE ? "from the AI's signed log and the contracts" : "sample data · pre-launch"}>
        <div className={s.proof}>
          <article className={s.panel} style={{ "--c": "var(--violet)" } as React.CSSProperties} aria-labelledby="p-why">
            <header className={s.panelHead}>
              <h3 id="p-why" className={s.panelTitle}>Its reasoning</h3>
              <Link className={s.full} href="/mind">Full page<span aria-hidden> →</span></Link>
            </header>
            {!thread ? <p className={s.text}>No reasoning thread open right now.</p> : <>
            <p className={s.question}>{thread.title}</p>
            <dl className={s.reason}>
              {thread.idea && <div><dt>The idea</dt><dd>{thread.idea}</dd></div>}
              {thread.against && <div><dt>Against it</dt><dd>{thread.against}</dd></div>}
              {thread.next && <div><dt>{thread.status === "decided" ? "Decided" : "Next"}</dt><dd>{thread.next}</dd></div>}
            </dl>
            <div className={s.panelFoot}>
              <Chip value={thread.status} label={`${thread.forN} for · ${thread.againstN} against`} />
              {thread.confidence != null && (
                <span className={s.conf}>
                  <span>{thread.confidence}% sure</span>
                  <span className={s.meter} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={thread.confidence} aria-label="Model self-assessed confidence">
                    {Array.from({ length: SEGMENTS }, (_, k) => <i key={k} data-on={k < Math.round((thread.confidence! / 100) * SEGMENTS) || undefined} />)}
                  </span>
                </span>
              )}
            </div>
            </>}
          </article>

          <article className={s.panel} style={{ "--c": "var(--lilac)" } as React.CSSProperties} aria-labelledby="p-bench">
            <header className={s.panelHead}>
              <h3 id="p-bench" className={s.panelTitle}>The test bench</h3>
              <Link className={s.full} href="/lab/experiments">Full page<span aria-hidden> →</span></Link>
            </header>
            {bench.experiments.length === 0 ? <p className={s.text}>Nothing on the bench right now.</p> : (
              <ul className={s.rows}>
                {bench.experiments.map((e) => (
                  <li key={e.id}>
                    <span className={s.rowMain}><span className={ui.strong}>{e.module}</span><Chip value={e.status} /></span>
                    <span className={s.rowSub}>{e.metrics.map((m) => <span key={m.name}>{m.name} <b data-neg={m.delta < 0 || undefined}>{signed(m.delta, m.unit)}</b></span>)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className={s.panelNote}>Scores against the current fee, from replays and shadow runs.</p>
          </article>

          <article className={s.panel} style={{ "--c": "var(--teal)" } as React.CSSProperties} aria-labelledby="p-learned">
            <header className={s.panelHead}>
              <h3 id="p-learned" className={s.panelTitle}>Last lessons</h3>
              <Link className={s.full} href="/memory">Full page<span aria-hidden> →</span></Link>
            </header>
            {lessons.entries.length === 0 ? <p className={s.text}>No lesson yet: one is written when a test thread closes. Rejected candidates are on <Link className={ui.link} href="/lab/experiments">Experiments</Link>.</p> : (
              <ul className={s.rows}>
                {lessons.entries.map((e) => (
                  <li key={e.id}>
                    <span className={s.rowMain}><span className={ui.strong}>{e.title}</span><Chip value={e.decision} label={e.decision === "accepted" ? "kept" : e.decision === "rejected" ? "killed" : "rolled back"} /></span>
                    <span className={s.rowSub}>{e.lesson}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className={s.panel} style={{ "--c": "var(--rose)" } as React.CSSProperties} aria-labelledby="p-limits">
            <header className={s.panelHead}>
              <h3 id="p-limits" className={s.panelTitle}>Hard limits</h3>
              <Link className={s.full} href="/constitution">Full page<span aria-hidden> →</span></Link>
            </header>
            <dl className={s.limits}>
              {limits.map((r) => <div key={r.id}><dt>{r.value}</dt><dd>{r.rule}</dd></div>)}
            </dl>
            <p className={s.panelNote}>Written into immutable contracts. Neither the AI nor the team can change them.</p>
          </article>
        </div>
      </Section>
    </>
  );
}
