"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LIVE } from "../_data/flags";
import { useLive } from "../_live/LiveProvider";
import { FEE } from "../_data/launchFee";
import { STATE } from "../_live/plain";
import { PlatformChip } from "../_ui/ui";
import { Shell, X_URL } from "../_ui/Shell";
import s from "./dna.module.css";

/**
 * The homepage: one continuous camera journey down the helix (scene.js), with the story told by the scroll.
 * The text lives here as real DOM (readable, indexed); the scene fades each block in and keeps particles off it.
 * No WebGL, no JS or reduced motion: the same text stacks as a plain page.
 */
// The launch split (FeeVault's initial bps: burn, liquidity, treasury, games); mock mode shows it
const LAUNCH_SPLIT = [3500, 3500, 3000, 0];
const SPLIT = [["Burn", "#ff6f5e"], ["Liquidity", "#4fd6c8"], ["Treasury", "#ffc06b"], ["Games", "#b98bff"]] as const;

/** `split`: FeeVault's current split in bps (LIVE, read by the page); empty while the indexer has no snapshot. */
export default function DNA({ split = LAUNCH_SPLIT }: { split?: number[] }) {
  const root = useRef<HTMLDivElement>(null);
  const { core, ca } = useLive();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!ca) return;
    try { await navigator.clipboard.writeText(ca); } catch { return; }
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  };
  const [ready, setReady] = useState(false);
  const [flat, setFlat] = useState(false);

  useEffect(() => {
    let destroy: ((o?: { reuse?: boolean }) => void) | undefined, gone = false;
    const fail = () => { setFlat(true); setReady(true); };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return fail(); // the journey is all motion: give the plain page
    // canvas text must use the same Karrik face next/font loaded for the page
    const font = getComputedStyle(document.documentElement).getPropertyValue("--font-karrik").trim() || "sans-serif";
    // the camera path is framed for the window's shape at mount: a real shape change (rotation, phone ↔ desktop layout,
    // a window dragged much wider or taller) rebuilds the scene at the same scroll position instead of keeping stale framing
    const shape = () => ({ w: innerWidth, aspect: innerWidth / innerHeight, mobile: matchMedia("(max-width: 760px)").matches });
    // phones and tablets: the address bar changes the height while scrolling, so only width, rotation or layout count
    const fine = matchMedia("(pointer: fine)").matches;
    const reframe = (a: ReturnType<typeof shape>, b: ReturnType<typeof shape>) =>
      a.mobile !== b.mobile || a.aspect > 1 !== b.aspect > 1 || Math.abs(b.w / a.w - 1) > 0.12 || (fine && Math.abs(b.aspect / a.aspect - 1) > 0.12);
    let mounted = shape(), timer = 0, frac = 0;
    // the journey position as a fraction, kept current: after a resize the page height (1500vh) has already changed
    // (scroll events fired by the resize itself, e.g. the browser clamping scrollY, carry the new size: ignored)
    let size = `${innerWidth}x${innerHeight}`;
    const onScroll = () => {
      if (`${innerWidth}x${innerHeight}` !== size) return;
      const max = document.documentElement.scrollHeight - innerHeight; frac = max > 0 ? scrollY / max : 0;
    };
    let mount: (typeof import("./scene.js"))["mountDNA"] | undefined;
    const start = () => {
      destroy = mount!(root.current!, { font, demo: !LIVE, debug: location.search.includes("capture"), onReady: () => setReady(true) });
      mounted = shape();
    };
    const onResize = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const now = shape();
        const was = size;
        size = `${innerWidth}x${innerHeight}`;
        if (was === size) return;
        if (!mount || !reframe(mounted, now)) return;
        const at = frac;
        destroy?.({ reuse: true });
        try { start(); } catch { fail(); return; }
        requestAnimationFrame(() => scrollTo(0, at * (document.documentElement.scrollHeight - innerHeight)));
      }, 300);
    };
    import("./scene.js").then((m) => {
      if (gone) return;
      mount = m.mountDNA;
      try { start(); } catch { fail(); } // no WebGL
    }, fail);
    addEventListener("resize", onResize);
    addEventListener("scroll", onScroll, { passive: true });
    return () => { gone = true; clearTimeout(timer); removeEventListener("resize", onResize); removeEventListener("scroll", onScroll); destroy?.(); };
  }, []);

  return (
    <Shell immersive intro revealed={ready}>
      <div ref={root} className={s.root} data-dna data-flat={flat || undefined}>
        <canvas className={s.canvas} aria-hidden="true" />
        <div className={s.load} data-gone={ready || undefined} aria-hidden="true">DNA</div>

        <section className={s.head} data-head>
          <h1>Watch a<br />token<br />evolve</h1>
          <div className={s.col} data-col>
            <p data-glitch>DNA is an Ethereum token whose hook mutates in public.</p>
            <p data-glitch>An AI tests each mutation on real trades, keeps what works and rolls back the rest.</p>
            <p data-glitch>All inside hard limits nobody can change. {LIVE ? "Live on Uniswap." : "Launching soon on Uniswap."}</p>
          </div>
        </section>

        <section className={s.organ} data-organ="0"><h2>Mutation vote</h2><p data-glitch>Every two days the AI puts three fee mutations on a ballot and stakers pick one. The winner is tested next and stays only if it works.</p></section>
        <section className={s.organ} data-organ="1"><h2>Holder jackpot</h2><p data-glitch>Hold 1,000+ DNA and you&apos;re in. Each draw, 10 wallets split the pot equally, picked by Chainlink randomness and paid straight to their wallets. Stakers count ×2 to ×4.</p></section>
        <section className={s.organ} data-organ="2"><h2>The Sequencer</h2><p data-glitch>It builds the best ideas into new games, fee modules or new pages on this site, attacks its own code, and ships only what passes, after one public hour. It&apos;s switched on and builds from the first winning idea.</p></section>
        <section className={s.organ} data-organ="3"><h2>Idea rewards</h2><p data-glitch>30% of the games pot pays the people whose fee idea is kept after its test, or whose build idea ships. The brain sets each amount, and every payment waits one public hour.</p></section>
        <section className={s.organ} data-organ="4"><h2>Mystery mutation</h2><p data-glitch>Once a week the AI seals a hidden fee mutation on-chain. It opens about two days later, and nobody can swap it in between, us included.</p></section>
        <section className={s.organ} data-organ="5">
          <h2>Fees feed it</h2>
          <p data-glitch>Every trade pays a fee. It buys and burns DNA, adds liquidity{split[3] > 0 ? ", funds the treasury and fills the games pot" : " and funds the treasury"}.</p>
          {/* DNA's fee, and Programmable's on top as its own chip: it is the launchpad's, not ours (figures: _data/launchFee) */}
          <p className={s.feeLine}><span>{FEE.ours} to DNA</span><PlatformChip /><span>= {FEE.total} a trade</span></p>
          {split.length === 4 && (
            <p className={s.split}>
              {SPLIT.map(([name, color], i) => <span key={name} style={{ color }}><b>{split[i] / 100}%</b>{name}</span>)}
            </p>
          )}
        </section>

        <div className={s.end} data-end>
          <div className={s.big} data-big>Evolving in public</div>
          {/* the Genome Vaults: 50 NFTs that lock 200,000 DNA each and share what the Safe sends them (the /vaults page) */}
          <p className={s.vaults}>Genome Vaults: 50 NFTs. Lock 200,000 DNA to mint one, burn it any time to get it back. They share the ETH the Safe sends them, equally. Nothing is promised.</p>
          <nav aria-label="Next">
            <a href={X_URL} target="_blank" rel="noopener noreferrer">Follow on X →</a>
            <Link href="/live">See it live →</Link>
            <Link href="/vaults">The Genome Vaults →</Link>
            <Link href="/sequencer">See the Sequencer →</Link>
            <Link href="/docs">Read the docs →</Link>
          </nav>
          {/* LIVE: the token address from the deployment manifest, copyable; never a placeholder before launch */}
          {ca && <button type="button" className={s.ca} onClick={copy} aria-label="Copy contract address">{copied ? "Copied" : <>Contract <span className={s.addr}>{ca}</span></>}</button>}
        </div>

        <div className={s.status} role={LIVE ? "status" : undefined /* the demo ticker would announce every 4 s */}>
          <i />
          {LIVE ? <span>{STATE[core.state].now}</span> : <><span className={s.demo}>[Demo]</span><span data-status>reading the market</span></>}
        </div>
        <div className={s.scroll} />
      </div>
    </Shell>
  );
}
