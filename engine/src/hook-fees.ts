// DNAHook's fee constants, as the engine reasons about them (contracts/src/DNAHook.sol; test/hook-fees.test.ts pins
// them to the contract source): 2.2% project + Programmable's 0.30% (profile 3.6.0) = 2.5% for traders; 3.0% project
// (3.3%) at the pool's initialization, sliding linearly to the baseline over the first hour.
export const HOOK_FEES = { baseline: 22_000, platform: 3_000, launch: 30_000, launchDecayS: 3600, max: 50_000 } as const;

/** "2.20%" from pips. */
export const pctOf = (pips: number) => `${(pips / 1e4).toFixed(2)}%`;
