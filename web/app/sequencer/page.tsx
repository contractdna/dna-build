import type { Metadata } from "next";
import Link from "next/link";
import { ParticleField } from "../_ui/ParticleField";
import { Shell } from "../_ui/Shell";
import { ui } from "../_ui/ui";
import { Sequencer } from "./Sequencer";
import s from "./sequencer.module.css";

export const metadata: Metadata = {
  title: "The Sequencer · DNA",
  description: "One map of DNA's engine: ideas come in, the brain decides, its dev team builds new games, every change waits a public hour, and every fee is split in public.",
};

export default function SequencerPage() {
  return (
    <Shell>
      <div className={s.stage}>
        <div className={s.fieldWrap}><ParticleField mood="sequencer" budget={1 / 3} className={s.field} /></div>
        <div className={ui.page}>
          <Sequencer head={
            <div className={s.head}>
              <h1 className={s.title}>The Sequencer</h1>
              <p className={s.lede}>How DNA runs itself. The fee loop tunes the live hook, and the brain&apos;s dev team builds new games from the best ideas. Every change waits one public hour, and the Safe can cancel it.</p>
              <p className={s.rehearsal}>
                <span>The engine is live. The map below is the loop, animated. What it is doing right now is on the <Link className={ui.link} href="/live">Live page</Link>.</span>
              </p>
            </div>
          } />
          <details className={ui.more}>
            <summary>The limits</summary>
            <dl className={s.limits}>
              <div><dt>Spend</dt><dd>The AI&apos;s spending has a daily and a monthly cap. Near the cap the dev team pauses first. Trading and payouts never need the AI.</dd></div>
              <div><dt>Games</dt><dd>At most 3 live. Each is its own contract with no power over the hook, the fees or other games, and takes no deposits at first. A game with no players for 2 days is retired: its money goes back to the Safe and open claims stay payable.</dd></div>
              <div><dt>Models</dt><dd>Every role&apos;s model and backup are public. These are the default models. Swapping one needs a public tryout on fixed test cases, then a public hour, and the Safe can veto. Swapping the brain itself needs two Safe owners to approve.</dd></div>
            </dl>
          </details>
        </div>
      </div>
    </Shell>
  );
}
