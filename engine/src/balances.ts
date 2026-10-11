// The watchdog's balance job (run by scripts/watchdog.ts, OUTSIDE the enclave, read-only): polls each paid provider's
// remaining balance and pages the signers' group at 75 % and at 90 % used of its funded amount, each level once a UTC
// day per provider. The boot tick (a provider's first good read) pages only the 90 % level (a 75 % reading is marked as paged for that day), so a
// redeploy never re-pages 75 %. A provider whose key is not set is skipped with one note. Keys come from env only, are
// read-only (no inference key: the watchdog can never spend), and never reach a page or a note.
//   OpenRouter: GET /api/v1/keys and GET /api/v1/credits (management key); each enabled key's own limit is its funded
//               amount, a key without a limit has nothing to measure
//   X API:      GET /2/usage/credits (app-only bearer token)
//   xAI:        GET management-api /v1/billing/teams/{team}/prepaid/balance (management key); total.val in USD cents,
//               prepaid credit negative
//   Phala:      GET /api/v1/auth/me; credits.balance + credits.granted_balance
//   dRPC:       GET /api/metrics/json?range=day (Statistics API token); balance in compute units (CU), priced at
//               DRPC_USD_PER_CU
// OpenAI has no balance API: it runs on auto-reload, and the engine's own spend caps bound it.
type Env = Record<string, string | undefined>;
type Reading = { name: string; remaining: number; funded: number };
type Source = { name: string; needs: string[]; fund?: string; read: (env: Env, f: typeof fetch) => Promise<Reading[]> };

export const BALANCES = { pollMs: 60 * 60_000, levels: [0.9, 0.75] };

/** Initial deposits (spec §8); FUNDED_USD_<NAME> overrides, e.g. after a bigger top-up. */
const FUNDED_USD: Record<string, number> = { OPENROUTER: 1000, X: 200, XAI: 150, PHALA: 500, DRPC: 50 };
/** dRPC's flat pay-as-you-go price, $0.30 per 1M CU (drpc.org/docs/pricing/compute-units). A volume discount would
 *  make this read low, so alerts come early, never late. */
const DRPC_USD_PER_CU = 0.3 / 1e6;
const funded = (env: Env, k: string) => Number(env[`FUNDED_USD_${k}`] ?? FUNDED_USD[k]);

async function get(f: typeof fetch, url: string, headers: Record<string, string>): Promise<any> {
  const r = await f(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const bearer = (k: string | undefined) => ({ authorization: `Bearer ${k}` });

const SOURCES: Source[] = [
  { name: "OpenRouter keys", needs: ["OPENROUTER_MGMT_KEY"], read: async (env, f) => {
    const keys = (await get(f, "https://openrouter.ai/api/v1/keys", bearer(env.OPENROUTER_MGMT_KEY))).data;
    if (!Array.isArray(keys)) throw new Error("unexpected reply");
    return keys.filter((k) => !k.disabled && k.limit != null).map((k) => ({ name: `OpenRouter key ${k.name}`, remaining: k.limit_remaining, funded: k.limit }));
  } },
  { name: "OpenRouter", needs: ["OPENROUTER_MGMT_KEY"], fund: "OPENROUTER", read: async (env, f) => {
    const d = (await get(f, "https://openrouter.ai/api/v1/credits", bearer(env.OPENROUTER_MGMT_KEY))).data;
    return [{ name: "OpenRouter", remaining: d?.total_credits - d?.total_usage, funded: funded(env, "OPENROUTER") }];
  } },
  { name: "X API", needs: ["X_BEARER_TOKEN"], fund: "X", read: async (env, f) => {
    const d = (await get(f, "https://api.x.com/2/usage/credits", bearer(env.X_BEARER_TOKEN))).data;
    return [{ name: "X API", remaining: d?.total_balance, funded: funded(env, "X") }];
  } },
  { name: "xAI", needs: ["XAI_MGMT_KEY", "XAI_TEAM_ID"], fund: "XAI", read: async (env, f) => {
    const b = await get(f, `https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(env.XAI_TEAM_ID!)}/prepaid/balance`, bearer(env.XAI_MGMT_KEY));
    return [{ name: "xAI", remaining: -Number(b?.total?.val) / 100, funded: funded(env, "XAI") }];
  } },
  { name: "Phala", needs: ["PHALA_API_KEY"], fund: "PHALA", read: async (env, f) => {
    const b = await get(f, "https://cloud-api.phala.com/api/v1/auth/me", { "x-api-key": env.PHALA_API_KEY!, "x-phala-version": "2026-01-21" });
    const c = b?.credits;
    return [{ name: "Phala", remaining: Number(c?.balance) + Number(c?.granted_balance ?? 0), funded: funded(env, "PHALA") }];
  } },
  { name: "dRPC", needs: ["DRPC_API_TOKEN"], fund: "DRPC", read: async (env, f) => {
    const b = await get(f, "https://drpc.org/api/metrics/json?range=day", bearer(env.DRPC_API_TOKEN));
    return [{ name: "dRPC", remaining: b?.balance * DRPC_USD_PER_CU, funded: funded(env, "DRPC") }];
  } },
];

const usd = (n: number) => `$${Math.max(0, n).toFixed(0)}`;

export function balanceWatch(o: { env: Env; page: (text: string) => Promise<void>; note?: (text: string) => void; fetch?: typeof fetch; now?: () => number }) {
  const f = o.fetch ?? fetch, now = o.now ?? Date.now, note = o.note ?? console.log;
  const active = SOURCES.filter((s) => {
    const missing = s.needs.filter((k) => !o.env[k]);
    if (missing.length) note(`balances: ${s.name} skipped (no ${missing.join(", ")})`);
    return !missing.length;
  });
  for (const s of active) if (s.fund) note(`balances: ${s.name} funded $${funded(o.env, s.fund)} (${o.env[`FUNDED_USD_${s.fund}`] ? `FUNDED_USD_${s.fund}` : `default; set FUNDED_USD_${s.fund}`})`);
  note("balances: OpenAI has no balance API; it runs on auto-reload under the engine's own spend caps");
  // `${provider}:${UTC day}` → the highest level paged that day. simplification: one entry per provider a day is never pruned
  const paged = new Map<string, number>();
  const read = new Set<string>(); // providers read since boot: the first good read is that provider's boot tick

  async function tick() {
    for (const s of active) {
      let readings: Reading[];
      try {
        readings = await s.read(o.env, f);
        for (const r of readings) if (!Number.isFinite(r.remaining) || !(r.funded > 0)) throw new Error("unexpected reply");
      } catch (e) {
        note(`balances: ${s.name} check failed: ${(e as Error).message.slice(0, 200)}`);
        continue;
      }
      const boot = !read.has(s.name);
      read.add(s.name);
      for (const r of readings) {
        const used = 1 - r.remaining / r.funded;
        const level = BALANCES.levels.find((l) => used >= l);
        const key = `${r.name}:${new Date(now()).toISOString().slice(0, 10)}`;
        if (!level || (paged.get(key) ?? 0) >= level) continue;
        paged.set(key, level);
        if (boot && level < BALANCES.levels[0]) continue; // a redeploy: 75 % was paged before it, or waits for tomorrow
        await o.page(`Balance: ${r.name} at ${Math.round(used * 100)}% used (${usd(r.remaining)} of ${usd(r.funded)} left). Top up or check auto top-up.`);
      }
    }
  }
  return { tick };
}
