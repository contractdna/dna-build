// The hook's fees, as the site shows them (contracts/src/DNAHook.sol `_baseline`, `PLATFORM_FEE`; web/test/launchFee.test.mjs
// pins these constants to the contract source). Every fee figure on the site derives from here: change a number once.
export const LAUNCH_FEE = { launch: 30_000, baseline: 22_000, platform: 3_000, decayS: 3600 } as const;
/** DNAHook.MAX_PROJECT_FEE: DNA's own fee can never go above it, whatever a module returns */
export const PROJECT_FEE_CAP = 50_000;

/** The baseline project fee (pips) `elapsedS` seconds after the pool's initialization: the hook's formula. */
export function baselineAt(elapsedS: number): number {
  const t = Math.max(0, Math.floor(elapsedS));
  if (t >= LAUNCH_FEE.decayS) return LAUNCH_FEE.baseline;
  return LAUNCH_FEE.baseline + Math.floor(((LAUNCH_FEE.launch - LAUNCH_FEE.baseline) * (LAUNCH_FEE.decayS - t)) / LAUNCH_FEE.decayS);
}

export const pct = (pips: number) => `${(pips / 1e4).toFixed(2)}%`;
/** "2.2%", "3%": copy keeps only the digits that mean something (the platform fee keeps its "0.30%" from `pct`) */
const short = (pips: number) => `${Number((pips / 1e4).toFixed(2))}%`;

/** The figures copy uses. `ours`: DNA's own fee; `platform`: Programmable's, on top, never ours; `total`: what a trade pays. */
export const FEE = {
  ours: short(LAUNCH_FEE.baseline),
  oursLaunch: short(LAUNCH_FEE.launch),
  platform: pct(LAUNCH_FEE.platform),
  total: short(LAUNCH_FEE.baseline + LAUNCH_FEE.platform),
  totalLaunch: short(LAUNCH_FEE.launch + LAUNCH_FEE.platform),
  cap: short(PROJECT_FEE_CAP),
  capAllIn: short(PROJECT_FEE_CAP + LAUNCH_FEE.platform),
} as const;
/** The chip that sits next to every fee on the site: the extra fee is Programmable's, not DNA's. */
export const PLATFORM_NOTE = `+${FEE.platform} Programmable launchpad fee (not ours)`;
/** The one fee sentence the site repeats. */
export const FEE_LINE = `${FEE.ours} + Programmable's ${FEE.platform} = ${FEE.total}; ${FEE.totalLaunch} for the first hour, sliding to ${FEE.total}`;
