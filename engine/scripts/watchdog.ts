// The jackpot list and idea reward watchdog service: read-only, OUTSIDE the enclave, no signing keys, no DB. The loop is
// src/watchdog.ts; a signer runs cancelList(window) or cancelReward(id) on a page. It also runs the balance job
// (src/balances.ts) with read-only provider keys, never an inference key: OPENROUTER_MGMT_KEY, X_BEARER_TOKEN,
// XAI_MGMT_KEY + XAI_TEAM_ID, PHALA_API_KEY, DRPC_API_TOKEN (each optional), FUNDED_USD_<NAME> overrides.
// Env: RPC_URL (comma-separated, ≥ 2 providers), CHAIN_ID or DEPLOYMENT_FILE, TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_ID, TELEGRAM_API_BASE (tests),
// LOG_SIGNER (optional: the attested log signer), WATCHDOG_FROM_BLOCK (optional; default head − 50,000 at boot), PORT,
// LOG_BASE_URL (the site serving signed records), GITHUB_REPO (owner/name: the release branch it watches).
// The release check's ship-veto test needs LOG_SIGNER (owner vetoes are bound to the enclave's log signer); without it
// a release to a vetoed ship's merge is not paged.
// Balances only (before launch, no deployment addresses yet): `--balances-only` or WATCHDOG_MODE=balances runs just the
// hourly balance loop and /health; no deployment file, RPC_URL or chain env is read. It needs TELEGRAM_BOT_TOKEN,
// TELEGRAM_GROUP_ID, the provider keys above and FUNDED_USD_OPENROUTER / _XAI / _X / _DRPC / _PHALA. Remove the mode
// (and set the chain env) to run the full watchdog.
// Engine liveness (both modes): ENGINE_HEALTH_URL = the engine's /health (the CVM's gateway URL + /health); pages when
// it fails or is stale for 10 min, once per outage (src/watchdog.ts engineLiveness). Unset: not watched (one note).
// Railway: engine/watchdog.railway.json (service `watchdog`, start `node scripts/watchdog.ts`). Never deployed by the
// engine; the operator creates the service.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import type { Dep } from "../src/ticket-source.ts";
import { publicReleaseHead } from "../src/seq-watch.ts";
import { BALANCES, balanceWatch } from "../src/balances.ts";
import { createWatchdog, engineLiveness, LIVENESS, telegramPager, WATCH } from "../src/watchdog.ts";

const env = process.env;
const balancesOnly = process.argv.includes("--balances-only") || env.WATCHDOG_MODE === "balances";
const port = Number(env.PORT ?? 8080);

const page = telegramPager(env);
console.log(`pages: stdout${env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_GROUP_ID ? ` and Telegram at ${env.TELEGRAM_API_BASE ?? "https://api.telegram.org"}` : " only (no Telegram token or group)"}`);

const balances = balanceWatch({ env, page });
(async () => {
  for (;;) {
    try { await balances.tick(); } catch (e) { console.error("balances tick:", (e as Error).message); }
    await new Promise((r) => setTimeout(r, BALANCES.pollMs));
  }
})();

const liveness = env.ENGINE_HEALTH_URL ? engineLiveness({ url: env.ENGINE_HEALTH_URL, page }) : null;
console.log(liveness ? `liveness: the engine's /health every ${LIVENESS.pollMs / 1000} s, a page after ${LIVENESS.staleMs / 60_000} min down` : "liveness: not watched (no ENGINE_HEALTH_URL)");
if (liveness) (async () => {
  for (;;) {
    try { await liveness.tick(); } catch (e) { console.error("liveness tick:", (e as Error).message); }
    await new Promise((r) => setTimeout(r, LIVENESS.pollMs));
  }
})();

if (balancesOnly) {
  console.log("watchdog: balances only (no chain checks)");
  createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: "balances", ...liveness?.health() }));
  }).listen(port);
} else {
  const dep = JSON.parse(readFileSync(env.DEPLOYMENT_FILE ?? new URL(`../deployments/${env.CHAIN_ID ?? 1}.json`, import.meta.url), "utf8")) as Dep;
  const urls = (env.RPC_URL ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length < 2) throw new Error("the watchdog needs RPC_URL with at least two providers");

  const wd = createWatchdog({
    clients: urls.map((u) => createPublicClient({ transport: http(u, { retryCount: 3 }) })), dep, page, logSigner: env.LOG_SIGNER ?? null,
    // the Sequencer checks: signed ship / fund / release records from the site, the public repo's release branch
    logBase: env.LOG_BASE_URL ?? "https://genomedna.xyz", releaseHead: env.GITHUB_REPO ? publicReleaseHead(env.GITHUB_REPO) : undefined,
    fromBlock: env.WATCHDOG_FROM_BLOCK ? BigInt(env.WATCHDOG_FROM_BLOCK) : undefined,
  });

  createServer((req, res) => {
    const h = wd.health();
    res.writeHead(req.url === "/health" && !h.ok ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...h, from: h.from?.toString() ?? null, ...liveness?.health() }));
  }).listen(port);

  for (;;) {
    try { await wd.tick(); } catch (e) { console.error("watchdog tick:", (e as Error).message); }
    await new Promise((r) => setTimeout(r, WATCH.pollMs));
  }
}
