"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LIVE, SITE_HOST } from "../_data/flags";
import { useLive } from "../_live/LiveProvider";
import { IconCopy, IconSound } from "./icons";
import s from "./shell.module.css";

const LAB = ["/lab", "/mind", "/memory", "/modules", "/evolution", "/autonomy", "/treasury", "/constitution", "/journal", "/security", "/xp", "/proof", "/models"];
const NAV = [
  { label: "Live", href: "/live", match: ["/live"] },
  { label: "News", href: "/announcements", match: ["/announcements"] },
  { label: "Play", href: "/play", match: ["/play"] },
  { label: "Trade", href: "/trade", match: ["/trade"] },
  { label: "Vaults", href: "/vaults", match: ["/vaults"] },
  { label: "How it works", href: "/how-it-works", match: ["/how-it-works"] },
  { label: "Sequencer", href: "/sequencer", match: ["/sequencer"] },
  { label: "Docs", href: "/docs", match: ["/docs"] },
  { label: "Ideas", href: "/proposals", match: ["/proposals", "/bounties"] },
  { label: "Lab", href: "/lab", match: LAB },
];
export const X_URL = "https://x.com/contractdna";

/**
 * Site frame: wordmark + ghost nav (a full-screen menu on phones), main, quiet footer.
 * `immersive` (homepage): the header floats over a full-screen canvas, no footer, children edge to edge.
 * `intro` keeps the header hidden until `revealed` (the homepage specimen reveals it).
 */
export function Shell({ children, immersive, intro, revealed, mainClass }: {
  children: React.ReactNode; immersive?: boolean; intro?: boolean; revealed?: boolean; mainClass?: string;
}) {
  const { soundOn, toggleSound, stale, ca } = useLive();
  const CA = ca ?? null; // LIVE: token from the deployment manifest; mock: never show a placeholder address
  const path = usePathname();
  const menu = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => { menu.current?.close(); }, [path]); // navigating from the menu closes it

  const copy = async () => {
    if (!CA) return;
    try { await navigator.clipboard.writeText(CA); } catch { return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const current = (match: string[]) => match.some((m) => path === m || path.startsWith(`${m}/`));
  const links = (onClick?: () => void) => NAV.map((n) => (
    <Link key={n.href} href={n.href} onClick={onClick} aria-current={current(n.match) ? "page" : undefined}>{n.label}</Link>
  ));

  return (
    <div className={s.shell} data-immersive={immersive || undefined} data-intro={intro || undefined} data-revealed={revealed || undefined}>
      <a className={s.skip} href="#main">Skip to content</a>
      <header className={s.header}>
        <Link className={s.logo} href="/">DNA</Link>
        <nav className={s.nav} aria-label="Primary">{links()}</nav>
        <button className={s.menuBtn} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="site-menu"
          onClick={() => { menu.current?.showModal(); setOpen(true); }}>Menu</button>
      </header>

      {/* native modal dialog: traps focus, Esc closes, focus returns to the Menu button */}
      <dialog id="site-menu" ref={menu} className={s.menu} aria-label="Menu" onClose={() => setOpen(false)}>
        <div className={s.menuTop}>
          <Link className={s.logo} href="/" onClick={() => menu.current?.close()}>DNA</Link>
          <button className={s.menuBtn} type="button" onClick={() => menu.current?.close()}>Close</button>
        </div>
        <nav className={s.menuNav} aria-label="Primary">{links(() => menu.current?.close())}</nav>
        <a className={s.menuX} href={X_URL} target="_blank" rel="noopener noreferrer">@contractdna on X</a>
      </dialog>

      <main id="main" className={mainClass}>{children}</main>

      {!immersive && (
        <footer className={s.footer}>
          <span>DNA · {SITE_HOST}</span>
          <a className={s.link} href={X_URL} target="_blank" rel="noopener noreferrer">@contractdna</a>
          <Link className={s.link} href="/rules">Rules for ideas</Link>
          {CA
            ? <button className={s.ca} type="button" onClick={copy} aria-label="Copy contract address">{copied ? "Copied" : `Contract ${CA.slice(0, 6)}…${CA.slice(-4)}`}<IconCopy /></button>
            : !LIVE && <span title="The official contract address is published here at launch">Contract address at launch</span>}
          {LIVE && stale && <span role="status" className={s.stale}>Data delayed: the indexer is behind</span>}
          <button className={s.sound} type="button" onClick={toggleSound} aria-pressed={soundOn} data-sound-toggle>
            <IconSound on={soundOn} />Sound {soundOn ? "on" : "off"}
          </button>
        </footer>
      )}
    </div>
  );
}
