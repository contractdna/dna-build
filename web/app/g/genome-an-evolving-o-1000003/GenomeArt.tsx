"use client";
// Draws one genome from its genomeOf data, in JSX only (svg, rect, line): no raw markup, no inline image data, no network.
// The trait bytes fill an 8 x 4 grid of cells (32 at most), one cell per trait, coloured by its byte; the empty cells
// stay dark. The scars are one dashed line under the grid, drawn once however many there are: its dashes grow with the
// scar count.
import s from "./page.module.css";

const COLS = 8;
const SLOTS = 32;
const CELL = 20;
const PITCH = 24;
const WIDTH = COLS * PITCH - 4;
const SCAR_Y = 4 * PITCH + 6;
const HEIGHT = SCAR_Y + 6;
const EMPTY = "#2a2a2a";
const SCAR = "#c0392b";

/** The bytes of a 0x-prefixed hex string, one number per byte, in order. */
const bytesOf = (hex: string): number[] => (hex.slice(2).match(/.{2}/g) ?? []).map((b) => parseInt(b, 16));

const slots = Array.from({ length: SLOTS }, (_, i) => i);

export function GenomeArt({ traits, scars }: { traits: string; scars: number }) {
  const bytes = bytesOf(traits);
  const dash = 2 + Math.min(scars, 40);
  return (
    <svg className={s.art} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${bytes.length} traits, ${scars} scars`}>
      {slots.map((i) => {
        const v = bytes.at(i);
        return (
          <rect
            key={i}
            x={(i % COLS) * PITCH}
            y={Math.floor(i / COLS) * PITCH}
            width={CELL}
            height={CELL}
            rx={4}
            fill={v === undefined ? EMPTY : `hsl(${Math.round((v * 360) / 256)} 65% 55%)`}
          />
        );
      })}
      {scars > 0 && (
        <line x1={0} x2={WIDTH} y1={SCAR_Y} y2={SCAR_Y} stroke={SCAR} strokeWidth={3} strokeDasharray={`${dash} 4`} />
      )}
    </svg>
  );
}
