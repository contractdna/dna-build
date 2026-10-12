/** A fact sheet for each event whose card code draws on a plate, as the launch, progress, treasury and site posts carry
 *  them (a fee split, a buyback and a site change get studio art first: media-slots SCENE_OF). */
export const PLATE_SAMPLES: Record<string, Record<string, unknown>> = {
  contracts_connected: {}, keys_handed: {}, first_idea_round: {}, first_burn: {}, seq_online: {},
  fees_distributed: { hours: 6, distributions: 2, totalEth: 1.234, buybackEth: 0.6, liquidityEth: 0.3, treasuryEth: 0.2, gamesEth: 0.134 },
  burn_summary: { hours: 6, buybacks: 3, spentEth: 0.9, burnedDna: 25_106_443 },
  liquidity_added: { hours: 6, adds: 1, ethAdded: 0.3 },
  progress_day: { hours: 24, totalEth: 4.5, spentEth: 2, burnedDna: 90_000_000, ethAdded: 1 },
  jackpot_params: { window: 3, capPct: 2, minBalance: 100_000, exchangesExcluded: 4, startsAt: "2026-10-12T00:00:00Z" },
  treasury_buy: { dnaAmount: 12_500_000, ethSpent: 2.5, supplyPct: 1.25 },
  treasury_transfer: { dnaAmount: 5_000_000, supplyPct: 0.5, label: "growth team" },
  site_changed: { title: "Burn page", summary: "the burn page shows every burn", url: "/play/a-very-long-path-that-goes-on-and-on" },
};
