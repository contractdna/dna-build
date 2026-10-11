import type { Metadata } from "next";
import { getThread } from "../_data/source";
import type { ThreadStep } from "../_data/types";
import { IconNext } from "../_ui/icons";
import { Shell } from "../_ui/Shell";
import { Chip, fmtTime, PageHead, Section, ui } from "../_ui/ui";
import s from "./mind.module.css";

export const metadata: Metadata = {
  title: "AI thread · DNA",
  description: "DNA's live reasoning thread: hypothesis, evidence for and against, red-team counter-arguments, confidence and next steps, each step signed by the agent and pinned model that wrote it.",
};

const KIND: Record<ThreadStep["kind"], string> = {
  hypothesis: "The idea",
  "evidence+": "Evidence for",
  "evidence-": "Evidence against",
  counter: "Counter-argument",
  confidence: "Confidence",
  decision: "Decision",
  next: "Next",
};
const SEGMENTS = 20;

export default async function MindPage() {
  const thread = await getThread();
  if (!thread) {
    return (
      <Shell>
        <div className={ui.page}>
          <PageHead hero="mind" title="AI thread" lede="The AI's reasoning, step by step: the idea, the evidence for and against it, and what it will do next." />
          <Section title="The reasoning">
            <p className={`${ui.prose} ${ui.muted}`}>No thread is open right now. The AI opens one when it starts researching a fee change, and every step goes into its signed log.</p>
          </Section>
        </div>
      </Shell>
    );
  }
  const { steps } = thread;
  const conf = steps.findLast((x) => x.kind === "confidence");
  const pct = conf?.value ?? Number([...(conf?.text.matchAll(/(\d+(?:\.\d+)?)\s*%/g) ?? [])].at(-1)?.[1] ?? NaN); // typed value, else last "NN%" in text
  const decision = steps.findLast((x) => x.kind === "decision");
  const next = steps.filter((x) => x.kind === "next");
  const last = steps[steps.length - 1];

  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="mind"
          title="AI thread"
          lede="The AI's reasoning, step by step: the idea, the evidence for and against it, and what it will do next."
          detail="Each step names the agent and the exact model version that wrote it. Arguments against a change sit next to the ones for it, and every step goes into a hash-chained log, so nothing can be quietly edited."
          aside={<Chip value={thread.status} label={`thread ${thread.id} · ${thread.status}`} />}
        />
        <div className={s.layout}>
          <Section title="The reasoning" note={`${thread.id} · ${steps.length} steps · hash-chained log`} className={s.thread}>
            <p className={s.question}>{thread.title}</p>
            <ol className={s.steps}>
              {steps.map((st) => (
                <li key={st.id} className={s.step}>
                  <div className={s.body}>
                    <div className={s.meta}>
                      <span className={s.kind}>{KIND[st.kind]}</span>
                      <span className={s.agent}>{st.agent} agent</span>
                      <span className={s.model}>model {st.model}</span>
                      <time className={s.at} dateTime={st.at}>{fmtTime(st.at)}</time>
                    </div>
                    <p className={s.text}>{st.text}</p>
                    {st.ref && <div className={ui.source}>{st.ref}</div>}
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          <aside className={s.side} aria-label="Thread state">
            <Section title="Status" note={last ? <>last step <time dateTime={last.at}>{fmtTime(last.at)}</time></> : undefined}>
              <div className={s.disp}>
                <Chip value={thread.status} label={thread.status === "open" ? "open · undecided" : "decided"} />
                <p className={`${ui.prose} ${ui.muted} ${s.small}`}>
                  {decision ? decision.text : "No decision recorded yet. Nothing moves to canary (a live test on some trades) until the thread is decided."}
                </p>
              </div>
            </Section>
            {conf && Number.isFinite(pct) && (
              <Section title="Confidence" note={conf.ref}>
                <div className={s.conf}>
                  <span className={s.pct}>{pct}%</span>
                  <div className={s.bar} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Model self-assessed confidence">
                    {Array.from({ length: SEGMENTS }, (_, k) => <i key={k} data-on={k < Math.round((pct / 100) * SEGMENTS) || undefined} />)}
                  </div>
                </div>
                <div className={ui.source}>model self-assessment · uncalibrated</div>
              </Section>
            )}
            {next.length > 0 && (
              <Section title="Next">
                <ul className={s.next}>
                  {next.map((x) => <li key={x.id}><IconNext className={s.caret} />{x.text}</li>)}
                </ul>
              </Section>
            )}
          </aside>
        </div>
      </div>
    </Shell>
  );
}
