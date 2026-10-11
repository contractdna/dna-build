// Shared page primitives. Server-safe (no hooks). Styling: ui.module.css.
import Link from "next/link";
import { LIVE } from "../_data/flags";
import { FEE, PLATFORM_NOTE } from "../_data/launchFee";
import { BASE_KEY, BASE_RIM, MOODS, type Mood } from "./moods";
import { ParticleField } from "./ParticleField";
import s from "./ui.module.css";

export { s as ui };

// Honest data-source note. Mock mode: every page is sample data (one badge per page). LIVE shows real data only: no badge.
const SAMPLE = "sample data · pre-launch";

/**
 * Page title block: a back link, the uppercase h1, a one-sentence plain-English `lede` (what the page proves), an optional
 * longer `detail`, and an honest data-source note. `hero`: the section's colour mood for the live particle field behind
 * the title, full bleed (ParticleField). `sample`: mock mode only, whole page is sample (default: every page; `false` for
 * pages that show no data). LIVE never shows the badge.
 */
export type Hero = Mood;

export function PageHead({ title, lede, detail, aside, sample, hero, back = { href: "/lab", label: "Lab" } }: {
  title: string; lede: string; detail?: React.ReactNode; aside?: React.ReactNode; sample?: boolean; hero?: Hero; back?: { href: string; label: string } | null;
}) {
  const badge = !LIVE && (sample ?? true);
  const top = (
    <>
      {back && <Link className={s.back} href={back.href}><span aria-hidden>←</span> {back.label}</Link>}
      <h1 className={s.title}>{title}</h1>
      <p className={s.lede}>{lede}</p>
      {(aside || badge) && (
        <div className={s.headAside}>
          {aside}
          {badge && <span className={s.sample}>{SAMPLE}</span>}
        </div>
      )}
    </>
  );
  if (!hero) return <header className={s.head}>{top}{detail && <p className={s.detail}>{detail}</p>}</header>;
  const [m1, m2] = MOODS[hero];
  return (
    <>
      {/* the gradient is the look without WebGL or JS; the field paints over it */}
      <header className={s.hero} style={{ "--m1": m1, "--m2": m2, "--kb": BASE_KEY, "--rb": BASE_RIM } as React.CSSProperties}>
        <ParticleField mood={hero} className={s.heroField} />
        <div className={s.heroCopy}>{top}</div>
      </header>
      {detail && <div className={s.head}><p className={s.detail}>{detail}</p></div>}
    </>
  );
}

/**
 * Every fee on the site says it the same way: DNA's own fee, then Programmable's on top as a separate chip (it is not
 * ours), then what a trade pays. The figures come from _data/launchFee, so they live in one place.
 */
export const PlatformChip = () => <span className={s.platform}>{PLATFORM_NOTE}</span>;

export function FeeBreakdown({ className }: { className?: string }) {
  return (
    <div className={`${s.fees} ${className ?? ""}`} role="group" aria-label="Fee per trade">
      <span className={s.feePart}><b>{FEE.ours}</b><span>DNA&apos;s fee</span><small>{FEE.oursLaunch} in the first hour, after the launch tax (90% → 10%, blocks 0 to 8)</small></span>
      <PlatformChip />
      <span className={s.feePart}><b>= {FEE.total}</b><span>per trade, all in</span><small>{FEE.totalLaunch} in the first hour, sliding to {FEE.total}</small></span>
    </div>
  );
}

export function Section({ title, note, children, className }: { title: string; note?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`${s.section} ${className ?? ""}`}>
      <div className={s.sectionHead}>
        <h2 className={s.h2}>{title}</h2>
        {note && <span className={s.note}>{note}</span>}
      </div>
      {children}
    </section>
  );
}

// States where the AI is testing something live right now: these alone get the blood square.
const RUNNING = new Set(["shadow", "canary", "canary_queued", "testing"]);

/** Status word: plain ash text, no colour coding; a blood square only while a test is running. */
export function Chip({ value, label }: { value: string; label?: string }) {
  return <span className={s.chip} data-running={RUNNING.has(value) || undefined}>{(label ?? value).replace(/_/g, " ")}</span>;
}

export function Stat({ label, value, source }: { label: string; value: React.ReactNode; source?: string }) {
  return (
    <div className={s.stat}>
      <div className={s.label}>{label}</div>
      <div className={s.value}>{value}</div>
      {source && <div className={s.source}>{source}</div>}
    </div>
  );
}

export const Label = ({ children }: { children: React.ReactNode }) => <div className={s.label}>{children}</div>;

/** Display helpers: data stays raw (full hex, ISO dates); pages format at render. */
/** "EPOCH 01" → "Epoch 01": names stored in capitals, shown in normal case. */
export const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
export const short = (hex: string) => (hex.length > 14 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex);
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
