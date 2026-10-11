import type { Metadata } from "next";
import { getEpochs } from "../_data/source";
import type { Epoch } from "../_data/types";
import { IconNext } from "../_ui/icons";
import { Shell } from "../_ui/Shell";
import { cap, PageHead, Section, ui } from "../_ui/ui";
import s from "./evolution.module.css";

export const metadata: Metadata = {
  title: "Evolution · DNA",
  description: "DNA's lineage from GENESIS: every epoch a branch point, every proposal a branch, rejected and rolled-back branches kept as dead tips.",
};

type Outcome = Epoch["branches"][number]["outcome"];
const OUTCOME: Record<Outcome, string> = { active: "active", rejected: "rejected", rolled_back: "rolled back" };
const blk = (n: number) => n.toLocaleString("en-US");

export default async function EvolutionPage() {
  const epochs = await getEpochs();
  const branches = epochs.flatMap((e) => e.branches);
  const dead = branches.filter((b) => b.outcome !== "active").length;
  const rollbacks = epochs.reduce((n, e) => n + e.rollbacks, 0);

  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="streak"
          title="Evolution"
          lede="The family tree of every change DNA has tried, dead ends included."
          detail="Each epoch is a branch point and each proposal a branch. Dead ends stay on the tree; live modules reach the right edge."
        />
        <Section title="The tree" note={`${branches.length} branches · ${dead} dead tips · block ${blk(epochs.at(-1)?.block ?? 0)}`}>
          {epochs.length > 0 ? <Tree epochs={epochs} /> : <p className={`${ui.prose} ${ui.muted}`}>No epochs recorded yet.</p>}
        </Section>
        <Section title="Chapter by chapter" note={`${epochs.length} epochs · ${rollbacks} rollback${rollbacks === 1 ? "" : "s"}`}>
          <ol className={s.history}>
            {epochs.map((e, i) => {
              const current = i === epochs.length - 1;
              return (
                <li key={e.n} className={s.epoch} data-current={current || undefined}>
                  <Cell t={epochs.length > 1 ? i / (epochs.length - 1) : 1} current={current} />
                  <h3 className={s.epochName}>{cap(e.name)}</h3>
                  <div className={ui.source}>block {blk(e.block)}{current && " · current"}</div>
                  <dl className={s.fields}>
                    <div><dt>Before</dt><dd>{e.before}</dd></div>
                    <div><dt>After</dt><dd>{e.after}</dd></div>
                    <div><dt>Changed</dt><dd>{e.changed}</dd></div>
                    <div><dt>Rollbacks</dt><dd className={s.num} data-bad={e.rollbacks > 0 || undefined}>{e.rollbacks}</dd></div>
                    <div>
                      <dt>Autonomy delta</dt>
                      <dd className={s.num}>
                        {e.autonomy[0]}/10<IconNext className={s.to} /><span className="sr-only"> to </span>{e.autonomy[1]}/10
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ol>
        </Section>
      </div>
    </Shell>
  );
}

/**
 * Horizontal cladogram. Every branch gets its own row so labels never collide. Rows above the trunk run
 * earliest-epoch outermost, rows below mirror that, so no two lineages ever cross.
 */
function Tree({ epochs }: { epochs: Epoch[] }) {
  // COL fits the widest dead-tip label: DEAD + 18 (cross) + 20 chars × 6.7px + 24 gap = 280, so labels never reach the next epoch
  const ROW = 30, COL = 280, X0 = 64, TOP = 64, BEND = 64, DEAD = 104, MAXCH = 20;
  const clip = (t: string) => (t.length > MAXCH ? `${t.slice(0, MAXCH - 1)}…` : t);
  let k = 0; // alternate sides across the whole tree so it stays balanced
  const leaves = epochs.flatMap((e, i) => e.branches.map((b) => ({ ...b, i, up: k++ % 2 === 0 })));
  const above = leaves.filter((l) => l.up);
  const below = leaves.filter((l) => !l.up).reverse();
  const trunkY = TOP + above.length * ROW;
  const rowY = new Map([...above.map((l, j) => [l.id, TOP + j * ROW] as const), ...below.map((l, j) => [l.id, trunkY + (j + 1) * ROW] as const)]);
  const xe = (i: number) => X0 + i * COL;
  const last = epochs.length - 1;
  const XEND = xe(last) + COL;
  const W = XEND + 180, H = trunkY + (below.length + 1) * ROW + 4;

  return (
    <>
      <div className={s.scroller} role="region" aria-label="Lineage tree, scrolls horizontally" tabIndex={0}>
        <svg className={s.tree} viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
          {epochs.map((e, i) => (
            <g key={e.n} className={s.guide}>
              <text className={i === last ? s.epochLabelNow : s.epochLabel} x={xe(i)} y={18} textAnchor="middle">{cap(e.name)}</text>
              <text className={s.blk} x={xe(i)} y={33} textAnchor="middle">blk {blk(e.block)}</text>
              <line className={s.guideLine} x1={xe(i)} x2={xe(i)} y1={44} y2={H - 6} />
            </g>
          ))}
          <path className={s.trunk} d={`M${X0} ${trunkY}H${xe(last)}`} />
          {leaves.map((l) => {
            const x = xe(l.i), y = rowY.get(l.id)!, alive = l.outcome === "active";
            const end = alive ? XEND : x + DEAD;
            const d = `M${x} ${trunkY}C${x + BEND * 0.55} ${trunkY} ${x + BEND * 0.45} ${y} ${x + BEND} ${y}H${end}`;
            return (
              <g key={l.id}>
                <path className={alive ? s.live : s.dead} d={d} />
                {alive ? (
                  <>
                    <circle className={s.tip} cx={end} cy={y} r={5} />
                    <circle className={s.tipCore} cx={end} cy={y} r={1.8} />
                  </>
                ) : (
                  <path className={s.cross} d={`M${end + 2} ${y - 4}l8 8m0 -8l-8 8`} />
                )}
                {alive ? (
                  <text className={s.leaf} x={end + 14} y={y + 4}>
                    {l.label}<tspan className={s.leafLive} dx={8}>{OUTCOME[l.outcome]}</tspan>
                  </text>
                ) : (
                  // dead tips stack name over outcome so the label stays inside its epoch column
                  <text className={s.leaf} x={end + 18} y={y - 1}>
                    {clip(l.label)}<tspan className={s.leafDead} x={end + 18} dy={11}>{OUTCOME[l.outcome]}</tspan>
                  </text>
                )}
              </g>
            );
          })}
          {epochs.map((e, i) => (
            <circle key={e.n} className={i === last ? s.nodeNow : s.node} cx={xe(i)} cy={trunkY} r={i === 0 ? 7 : 5} />
          ))}
        </svg>
      </div>
      <p className={s.hint} aria-hidden>Scroll the tree<IconNext /></p>
      <ol className="sr-only">
        {epochs.map((e) => (
          <li key={e.n}>
            {e.name}, block {blk(e.block)}:
            <ul>{e.branches.map((b) => <li key={b.id}>{b.label}: {OUTCOME[b.outcome]}</li>)}</ul>
          </li>
        ))}
      </ol>
    </>
  );
}

/**
 * Cell silhouette for an epoch: a Cassini oval whose b/a ratio falls as t goes 0 → 1,
 * so the contour reads single (≈ circle) → pinched (dividing) → two separate cells.
 */
function Cell({ t, current }: { t: number; current: boolean }) {
  const ratio = 0.95 + 1.25 * (1 - t) ** 2; // 2.2 at genesis, 0.95 (two loops) at the latest epoch
  const loops = cassini(ratio);
  const pts = loops.flat();
  const fit = Math.min(54 / Math.max(...pts.map((p) => Math.abs(p[0]))), 30 / Math.max(...pts.map((p) => Math.abs(p[1]))));
  // inner contour: each loop shrinks toward its own centre, so two daughter cells each keep a nested membrane
  const toPath = (scale: number) =>
    loops.map((loop) => {
      const cx = loop.reduce((a, p) => a + p[0], 0) / loop.length;
      return loop.map(([px, py], j) => `${j ? "L" : "M"}${(60 + (cx + (px - cx) * scale) * fit).toFixed(2)} ${(36 + py * fit * scale).toFixed(2)}`).join("") + "Z";
    }).join("");
  const nuclei = ratio < 1.2 ? [-1, 1] : [0]; // the foci of the oval, where the nuclei sit once division starts
  return (
    <svg className={s.cell} data-current={current || undefined} viewBox="0 0 120 72" aria-hidden>
      <path className={s.membrane} d={toPath(1)} />
      <path className={s.inner} d={toPath(0.72)} />
      {nuclei.map((n) => <circle key={n} className={s.nucleus} cx={60 + n * fit} cy={36} r={1.8} />)}
    </svg>
  );
}

/** Points of the Cassini oval (x²+y²)² − 2(x²−y²) = b⁴ − 1, with a = 1 and b = ratio. One loop if ratio > 1, two if < 1. */
function cassini(ratio: number): [number, number][][] {
  const b4 = ratio ** 4, N = 120;
  const pt = (th: number, sign: 1 | -1): [number, number] => {
    const r = Math.sqrt(Math.max(0, Math.cos(2 * th) + sign * Math.sqrt(Math.max(0, b4 - Math.sin(2 * th) ** 2))));
    return [r * Math.cos(th), r * Math.sin(th)];
  };
  if (ratio > 1) return [Array.from({ length: N }, (_, i) => pt((i / N) * 2 * Math.PI, 1))];
  const tm = 0.5 * Math.asin(ratio ** 2); // the loops exist only where sin²2θ ≤ b⁴
  const outer = Array.from({ length: N / 2 + 1 }, (_, i) => pt(-tm + (2 * tm * i) / (N / 2), 1));
  const inner = Array.from({ length: N / 2 + 1 }, (_, i) => pt(tm - (2 * tm * i) / (N / 2), -1));
  const right = [...outer, ...inner];
  return [right, right.map(([x, y]) => [-x, y] as [number, number])];
}
