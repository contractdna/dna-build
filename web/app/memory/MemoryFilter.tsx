"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { IconSearch } from "../_ui/icons";
import u from "../_ui/ui.module.css";
import s from "./memory.module.css";

const FILTERS = [["all", "All"], ["accepted", "Accepted"], ["rejected", "Rejected"], ["rolled_back", "Rolled back"]] as const;

const url = (q: string, d: string) => {
  const p = new URLSearchParams();
  if (q.trim()) p.set("q", q.trim());
  if (d !== "all") p.set("d", d);
  const qs = p.toString();
  return qs ? `/memory?${qs}` : "/memory";
};

/**
 * Search + decision filter. State lives in the URL (?q=&d=), so results are shareable and the back button works:
 * filter clicks push history, typing replaces it. Without JS the form still submits as a plain GET.
 */
export function MemoryFilter({ q, d, counts }: { q: string; d: string; counts: Record<string, number> }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // back/forward changes ?q: mirror it into the field, unless the user is typing there
  useEffect(() => {
    const el = input.current;
    if (el && document.activeElement !== el) el.value = q;
  }, [q]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const go = (v: string) => router.replace(url(v, d), { scroll: false });

  return (
    <div className={s.filter}>
      <form role="search" action="/memory" onSubmit={(e) => { e.preventDefault(); clearTimeout(timer.current); go(input.current?.value ?? ""); }}>
        <label className={s.search}>
          <span className="sr-only">Search memory entries</span>
          <IconSearch className={s.searchIcon} />
          <input
            ref={input} className={`${u.input} ${s.searchInput}`} type="search" name="q" defaultValue={q}
            placeholder="Search entries, evidence, rules" autoComplete="off" spellCheck={false}
            onChange={(e) => { const v = e.target.value; clearTimeout(timer.current); timer.current = setTimeout(() => go(v), 250); }}
          />
        </label>
        {d !== "all" && <input type="hidden" name="d" value={d} />}
      </form>
      <nav className={s.tabs} aria-label="Filter by decision">
        {FILTERS.map(([key, label]) => (
          <Link key={key} className={s.tab} href={url(q, key)} scroll={false} aria-current={d === key ? "true" : undefined}>
            {label}<span className={s.count}>{counts[key] ?? 0}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
