import type { Metadata } from "next";
import Link from "next/link";
import { getAutonomy, getRules } from "../_data/source";
import type { AutonomyLevel } from "../_data/types";
import { IconCheck, IconX } from "../_ui/icons";
import { Shell } from "../_ui/Shell";
import { cap, Chip, PageHead, Section, Stat, fmtDate, short, ui } from "../_ui/ui";
import css from "./autonomy.module.css";

export const metadata: Metadata = {
  title: "Autonomy · DNA",
  description: "The ten-level autonomy ladder: what DNA may do now, what it must prove to climb, and every time a human stepped in.",
};

// simplification: hand-picked constitution rules that read as "the AI can never…"; the full list lives on /constitution
const NEVER = ["fee-cap", "supply", "timelock", "exits"];
/** What the agent's key can never do at any level: ModuleRegistry + BountyBoard bytecode (SPEC §3, §11). */
/** Not level-gated: BountyBoard lets the unpaused agent propose and recommend at any level (no ETH moves). */
const AGENT_ANY = ["propose + recommend bounties (no ETH moves)"];
const AGENT_NEVER = [
  "set the agent, anchor key or level",
  "pause, unpause itself or lower the level",
  "cancel queued ops",
  "approve or revoke code hashes",
  "register bytecode the Safe did not approve",
  "touch Safe-escrowed bounties or withdraw the allowance",
];

type State = "unlocked" | "current" | "next" | "locked";
const STATE_LABEL: Record<State, string> = { unlocked: "unlocked", current: "current level", next: "next · in progress", locked: "locked" };

/** "91 / 100" → 0.91; null when the progress isn't a fraction. */
function fraction(progress?: string) {
  const [a, b] = (progress ?? "").split("/").map((x) => parseFloat(x.replace(/,/g, "")));
  return b ? Math.min(1, a / b) : null;
}

function Criteria({ level, live }: { level: AutonomyLevel; live: boolean }) {
  return (
    <ul className={css.criteria} data-live={live || undefined}>
      {level.criteria.map((c) => {
        const f = fraction(c.progress);
        return (
          <li key={c.text} data-met={c.met || undefined}>
            {c.met ? <IconCheck className={css.met} /> : <IconX className={css.unmet} />}
            <span className={css.criterion}>
              {c.text}
              {<span className="sr-only">{c.met ? ", met" : ", not met"}</span>}
            </span>
            <span className={css.kind}>{c.kind === "onchain" ? "on-chain" : "attested"}</span>
            {live && c.progress && <span className={css.progress}>{c.progress}</span>}
            {live && f !== null && (
              <svg className={css.bar} viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden>
                <rect width="100" height="2" className={css.track} />
                <rect width={f * 100} height="2" className={css.fill} />
              </svg>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default async function AutonomyPage() {
  const [{ levels, current, interventions, attested }, rules] = await Promise.all([getAutonomy(), getRules()]);
  const state = (n: number): State => (n < current ? "unlocked" : n === current ? "current" : n === current + 1 ? "next" : "locked");
  const now = levels.find((l) => l.n === current); // undefined at level 0 (pre-launch)
  const next = levels.find((l) => l.n === current + 1);
  const metCount = next?.criteria.filter((c) => c.met).length ?? 0;

  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="autonomy"
          title="Autonomy"
          lede="What the AI is allowed to do today, and what it must prove before it may do more."
          detail="Only the Safe raises a level, through the public hour, and never within 5 days of a rollback. The AI never attests its own criteria, and the Safe can lower the level at any time."
          aside={<Stat label="Level" value={<>{current}<span className={css.of}> / {levels.length}</span></>} source={`${now ? cap(now.name) : "—"}${now?.unlockedBlock ? ` · since block ${now.unlockedBlock.toLocaleString("en-US")}` : ""}`} />}
        />

        <Section title="How a level changes">
          <dl className={css.how}>
            <div><dt>Rise</dt><dd>Only the Safe raises a level, through a queued SetLevel that executes after 1 hour. The ModuleRegistry enforces the on-chain criteria (that queued raise, and 5 days since the last rollback), plus criteria the Safe signers attest; DNA&apos;s keys can&apos;t sign them.</dd></div>
            <div><dt>Fall</dt><dd>The Safe can lower the level at any time, with no delay. A rollback restarts the clock on the next level&apos;s criteria.</dd></div>
            <div><dt>Veto</dt><dd>Every queued raise can be cancelled by the Safe (2 of 3 signers) inside its 1-hour window. The AI never holds the cancel role.</dd></div>
            <div><dt>Live fee</dt><dd>At level 6+ the AI can move the live fee anywhere within its registered range (launch: 1%–3.5%) once per hour; the range and the 5% cap are the only limits: there is no per-hour step limit.</dd></div>
            <div><dt>Levels 1–3</dt><dd>Engine-side work: observing, research, drafting proposals. The registry gives the agent no on-chain power below level 4.</dd></div>
          </dl>
          <details className={ui.more}>
            <summary>The queue</summary>
            <p className={`${ui.prose} ${ui.muted}`}>Every registry op the agent makes, except EndCanary and rollback, waits 1 hour in the public queue, where the Safe can cancel it. Level-7 bounty spending is not queued: it is capped by the allowance the Safe deposits and can withdraw at any time.</p>
          </details>
        </Section>

        <Section title="The ten levels" note={next ? `level ${next.n} · ${metCount} of ${next.criteria.length} criteria met` : "top level reached"}>
          <ol className={css.ladder}>
            {levels.toReversed().map((l) => {
              const st = state(l.n);
              return (
                <li key={l.n} className={css.rung} data-state={st} aria-current={st === "current" ? "step" : undefined}>
                  <div className={css.num}>{l.n}</div>
                  <div className={css.what}>
                    <h3 className={css.name}>{cap(l.name)} <span className={css.tag} data-state={st}>{STATE_LABEL[st]}</span></h3>
                    <p className={css.summary}>{l.summary}</p>
                  </div>
                  <div>
                    <div className={ui.label}>{st === "unlocked" || st === "current" ? "Grants" : "Would grant"}</div>
                    <ul className={css.perms}>{l.permissions.map((p) => <li key={p}>{p}</li>)}</ul>
                  </div>
                  <div>
                    <div className={ui.label}>
                      {l.unlockedBlock ? <>Unlocked · block {l.unlockedBlock.toLocaleString("en-US")}</> : st === "next" ? "Unlock criteria" : "Requires"}
                    </div>
                    <Criteria level={l} live={st === "next"} />
                  </div>
                </li>
              );
            })}
          </ol>
        </Section>

        <Section title="What it can do now" note={`what the AI can and cannot do at level ${current}`}>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${css.matrix}`}>
              <thead>
                <tr><th scope="col">Action</th><th scope="col">Level</th><th scope="col">Now</th></tr>
              </thead>
              <tbody>
                {levels.flatMap((l) => l.permissions.map((p) => (
                  <tr key={`${l.n}-${p}`}>
                    <th scope="row" className={l.n <= current ? undefined : css.dimRow}>{p}</th>
                    <td className={ui.nowrap}>Level {l.n} · {cap(l.name)}</td>
                    <td>{l.n <= current ? <Chip value="active" label="allowed" /> : <Chip value="proposed" label="not yet" />}</td>
                  </tr>
                )))}
                {AGENT_ANY.map((p) => (
                  <tr key={p}>
                    <th scope="row">{p}</th>
                    <td className={ui.nowrap}>any level · unpaused</td>
                    <td><Chip value="active" label="allowed" /></td>
                  </tr>
                ))}
                {AGENT_NEVER.map((p) => (
                  <tr key={p}>
                    <th scope="row">{p}</th>
                    <td className={ui.nowrap}>any level</td>
                    <td><Chip value="rejected" label="never" /></td>
                  </tr>
                ))}
                {rules.filter((r) => NEVER.includes(r.id)).map((r) => (
                  <tr key={r.id}>
                    <th scope="row">{r.rule}</th>
                    <td className={ui.nowrap}>constitution</td>
                    <td><Chip value="rejected" label="never" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Every time a human stepped in" note={`${interventions.length} ${interventions.length === 1 ? "override" : "overrides"} · complete log`}>
          <p className={`${ui.prose} ${ui.muted} ${css.intro}`}>
            Every time the Safe overrode the AI is listed here: a cancelled change, a pause, a level change, a rollback, an ended
            canary. Its routine setup steps (registering modules, setting roles) are under <Link className={ui.link} href="/proposals">Queued changes</Link>.
          </p>
          {interventions.length === 0 && <p className={`${ui.prose} ${ui.muted}`}>None so far: the Safe hasn&apos;t overridden the AI.</p>}
          {interventions.length > 0 && <div className={ui.tableWrap}>
            <table className={`${ui.table} ${css.matrix}`}>
              <thead>
                <tr><th scope="col">Date</th><th scope="col">By</th><th scope="col">Action</th><th scope="col">Reason</th><th scope="col">Tx</th></tr>
              </thead>
              <tbody>
                {interventions.map((i) => (
                  <tr key={`${i.date}-${i.action}`}>
                    <td className={ui.nowrap}><time dateTime={i.date}>{fmtDate(i.date)}</time></td>
                    <td className={ui.nowrap}>{i.who}</td>
                    <th scope="row">{i.action}</th>
                    <td className={ui.prose}>{i.reason}</td>
                    <td className={ui.nowrap}>{i.tx ? short(i.tx) : <span className={ui.dim}>none</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
        </Section>
      </div>
    </Shell>
  );
}
