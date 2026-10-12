"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  BEATS, BRAIN, EDGES, GATE, HEIGHT, LANES, NODES, RULES, TONES, TRACKS,
  info, labelAt, rounded, type EdgeId, type NodeId, type Tone, type Track,
} from "./graph";
import { LIVE } from "../_data/flags";
import { useLive } from "../_live/LiveProvider";
import { STATE } from "../_live/plain";
import { label, latest, type Line } from "./now";
import s from "./sequencer.module.css";

const BEAT_MS = 5200;
const DOTS = Math.max(...BEATS.map((b) => b.edges.length)); // one pooled dot per edge of the busiest beat
const tone = (t: Tone) => ({ "--c": `var(--${t})` }) as CSSProperties;
const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** True while `ref` is on screen and the tab is visible: timers and frames stop otherwise. */
function useOnScreen(ref: RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let seen = false;
    const update = () => setOn(seen && !document.hidden);
    const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; update(); });
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => { io.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, [ref]);
  return on;
}

/** The page's interactive part: controls, the board (wide screens), the stepper (phones), the legend. */
export function Sequencer({ head }: { head: ReactNode }) {
  const [money, setMoney] = useState(true);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);
  const [epoch, setEpoch] = useState(0); // Replay and the Money switch restart both stories

  // LIVE: the real feed. Shown only from a real snapshot over an open stream; otherwise the map stands alone, silently.
  const { core, stale, streaming } = useLive();
  const real = LIVE && streaming && !stale && core.log.every((l) => typeof l.id === "string"); // sample lines have number ids
  const [log, setLog] = useState(core.log);
  const [kept, setKept] = useState(() => latest([], core.log));
  if (log !== core.log) { setLog(core.log); setKept(latest(kept, core.log)); }
  // a new on-chain event lights its box on the map for a few seconds (what was there on load is not news)
  const newest = kept.at(-1);
  const shown = useRef(newest?.id);
  const [flash, setFlash] = useState<NodeId | null>(null);
  useEffect(() => {
    if (!newest || newest.id === shown.current) return;
    shown.current = newest.id; // seen even while hidden, so a line that arrived during a gap never flashes late
    if (!real) return;
    const node = label(newest.text).node;
    if (!node) return;
    setFlash(node);
    const t = setTimeout(() => setFlash(null), 6000);
    return () => { clearTimeout(t); setFlash(null); };
  }, [real, newest?.id]); // by id: a core snapshot re-sends the same line as a new object

  useEffect(() => {
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setStill(true);
    setPaused(true); // no auto-advance: the first beat stays until the reader moves on
  }, []);

  return (
    <div className={s.root}>
      <header className={s.top}>
        {head}
        <div className={s.controls}>
          <button type="button" className={cx(s.btn, s.switch)} aria-pressed={money}
            onClick={() => { setMoney(!money); setEpoch(epoch + 1); }}><i aria-hidden />Money</button>
          <button type="button" className={s.btn} onClick={() => setPaused(!paused)}>
            {paused
              ? <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden><path d="M4 2.5v9l7.5-4.5z" /></svg>
              : <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden><rect x="3" y="2" width="3" height="10" rx="1" /><rect x="8" y="2" width="3" height="10" rx="1" /></svg>}
            {paused ? "Play" : "Pause"}
          </button>
          <button type="button" className={s.btn} onClick={() => { if (!still) setPaused(false); setEpoch(epoch + 1); }}>
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden><path d="M2.5 7a4.5 4.5 0 1 0 1.3-3.2" /><path d="M2.5 1.8v2.4h2.4" /></svg>
            Replay
          </button>
          <span className={s.demo}><span>Animated map · live activity on <Link className={s.demoLink} href="/live">/live</Link></span></span>
        </div>
      </header>

      {real && <RightNow state={core.state} block={core.block} lines={kept} />}

      <Board money={money} paused={paused} still={still} epoch={epoch} flash={flash} />
      <Phone money={money} paused={paused} still={still} epoch={epoch} />

      <ul className={s.legend} aria-label="Colour key">
        <li style={tone("ai")}><i />Brain and fee loop</li>
        <li style={tone("idea")}><i />Ideas</li>
        <li style={tone("dev")}><i />Sequencer</li>
        <li style={tone("game")}><i />Games</li>
        <li style={tone("guard")}><i />Public hour and Safe</li>
        {money && <li style={tone("money")}><i />Money</li>}
      </ul>
    </div>
  );
}

/** The engine's state and its newest on-chain events, newest first. */
function RightNow({ state, block, lines }: { state: keyof typeof STATE; block: number; lines: Line[] }) {
  return (
    <section className={s.live} aria-label="Right now">
      <p className={s.liveHead}>
        <b>Right now · live</b><span>{STATE[state].now}</span>
        <small>{block > 0 && `block ${block.toLocaleString("en-US")} · `}times in UTC</small>
      </p>
      {lines.length > 0 && (
        <ol className={s.liveList}>
          {lines.toReversed().map((l) => <li key={l.id}><time>{l.time}</time><span>{label(l.text).text}</span></li>)}
        </ol>
      )}
    </section>
  );
}

type Props = { money: boolean; paused: boolean; still: boolean; epoch: number };

function Board({ money, paused, still, epoch, flash }: Props & { flash: NodeId | null }) {
  const root = useRef<HTMLElement>(null);
  const active = useOnScreen(root);
  const beats = money ? BEATS : BEATS.filter((b) => !b.money);
  const [bi, setBi] = useState(0);
  const [seen, setSeen] = useState(epoch);
  const [open, setOpen] = useState<NodeId | null>(null);
  if (seen !== epoch) { setSeen(epoch); setBi(0); setOpen(null); } // a hidden money node never stays in the panel
  const beat = beats[bi % beats.length];
  const opener = useRef<HTMLElement | SVGElement | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const show = (id: NodeId) => { opener.current = document.activeElement as HTMLElement | SVGElement | null; setOpen(id); };
  const hide = () => { setOpen(null); opener.current?.focus(); opener.current = null; };
  useEffect(() => { if (open) closeBtn.current?.focus(); }, [open]);
  const paths = useRef<Partial<Record<EdgeId, SVGPathElement>>>({});
  const dots = useRef<(SVGGElement | null)[]>([]);

  // auto-advance, only while playing and on screen
  useEffect(() => {
    if (paused || !active) return;
    const t = setTimeout(() => setBi((i) => (i + 1) % beats.length), BEAT_MS);
    return () => clearTimeout(t);
  }, [bi, paused, active, beats.length, epoch]);

  // travelling dots: a fixed pool, moved by transform; one frame loop that ends with the last dot
  useEffect(() => {
    const pool = dots.current;
    const hide = () => pool.forEach((d) => d?.setAttribute("visibility", "hidden"));
    hide();
    if (still || !active) return;
    const start = performance.now();
    const runs = beat.edges.flatMap((id, i) => {
      const p = paths.current[id];
      if (!p) return [];
      const len = p.getTotalLength();
      return [{ p, len, t0: start + i * 480, dur: 700 + len * 1.4, dot: pool[i], tone: EDGES[id].tone }];
    });
    for (const r of runs) r.dot?.style.setProperty("--c", `var(--${r.tone})`);
    let raf = requestAnimationFrame(function frame(now) {
      let live = false;
      for (const r of runs) {
        const k = (now - r.t0) / r.dur;
        if (k > 1) { r.dot?.setAttribute("visibility", "hidden"); continue; }
        live = true;
        if (k < 0 || !r.dot) continue;
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        const pt = r.p.getPointAtLength(e * r.len);
        r.dot.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
        r.dot.setAttribute("visibility", "visible");
      }
      raf = live ? requestAnimationFrame(frame) : 0;
    });
    return () => { cancelAnimationFrame(raf); hide(); };
  }, [beat, still, active]);

  const litE = new Set<string>(beat.edges), litN = new Set<string>(beat.nodes);
  const lit = (id: NodeId) => id === flash || litN.has(id) || (id === "brain" && !!beat.brain) || (id === "gate" && !!beat.gate);
  const press = (id: NodeId) => ({
    role: "button", tabIndex: 0, "aria-controls": "sq-panel", "aria-expanded": open === id,
    onClick: () => show(id),
    onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(id); } },
  });
  const edges = Object.entries(EDGES).filter(([, e]) => money || !("money" in e));
  const panel = open ? info(open) : undefined;

  return (
    <section ref={root} className={s.board} data-active={active || undefined} aria-label="Engine map"
      onKeyDown={(e) => { if (e.key === "Escape" && open) hide(); }}>
      <svg className={s.map} viewBox={`0 0 1440 ${money ? HEIGHT.money : HEIGHT.plain}`} role="group"
        aria-label="Map of the DNA engine. Select a box for details.">
        <defs>
          {[...TONES, "dim"].map((t) => (
            <marker key={t} id={`sq-a-${t}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0.5 L7.5,4 L0,7.5 Z" className={s.arrow} style={t === "dim" ? undefined : tone(t as Tone)} />
            </marker>
          ))}
        </defs>

        {RULES.filter((r) => money || !r.money).map((r) => <line key={r.y} x1="20" x2="1420" y1={r.y} y2={r.y} className={s.rule} />)}

        <g>
          {edges.map(([id, e]) => {
            const on = litE.has(id);
            return (
              <path key={id} ref={(el) => { if (el) paths.current[id as EdgeId] = el; else delete paths.current[id as EdgeId]; }}
                d={rounded(e.p)} className={cx(s.edge, "dash" in e && s.dash, on ? s.on : s.dim)} style={tone(e.tone)}
                markerEnd={"bus" in e ? undefined : `url(#sq-a-${on ? e.tone : "dim"})`} />
            );
          })}
        </g>

        <g>
          <g className={cx(s.n, s.brain, !lit("brain") && s.dim, lit("brain") && s.on)} style={tone("ai")} aria-label="Brain" {...press("brain")}>
            <rect className={s.box} x={BRAIN.x} y={BRAIN.y} width={BRAIN.w} height={BRAIN.h} rx="12" />
            <circle cx="68" cy="160" r="6" className={s.fillC} />
            <circle cx="68" cy="160" r="6" className={s.pulse} />
            <text x="88" y="157" className={s.brainName}>Brain</text>
            <text x="88" y="177" className={s.brainSub}>Fable by default · decides what to build, ship and retire · signs every decision</text>
          </g>

          <g className={cx(s.n, s.gate, !lit("gate") && s.dim, flash === "gate" && s.flash)} aria-label="Public hour, 1 hour, the Safe can veto" {...press("gate")}>
            <rect className={s.box} x={GATE.x} y={GATE.y} width={GATE.w} height={GATE.h} rx="10" />
            <circle cx={GATE.x + 20} cy={GATE.y + 22} r="8" />
            <path d={`M${GATE.x + 20},${GATE.y + 17} V${GATE.y + 22} L${GATE.x + 24},${GATE.y + 25}`} strokeLinecap="round" />
            <text x={GATE.x + 24} y={GATE.y + 236} transform={`rotate(-90 ${GATE.x + 24} ${GATE.y + 236})`} textAnchor="middle">PUBLIC HOUR · 1 H · SAFE CAN VETO</text>
          </g>

          {Object.entries(NODES).filter(([, n]) => money || !("money" in n)).map(([id, n]) => {
            const on = lit(id as NodeId), chip = "chip" in n ? n.chip : undefined;
            const cw = chip ? chip.length * 6.6 + 12 : 0;
            return (
              <g key={id} className={cx(s.n, !on && s.dim, on && s.on, flash === id && s.flash)} style={tone(n.tone)}
                aria-label={chip ? `${n.label}, ${chip.toLowerCase()}` : n.label} {...press(id as NodeId)}>
                <rect className={s.box} x={n.x} y={n.y - 19} width={n.w} height="38" rx="10" />
                <circle cx={n.x + 14} cy={n.y} r="3.2" className={s.fillC} />
                <text x={n.x + 25} y={n.y + 4.6} className={s.label}>{n.label}</text>
                {chip && <>
                  <rect x={n.x + n.w - cw - 8} y={n.y - 8} width={cw} height="16" rx="8" className={s.chipBg} />
                  <text x={n.x + n.w - cw / 2 - 8} y={n.y + 3.6} textAnchor="middle" className={s.chip}>{chip}</text>
                </>}
              </g>
            );
          })}
        </g>

        <g aria-hidden>
          {edges.filter(([, e]) => "label" in e).map(([id, e]) => {
            const [x, y] = labelAt(e), text = (e as { label: string }).label, w = text.length * 5.9 + 10;
            return (
              <g key={id} className={cx(s.edgeLabel, !litE.has(id) && s.dim)}>
                <rect x={x - w / 2} y={y - 8} width={w} height="15" rx="4" />
                <text x={x} y={y + 3.5} textAnchor="middle">{text}</text>
              </g>
            );
          })}
          {LANES.filter((l) => money || !l.money).map((l) => (
            <g key={l.title} className={s.lane}>
              <text x={l.x ?? 40} y={l.y} className={s.laneTitle}>{l.title}</text>
              {l.sub && <text x={l.x ?? 40} y={l.y + 16} className={s.laneSub}>{l.sub}</text>}
            </g>
          ))}
          {Array.from({ length: DOTS }, (_, i) => (
            <g key={i} ref={(el) => { dots.current[i] = el; }} visibility="hidden" className={s.dot}>
              <circle r="7" className={s.halo} /><circle r="2.8" className={s.core} />
            </g>
          ))}
        </g>
      </svg>

      <aside id="sq-panel" className={cx(s.panel, panel && s.open)} aria-live="polite" inert={!panel}>
        {panel && <>
          <button ref={closeBtn} type="button" className={s.close} onClick={hide}>Close</button>
          <h3 style={tone(panel.tone)}><i aria-hidden />{panel.label}</h3>
          <p>{panel.text}</p>
          {!LIVE /* mock mode only: the "now" lines are illustrations, live activity is the Right now strip */ && <div className={s.now}><em>LATEST · DEMO</em><span>{panel.now}</span></div>}
        </>}
      </aside>

      <div className={s.story}>
        <div className={s.beats}>
          {beats.map((b, i) => (
            <button key={b.title} type="button" aria-label={`Step ${i + 1}: ${b.title}`} aria-current={i === bi ? "step" : undefined}
              data-done={i <= bi || undefined} onClick={() => { setBi(i); setOpen(null); }}><span /></button>
          ))}
        </div>
        <div className={s.cap} aria-live={paused ? "polite" : "off"}><b>{beat.title}</b><span>{beat.text}</span></div>
        <span className={s.demo}>Step {bi + 1} of {beats.length}{LIVE ? "" : " · demo"}</span>
      </div>
    </section>
  );
}

const LOOP = <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden><path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2" /><path d="M11.5 1.8v2.4H9.1" /></svg>;

function Phone({ money, paused, still, epoch }: Props) {
  const root = useRef<HTMLElement>(null);
  const active = useOnScreen(root);
  const tracks = money ? TRACKS : TRACKS.filter((t) => !t.money);
  const [name, setName] = useState<Track["name"]>("Build");
  const track = tracks.find((t) => t.name === name) ?? tracks[0];
  const n = track.steps.length;
  const [pi, setPi] = useState(0);
  const [seen, setSeen] = useState(epoch);
  if (seen !== epoch) { setSeen(epoch); setPi(0); }
  const at = still ? n - 1 : pi % n; // reduced motion: the whole track at once
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (paused || !active) return;
    const t = setTimeout(() => setPi((i) => (i + 1 >= n ? 0 : i + 1)), pi + 1 >= n ? 3200 : 1100);
    return () => clearTimeout(t);
  }, [pi, n, paused, active, epoch]);

  const pick = (k: number) => { setName(tracks[k].name); setPi(0); tabs.current[k]?.focus(); };
  const arrows = (e: KeyboardEvent) => {
    const k = tracks.indexOf(track), d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d) { e.preventDefault(); pick((k + d + tracks.length) % tracks.length); }
  };

  return (
    <section ref={root} className={s.phone} aria-label="Engine map, step by step">
      <div className={s.brainbar}><i aria-hidden /><div><b>Brain</b><span>Fable by default. Decides what to build, ship and retire. Signs each decision.</span></div></div>
      <div className={s.tabs} role="tablist" aria-label="Tracks" onKeyDown={arrows}>
        {tracks.map((t, k) => (
          <button key={t.name} ref={(el) => { tabs.current[k] = el; }} type="button" role="tab" id={`sq-tab-${k}`} aria-controls="sq-steps"
            aria-selected={t === track} tabIndex={t === track ? 0 : -1} onClick={() => pick(k)}>{t.name}</button>
        ))}
      </div>
      <div id="sq-steps" role="tabpanel" aria-labelledby={`sq-tab-${tracks.indexOf(track)}`}><ol className={s.steps}>
        {track.steps.map((st, j) => (
          <li key={j} className={j > at ? s.off : undefined}>
            {st.kind === "node" && (() => {
              const node = NODES[st.id];
              return <div className={s.node} style={tone(node.tone)}><i aria-hidden /><span>{st.label ?? node.label}</span>{st.note && <small>{st.note}</small>}</div>;
            })()}
            {st.kind === "gate" && <div className={s.gateRow}><span>Public hour · 1 h</span><small>{st.note}</small></div>}
            {st.kind === "loop" && <div className={s.loop}>{LOOP}<span>{st.label}</span></div>}
          </li>
        ))}
      </ol></div>
      <div className={s.pcap}><b>{track.caption}</b><span>Step {at + 1} of {n}{LIVE ? "" : " · demo"}</span></div>
    </section>
  );
}
