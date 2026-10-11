import type { Metadata } from "next";
import { LIVE } from "../_data/flags";
import { baselineAt } from "../_data/launchFee";
import { getLab, getLaunchedAt, getMemory, getModules, getRules, getThread } from "../_data/source";
import { Shell } from "../_ui/Shell";
import { ui } from "../_ui/ui";
import { LiveView, type Fee, type Proof } from "./LiveView";

export const metadata: Metadata = {
  title: "Live · DNA",
  description: "What DNA's AI is doing right now: the current fee, its task, its latest actions and the proof behind them.",
};

/** LIVE: the active fee module and its on-chain params (null: none active, the hook's baseline applies). */
async function activeFee(): Promise<Fee> {
  const m = (await getModules()).find((x) => x.kind === "FeePolicy" && x.status === "active");
  return m ? { module: `${m.name} ${m.version}`, params: m.params.map((p) => ({ key: p.key, value: p.value })) } : null;
}

// the hard limits worth seeing at a glance (all of them: /constitution)
const LIMITS = ["fee-cap", "supply", "timelock", "lp", "platform"];

/** The essence of the four proof pages (/mind, /lab/experiments, /memory, /constitution), from the same getters they use. */
async function proof(): Promise<Proof> {
  const [thread, lab, memory, rules] = await Promise.all([getThread(), getLab(), getMemory(), getRules()]);
  const conf = thread?.steps.findLast((x) => x.kind === "confidence");
  const confidence = conf?.value ?? Number([...(conf?.text.matchAll(/(\d+(?:\.\d+)?)\s*%/g) ?? [])].at(-1)?.[1] ?? NaN);
  return {
    thread: thread && {
      id: thread.id, title: thread.title, status: thread.status,
      idea: thread.steps.find((x) => x.kind === "hypothesis")?.text,
      against: thread.steps.findLast((x) => x.kind === "evidence-" || x.kind === "counter")?.text,
      forN: thread.steps.filter((x) => x.kind === "evidence+").length,
      againstN: thread.steps.filter((x) => x.kind === "evidence-" || x.kind === "counter").length,
      confidence: Number.isFinite(confidence) ? confidence : null,
      next: (thread.steps.findLast((x) => x.kind === "decision") ?? thread.steps.findLast((x) => x.kind === "next"))?.text,
    },
    bench: { experiments: lab.experiments.map((e) => ({ id: e.id, module: e.module, status: e.status, metrics: e.metrics.slice(0, 2) })) },
    lessons: { entries: memory.entries.slice(0, 3).map((e) => ({ id: e.id, title: e.title, decision: e.decision, lesson: e.futureRule ?? e.result })) },
    limits: LIMITS.flatMap((id) => rules.filter((r) => r.id === id)).map((r) => ({ id: r.id, value: r.value ?? "", rule: r.rule.split(/(?<=\.)\s/)[0] })),
  };
}

export default async function LivePage() {
  const fee = LIVE ? await activeFee() : null; // mock: no module data is shown as real
  // the hook's baseline right now (the launch fee slides 3% → 2.2% over the first hour); null before the pool exists
  const launchedAt = LIVE ? await getLaunchedAt() : null;
  const baseline = launchedAt == null ? null : baselineAt(Date.now() / 1000 - launchedAt);
  return (
    <Shell>
      <div className={ui.page}><LiveView fee={fee} baseline={baseline} proof={await proof()} /></div>
    </Shell>
  );
}
