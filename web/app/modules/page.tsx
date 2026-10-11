import type { Metadata } from "next";
import Link from "next/link";
import { getEpochs, getModules } from "../_data/source";
import type { Module, ModuleStatus } from "../_data/types";
import { IconNext, IconX } from "../_ui/icons";
import { Shell } from "../_ui/Shell";
import { cap, Chip, PageHead, Section, Stat, short, ui } from "../_ui/ui";
import { CopyHash } from "./CopyHash";
import css from "./modules.module.css";

export const metadata: Metadata = {
  title: "Modules · DNA",
  description: "The Uniswap v4 hook modules DNA can swap in: every version, its lifecycle stage, code hash, risk, kill conditions and parameter bounds.",
};

// ModuleRegistry lifecycle (SPEC §3); the note says who or what moves a module into the stage. No retired stage: a
// displaced or ended module returns to Proposed (plate reuse); only rollback is terminal.
const STAGES: { status: ModuleStatus; note: string }[] = [
  { status: "proposed", note: "Registered, code hash (its fingerprint) pinned. Displaced or ended plates (copies of a module with their own settings) return here and rotate again." },
  { status: "shadow", note: "Called on ~1 in 10 swaps. Would-be fee logged, never charged." },
  { status: "canary", note: "Charged for real, but only in pre-committed block windows and within a bounded change. EndCanary stops it at once." },
  { status: "active", note: "Promoted after the 1 h timelock: by the Safe, or the agent from level 8." },
];

const block = (n: number) => n.toLocaleString("en-US");

/** Where a param value sits inside its bounds (0–1), or null when the bounds don't parse. */
function position(value: string, bounds: string) {
  const [lo, hi] = bounds.startsWith("≤") ? [0, parseFloat(bounds.slice(1))] : bounds.split("–").map(parseFloat);
  const p = (parseFloat(value) - lo) / (hi - lo);
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : null;
}

function ModuleLink({ m, selected }: { m: Module; selected: boolean }) {
  return (
    <Link className={css.modLink} href={`/modules?m=${m.id}`} scroll={false} aria-current={selected ? "true" : undefined}>
      {m.name} <span className={ui.dim}>{m.version}</span>
    </Link>
  );
}

export default async function ModulesPage({ searchParams }: PageProps<"/modules">) {
  const [modules, epochs, { m: param }] = await Promise.all([getModules(), getEpochs(), searchParams]);
  const selected = modules.find((m) => m.id === param) ?? modules[0];
  const epoch = epochs.at(-1); // undefined before genesis
  const registered = modules.filter((m) => m.registeredBlock > 0);
  const lastBlock = registered.reduce((n, m) => Math.max(n, m.registeredBlock), 0);
  const failed = modules.filter((m) => m.status === "rejected" || m.status === "rolled_back");
  // epoch rollbacks not already listed as a failed module (LIVE derives both from the same chain events)
  const listed = new Set(failed.map((m) => `${m.name} ${m.version}`));
  const rollbacks = epochs.flatMap((e) => e.branches.filter((b) => b.outcome === "rolled_back" && !listed.has(b.label)).map((b) => ({ ...b, epoch: e.name })));

  // store catalog: DNA's own modules, one row per module name, versions newest first
  const byName = new Map<string, Module[]>();
  for (const m of modules) if (m.author === "DNA") byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
  const own = [...byName.values()].map((vs) =>
    vs.toSorted((a, b) => b.version.localeCompare(a.version, "en", { numeric: true })), // v10 > v9; plates C · B · A
  );

  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="modules"
          title="Modules"
          lede="The swappable contracts that set DNA's fee, how far each one has got in testing, and what would stop it."
          detail="The permanent DNA hook (the contract attached to the Uniswap v4 pool) asks FeePolicy modules what fee to charge and SplitPolicy modules where the fees go. Modules can be swapped; the hook and its hard limits cannot. Every version is listed here, including the ones that failed."
        />

        <Section title="At a glance" note={registered.length ? `last registration · block ${block(lastBlock)}` : "none registered"}>
          <div className={css.stats}>
            <Stat label="Active modules" value={modules.filter((m) => m.status === "active").length} source="registry snapshot" />
            <Stat label="Current epoch" value={epoch ? String(epoch.n).padStart(2, "0") : "—"} source={epoch ? `epoch record · block ${block(epoch.block)}` : "no epoch yet"} />
            <Stat label="Registry versions" value={registered.length} source="registered on-chain" />
            <Stat label="Rollbacks" value={epochs.reduce((n, e) => n + e.rollbacks, 0)} source="epoch record" />
          </div>
        </Section>

        <Section title="How far each one got" note="promotions wait the 1 h timelock · rollback + endCanary are immediate">
          <ol className={css.pipeline}>
            {STAGES.map((st, i) => {
              const here = modules.filter((m) => m.status === st.status);
              return (
                <li key={st.status} className={css.stage} data-filled={here.length > 0 || undefined}>
                  <div className={css.stageHead}>
                    <h3 className={css.stageName}>{st.status[0].toUpperCase() + st.status.slice(1)}</h3>
                    <span className={ui.dim}>{here.length}</span>
                    {i < STAGES.length - 1 && <IconNext className={css.arrow} />}
                  </div>
                  <p className={css.stageNote}>{st.note}</p>
                  {here.length > 0 ? (
                    <ul className={css.stageList}>
                      {here.map((m) => <li key={m.id}><ModuleLink m={m} selected={m === selected} /></li>)}
                    </ul>
                  ) : (
                    <p className={css.empty}>none</p>
                  )}
                </li>
              );
            })}
          </ol>
          <div className={css.lane}>
            <h3 className={css.stageName}>Rejected or rolled back</h3>
            <ul className={css.laneList}>
              {failed.map((m) => (
                <li key={m.id}>
                  <IconX className={css.x} />
                  <ModuleLink m={m} selected={m === selected} />
                  <Chip value={m.status} />
                  <span className={css.laneNote}>{m.summary}</span>
                </li>
              ))}
              {rollbacks.map((b) => (
                <li key={b.id}>
                  <IconX className={css.x} />
                  <span className={ui.strong}>{b.label}</span>
                  <Chip value="rolled_back" />
                  <span className={css.laneNote}>Canary rolled back to the active version in {cap(b.epoch)}; terminal until a fresh Safe register. Source: epoch record.</span>
                </li>
              ))}
            </ul>
          </div>
        </Section>

        <Section title="Every version" note={`${modules.length} versions · select a row to inspect`}>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${css.registry}`}>
              <thead>
                <tr>
                  <th scope="col">Module</th><th scope="col">Version</th><th scope="col">Kind</th><th scope="col">Code hash</th>
                  <th scope="col">Status</th><th scope="col">Canary share</th><th scope="col">Risk</th>
                  <th scope="col">Kill conditions</th><th scope="col">Params · bounds</th>
                </tr>
              </thead>
              <tbody>
                {modules.map((m) => (
                  <tr key={m.id} data-selected={m === selected || undefined}>
                    <th scope="row" className={ui.nowrap}><ModuleLink m={m} selected={m === selected} /></th>
                    <td>{m.version}</td>
                    <td>{m.kind}</td>
                    <td className={ui.nowrap}><CopyHash value={m.codeHash} display={short(m.codeHash)} label={`${m.name} ${m.version} code hash`} /></td>
                    <td><Chip value={m.status} /></td>
                    <td className={ui.nowrap}>{m.status === "canary" ? `${m.canaryShare}%` : <span className={ui.dim}>n/a</span>}</td>
                    <td><Chip value={m.risk} /></td>
                    <td className={css.wide}>
                      {m.killConditions.length ? <ul className={css.plain}>{m.killConditions.map((k) => <li key={k}>{k}</li>)}</ul> : <span className={ui.dim}>none</span>}
                    </td>
                    <td className={css.wide}>
                      {m.params.length ? (
                        <ul className={css.plain}>
                          {m.params.map((p) => <li key={p.key}>{p.key} <span className={ui.strong}>{p.value}</span> <span className={ui.dim}>[{p.bounds}]</span></li>)}
                        </ul>
                      ) : <span className={ui.dim}>none</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {selected && <Section title="Selected module" note={<Link className={ui.link} href={`/modules?m=${selected.id}`} scroll={false}>permalink</Link>}>
          <div className={css.detail}>
            <div>
              <h3 className={css.detailTitle}>{selected.name} <span className={ui.dim}>{selected.version}</span></h3>
              <div className={css.chips}><Chip value={selected.status} /><Chip value={selected.risk} label={`${selected.risk} risk`} /><span className={ui.dim}>{selected.kind}</span></div>
              <p className={`${ui.prose} ${ui.muted}`}>{selected.summary}</p>
              <dl className={css.facts}>
                <dt>Address</dt><dd><CopyHash value={selected.address} display={short(selected.address)} label="module address" /></dd>
                <dt>Code hash</dt><dd><CopyHash value={selected.codeHash} display={short(selected.codeHash)} label="code hash" /></dd>
                <dt>Author</dt><dd>{selected.author} <span className={ui.dim}>· review {selected.review}</span></dd>
                <dt>Registered</dt><dd>{selected.registeredBlock ? `block ${block(selected.registeredBlock)}` : <span className={ui.dim}>never registered</span>}</dd>
              </dl>
            </div>
            <div>
              <h4 className={css.subhead}>Parameters within bounds</h4>
              {selected.params.length ? (
                <ul className={css.params}>
                  {selected.params.map((p) => {
                    const pos = position(p.value, p.bounds);
                    return (
                      <li key={p.key}>
                        <span>{p.key}</span>
                        <span className={ui.strong}>{p.value}</span>
                        <span className={ui.dim}>{p.bounds}</span>
                        {pos !== null && (
                          <svg className={css.bound} viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden>
                            <line x1="0" y1="5" x2="100" y2="5" className={css.track} vectorEffect="non-scaling-stroke" />
                            <line x1={pos * 100} y1="0" x2={pos * 100} y2="10" className={css.marker} vectorEffect="non-scaling-stroke" />
                          </svg>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : <p className={css.empty}>No parameters on record.</p>}
              <h4 className={css.subhead}>Kill conditions · rolled back when</h4>
              {selected.killConditions.length ? (
                <ul className={css.kills}>{selected.killConditions.map((k) => <li key={k}>{k}</li>)}</ul>
              ) : <p className={css.empty}>None declared. This version is not running.</p>}
            </div>
          </div>
        </Section>}

        <Section title="Module store" note="read-only · submissions closed">
          <div className={css.store}>
            <div className={css.storeCopy}>
              <p className={ui.prose}>
                {modules.some((m) => m.status === "active")
                  ? <>{modules.filter((m) => m.status === "active").map((m) => m.name).join(" and ")} {modules.filter((m) => m.status === "active").length === 1 ? "runs" : "run"} now.</>
                  : <>No module runs yet: the hook&apos;s built-in fee and the 35/35/30/0 split apply until the AI promotes one.</>}{" "}
                AdaptiveFee, ParamSplit, DirectionalFee and SizeTierFee are built and tested. New modules come from the Sequencer and need
                the Safe&apos;s signature on their code.
              </p>
              <p className={`${ui.prose} ${ui.muted}`}>
                Outside modules aren&apos;t accepted yet; module work is paid through <Link className={ui.link} href="/bounties">bounties</Link>.
              </p>
            </div>
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${css.registry}`}>
                <thead>
                  <tr><th scope="col">Module</th><th scope="col">Kind</th><th scope="col">Versions</th><th scope="col">Latest</th></tr>
                </thead>
                <tbody>
                  {own.map((vs) => (
                    <tr key={vs[0].name}>
                      <th scope="row" className={ui.nowrap}>{vs[0].name}</th>
                      <td>{vs[0].kind}</td>
                      <td className={ui.nowrap}>{vs.map((v) => v.version).join(" · ")}</td>
                      <td className={`${ui.prose} ${css.wide}`}>{vs[0].summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Section>
      </div>
    </Shell>
  );
}
