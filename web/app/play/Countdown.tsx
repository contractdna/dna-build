"use client";

import { useEffect, useState } from "react";
import { fmtDate, fmtTime } from "../_ui/ui";

const pad = (n: number) => String(n).padStart(2, "0");
/** "2d 04:12:09", "04:12:09", "now" */
export function left(ms: number) {
  if (ms <= 0) return "now";
  const t = Math.floor(ms / 1000), d = Math.floor(t / 86_400), h = Math.floor((t % 86_400) / 3600), m = Math.floor((t % 3600) / 60);
  return `${d ? `${d}d ` : ""}${pad(h)}:${pad(m)}:${pad(t % 60)}`;
}

/**
 * A ticking countdown to `to` (ISO). The server (and a no-JS visitor) gets the fixed UTC time; after hydration it counts
 * down once a second. Screen readers get the end time, not a number that changes every second.
 */
export function Countdown({ to, className }: { to: string; className?: string }) {
  const end = Date.parse(to);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const at = `${fmtDate(to)}, ${fmtTime(to)}`; // the same format as the rest of /play
  return (
    <time className={className} dateTime={to}>
      {now == null ? at : <><span className="sr-only">{at}</span><span aria-hidden>{left(end - now)}</span></>}
    </time>
  );
}
