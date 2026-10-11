import type { Metadata } from "next";
import Link from "next/link";
import { LIVE } from "../../_data/flags";
import { getLab } from "../../_data/source";
import type { Experiment } from "../../_data/types";
import { IconNext } from "../../_ui/icons";
import { Shell } from "../../_ui/Shell";
import { Chip, PageHead, Section, ui } from "../../_ui/ui";
import s from "./experiments.module.css";

export const metadata: Metadata = {
  title: "Experiments · Lab · DNA",
  description: "DNA's experiment bench: candidate fee settings under test, their shadow and canary status, simulated metric deltas, and the pipeline every change must pass.",
};

const signed = (d: number, unit: "%" | "bps") => `${d < 0 ? "−" : "+"}${Number(Math.abs(d).toFixed(2))}${unit === "%" ? "%" : " bps"}`;

// Per-bench cell: soft union of two unequal lobes (d = lobe offset; larger d = closer to splitting), slight organic wobble.
const CELL: Record<Experiment["bench"], { d: number; rot: number; ph: number }> = {
  1: { d: 0.66, rot: -32, ph: 0.4 },
  2: { d: 0.72, rot: -24, ph: 2.1 },
  3: { d: 0.8, rot: -40, ph: 4.3 },
};
// distance from the origin to a circle of radius R centred at (cx, 0), along angle t (origin inside the circle)
const ray = (t: number, cx: number, R: number) => cx * Math.cos(t) + Math.sqrt(R * R - (cx * Math.sin(t)) ** 2);
function cellPath(bench: Experiment["bench"], scale: number) {
  const { d, rot, ph } = CELL[bench];
  const r0 = (rot * Math.PI) / 180, pts: string[] = [];
  for (let i = 0; i < 120; i++) {
    const t = (i / 120) * Math.PI * 2;
    const union = (ray(t, d, 1) ** 6 + ray(t, -d * 0.9, 0.9) ** 6) ** (1 / 6);
    const r = union * (1 + 0.02 * Math.sin(3 * t + ph) + 0.01 * Math.sin(7 * t + ph * 2));
    pts.push(`${(130 + scale * r * Math.cos(t + r0)).toFixed(1)},${(130 + scale * r * Math.sin(t + r0)).toFixed(1)}`);
  }
  return `M${pts.join("L")}Z`;
}
const VESICLES: Record<Experiment["bench"], [number, number, number][]> = {
  1: [[104, 138, 5], [150, 112, 3.5], [121, 158, 2.5], [168, 131, 2], [90, 120, 2]],
  2: [[112, 128, 4], [156, 120, 5], [138, 150, 2.5], [96, 142, 2]],
  3: [[108, 142, 3], [152, 118, 4], [132, 130, 2], [92, 150, 2.5], [170, 108, 2]],
};
const TICKS = Array.from({ length: 11 }, (_, i) => 70 + i * 12);

function Dish({ bench, live, rejected }: { bench: Experiment["bench"]; live: boolean; rejected: boolean }) {
  return (
    <svg className={s.dish} viewBox="0 0 260 260" aria-hidden data-live={live || undefined} data-rejected={rejected || undefined}>
      {/* registration marks */}
      <g className={s.faint}>{[[22, 238], [238, 22], [238, 238]].map(([x, y]) => <path key={`${x}${y}`} d={`M${x - 5} ${y}h10M${x} ${y - 5}v10`} />)}</g>
      {/* scale bar */}
      <g className={s.faint}>
        <path d="M10 70V190" />{TICKS.map((y, i) => <path key={y} d={`M10 ${y}h${i % 5 ? 4 : 7}`} />)}
        <text x="10" y="62">100 µm</text><text x="10" y="202">0 µm</text>
      </g>
      {/* bench label + leader */}
      <text className={s.letter} x="20" y="30">{bench}</text>
      <path className={s.leader} d="M34 25h14l12 14" />
      {/* rims */}
      <circle className={s.rim} cx="130" cy="130" r="108" />
      <circle className={s.rim2} cx="130" cy="130" r="102" />
      <circle className={s.faint} cx="130" cy="130" r="96" />
      {/* reticle */}
      <g className={s.reticle}>
        <path d="M130 30v26M130 204v26M30 130h26M204 130h26M124 130h12M130 124v12" />
        {[38, 44, 50, 210, 216, 222].map((v) => <path key={v} d={`M127 ${v}h6M${v} 127v6`} />)}
      </g>
      {/* cell */}
      <path className={s.cellFill} d={cellPath(bench, 46)} />
      <path className={s.cell} d={cellPath(bench, 46)} />
      <path className={s.membrane} d={cellPath(bench, 40)} />
      <path className={s.faint} d={cellPath(bench, 33)} />
      <g className={s.vesicles}>{VESICLES[bench].map(([x, y, r]) => <circle key={`${x}${y}`} cx={x} cy={y} r={r} />)}</g>
      {rejected && <path className={s.strike} d="M70 70L190 190M190 70L70 190" />}
    </svg>
  );
}

export default async function LabPage() {
  const { experiments, pipeline } = await getLab();
  const current = pipeline.find((p) => p.current)?.stage;

  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="mystery"
          title="Experiments"
          lede="The fee ideas on the test bench right now, and how each one did against the current fee."
          detail="Each candidate is replayed on past swaps, run in shadow (worked out, never charged) and attacked by a red team. Only then may it charge real trades in a live test, within 1 point of the current fee. Rejected ones stay here with the reason."
        />
        <Section title="On the bench" note={`${experiments.length} benches · ${LIVE ? "uncalibrated simulation (replay + assumed elasticity)" : "illustrative simulation data"}`}>
          {experiments.length === 0 && <p className={`${ui.prose} ${ui.muted}`}>Nothing on the bench right now. A candidate lands here when the AI simulates it.</p>}
          <div className={s.plate}>
            {experiments.map((e) => {
              const live = e.status === "shadow" || e.status === "canary_queued" || e.status === "canary"; // canary_queued still runs in shadow
              const rejected = e.status === "rejected";
              return (
                <article key={e.id} className={s.cellCol} aria-labelledby={`bench-${e.bench}`} data-live={live || undefined} data-rejected={rejected || undefined}>
                  <Dish bench={e.bench} live={live} rejected={rejected} />
                  <div className={s.head}>
                    <h3 id={`bench-${e.bench}`} className={s.module}><span className="sr-only">Bench {e.bench}: </span>{e.module}</h3>
                    <span className={ui.source}>{e.sim}</span>
                  </div>
                  <div className={s.status}><Chip value={e.status} /><span className={ui.dim}>{e.id}</span></div>
                  <dl className={s.metrics}>
                    {e.metrics.map((m) => (
                      <div key={m.name}><dt>{m.name}</dt><dd>{signed(m.delta, m.unit)}</dd></div>
                    ))}
                  </dl>
                  <p className={s.note}>{e.note}</p>
                </article>
              );
            })}
          </div>
        </Section>
        <Section title="The path every change takes" note={current ? `current stage · ${current.replace("-", " ")}` : undefined}>
          <ol className={s.pipe}>
            {pipeline.map((p, i) => (
              <li key={p.stage} aria-current={p.current ? "step" : undefined}>
                <span className={s.stage}>{p.stage[0].toUpperCase() + p.stage.slice(1).replace("-", " ")}</span>
                {i < pipeline.length - 1 && <IconNext className={s.arrow} />}
              </li>
            ))}
          </ol>
          <p className={`${ui.prose} ${ui.muted} ${s.pipeNote}`}>
            A module only moves right. Any kill condition sends it to rollback, and every outcome, kept or reverted, is written to <Link className={ui.link} href="/memory">memory</Link>.
          </p>
        </Section>
      </div>
    </Shell>
  );
}
