// One icon family: 10–16 unit grids, 1.4 stroke, round caps. Authored SVG only (no glyphs).

const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const IconX = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 10 10" width="10" height="10" aria-hidden {...base}><path d="M2 2l6 6M8 2l-6 6" /></svg>
);
export const IconNext = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 10 10" width="10" height="10" aria-hidden {...base}><path d="M3.5 2l3 3-3 3" /></svg>
);
export const IconCheck = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 10 10" width="10" height="10" aria-hidden {...base}><path d="M2 5.2l2 2L8 3" /></svg>
);
export const IconDot = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 10 10" width="10" height="10" aria-hidden {...base}><circle cx="5" cy="5" r="2.4" /></svg>
);
export const IconCopy = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" width="13" height="13" aria-hidden {...base} strokeWidth={1.3}><rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M3 11V4a1 1 0 0 1 1-1h7" /></svg>
);
export const IconSearch = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" width="14" height="14" aria-hidden {...base}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
);
export const IconExternal = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 10 10" width="10" height="10" aria-hidden {...base}><path d="M4 2h4v4M8 2L3.5 6.5M6.5 8H2V3.5" /></svg>
);
export const IconSound = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 20 16" width="16" height="13" aria-hidden {...base}>
    <path d="M2 6h3l4-3v10l-4-3H2z" />
    {on ? <path d="M12 5c1 1 1.5 2 1.5 3s-.5 2-1.5 3M14.5 3c1.5 1.4 2.3 3.1 2.3 5s-.8 3.6-2.3 5" /> : <path d="M12.5 6l4 4M16.5 6l-4 4" />}
  </svg>
);

