// The watchdog's balance job (src/balances.ts) against fake provider replies: 75 % and 90 % used page once a UTC day
// each (the boot tick only 90 %, so a redeploy never re-pages 75 %), a missing key skips its provider with one note, a
// failed check never stops the others.
import assert from "node:assert/strict";
import { test } from "node:test";

import { balanceWatch } from "../src/balances.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 9, 6);

/** Fake providers: `left` is each one's remaining USD; every request is recorded with its auth header. */
function providers(left: Record<string, number>) {
  const calls: { url: string; auth: string | null }[] = [];
  const reply: Record<string, () => unknown> = {
    "https://openrouter.ai/api/v1/keys": () => ({ data: [
      { name: "engine", limit: 200, limit_remaining: left.orKey, usage: 200 - left.orKey, disabled: false },
      { name: "open", limit: null, limit_remaining: null, usage: 5, disabled: false }, // no limit: nothing to measure
      { name: "old", limit: 10, limit_remaining: 0, usage: 10, disabled: true }, // disabled: never paged
    ] }),
    "https://openrouter.ai/api/v1/credits": () => ({ data: { total_credits: 1000, total_usage: 1000 - left.openrouter } }),
    "https://api.x.com/2/usage/credits": () => ({ data: { total_balance: left.x, prepaid_balance: left.x, free_balance: 0, free_grants: [] } }),
    "https://management-api.x.ai/v1/billing/teams/team-1/prepaid/balance": () => ({ changes: [], total: { val: String(-left.xai * 100) } }), // credit is negative
    "https://cloud-api.phala.com/api/v1/auth/me": () => ({ user: {}, workspace: {}, credits: { balance: String(left.phala - 20), granted_balance: "20", is_post_paid: false } }),
    "https://drpc.org/api/metrics/json?range=day": () => ({ balance: Math.round(left.drpc * 1e6 / 0.3), data: [] }), // in CU, $0.30 per 1M
  };
  const f = (async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url, auth: h.get("authorization") ?? h.get("x-api-key") });
    const r = reply[url];
    if (!r) return new Response("not found", { status: 404 });
    return Response.json(r());
  }) as typeof fetch;
  return { f, calls };
}

const ALL = {
  OPENROUTER_MGMT_KEY: "or-mgmt", X_BEARER_TOKEN: "x-app", XAI_MGMT_KEY: "xai-mgmt", XAI_TEAM_ID: "team-1",
  PHALA_API_KEY: "phala", DRPC_API_TOKEN: "drpc",
};

test("75 % and 90 % used page once a UTC day each, per provider", async () => {
  const left = { orKey: 200, openrouter: 1000, x: 200, xai: 150, phala: 500, drpc: 50 };
  const { f } = providers(left);
  const pages: string[] = [];
  let t = T0;
  const w = balanceWatch({ env: ALL, page: async (x) => { pages.push(x); }, note: () => {}, fetch: f, now: () => t });

  left.xai = 150 * 0.3; // 70 % used (the boot tick)
  await w.tick();
  assert.deepEqual(pages, [], "under 75 %: quiet");

  left.xai = 150 * 0.24; // 76 %
  await w.tick();
  assert.equal(pages.length, 1);
  assert.match(pages[0], /xAI.*76% used.*\$36 of \$150 left/);
  await w.tick();
  assert.equal(pages.length, 1, "the same level pages once a day");

  left.xai = 150 * 0.09; // 91 %
  await w.tick();
  assert.equal(pages.length, 2);
  assert.match(pages[1], /xAI.*91% used/);
  await w.tick();
  assert.equal(pages.length, 2);

  t += DAY; // a new UTC day, still at 91 %: one page, the 90 % one
  await w.tick();
  assert.equal(pages.length, 3);
  assert.match(pages[2], /xAI.*91% used/);
});

test("the boot tick pages only 90 %; 75 % then waits for the next day", async () => {
  const left = { orKey: 200, openrouter: 1000, x: 200, xai: 150 * 0.2, phala: 500, drpc: 50 * 0.05 }; // xAI 80 %, dRPC 95 %
  const { f } = providers(left);
  const pages: string[] = [];
  let t = T0;
  const w = balanceWatch({ env: ALL, page: async (x) => { pages.push(x); }, note: () => {}, fetch: f, now: () => t });
  await w.tick();
  assert.equal(pages.length, 1);
  assert.match(pages[0], /dRPC at 95% used/);
  await w.tick();
  assert.equal(pages.length, 1, "xAI's 75 % is not paged later the same day either");
  left.xai = 150 * 0.05; // 95 %
  await w.tick();
  assert.equal(pages.length, 2);
  assert.match(pages[1], /xAI at 95% used/);
  t += 86_400_000;
  left.xai = 150 * 0.2;
  await w.tick();
  assert.deepEqual(pages.slice(2).map((p) => p.split(" at ")[0]).sort(), ["Balance: dRPC", "Balance: xAI"], "a new day pages both again");
});

test("every provider is read with its own key; each OpenRouter key's limit is its own funded amount", async () => {
  const { f, calls } = providers({ orKey: 10, openrouter: 50, x: 10, xai: 15, phala: 25, drpc: 4 }); // all ≥ 90 % used
  const pages: string[] = [];
  const w = balanceWatch({ env: ALL, page: async (x) => { pages.push(x); }, note: () => {}, fetch: f, now: () => T0 });
  await w.tick();
  assert.deepEqual(calls.map((c) => [new URL(c.url).host, c.auth]), [
    ["openrouter.ai", "Bearer or-mgmt"], ["openrouter.ai", "Bearer or-mgmt"], ["api.x.com", "Bearer x-app"],
    ["management-api.x.ai", "Bearer xai-mgmt"], ["cloud-api.phala.com", "phala"], ["drpc.org", "Bearer drpc"],
  ]);
  assert.equal(pages.length, 6);
  for (const [name, pct] of [["OpenRouter key engine", 95], ["OpenRouter", 95], ["X API", 95], ["xAI", 90], ["Phala", 95], ["dRPC", 92]] as const)
    assert.ok(pages.some((p) => p.startsWith(`Balance: ${name} at ${pct}% used`)), `${name} ${pct}%: ${pages.join(" | ")}`);
  assert.ok(pages.every((p) => !/or-mgmt|x-app|xai-mgmt|phala"|drpc"/.test(p)), "no key in a page");
});

test("funded amounts come from env when set", async () => {
  const { f } = providers({ orKey: 200, openrouter: 1000, x: 200, xai: 150, phala: 500, drpc: 20 });
  const pages: string[] = [];
  const w = balanceWatch({ env: { ...ALL, FUNDED_USD_DRPC: "250" }, page: async (x) => { pages.push(x); }, note: () => {}, fetch: f, now: () => T0 });
  await w.tick();
  assert.equal(pages.length, 1);
  assert.match(pages[0], /dRPC at 92% used \(\$20 of \$250 left\)/);
});

test("dRPC's balance is in compute units: a live reading of 33,337,080 CU is $10 left", async () => {
  const f = (async () => Response.json({ balance: 33337080, data: [] })) as typeof fetch;
  const pages: string[] = [];
  const w = balanceWatch({ env: { DRPC_API_TOKEN: "drpc", FUNDED_USD_DRPC: "200" }, page: async (x) => { pages.push(x); }, note: () => {}, fetch: f, now: () => T0 });
  await w.tick();
  assert.deepEqual(pages, ["Balance: dRPC at 95% used ($10 of $200 left). Top up or check auto top-up."]);
});

test("boot notes each checked provider's funded amount and whether it came from FUNDED_USD_*", async () => {
  const notes: string[] = [];
  balanceWatch({ env: { ...ALL, FUNDED_USD_X: "25" }, page: async () => {}, note: (x) => notes.push(x), fetch: providers({}).f, now: () => T0 });
  assert.ok(notes.includes("balances: X API funded $25 (FUNDED_USD_X)"), notes.join(" | "));
  for (const [name, k, v] of [["OpenRouter", "OPENROUTER", 1000], ["xAI", "XAI", 150], ["Phala", "PHALA", 500], ["dRPC", "DRPC", 50]] as const)
    assert.ok(notes.includes(`balances: ${name} funded $${v} (default; set FUNDED_USD_${k})`), `${name}: ${notes.join(" | ")}`);
});

test("a missing key skips that provider with one note; nothing is fetched for it", async () => {
  const { f, calls } = providers({ orKey: 0, openrouter: 0, x: 0, xai: 0, phala: 0, drpc: 0 });
  const notes: string[] = [];
  const pages: string[] = [];
  const w = balanceWatch({ env: { X_BEARER_TOKEN: "x-app", XAI_MGMT_KEY: "xai-mgmt" }, page: async (x) => { pages.push(x); }, note: (x) => notes.push(x), fetch: f, now: () => T0 });
  await w.tick();
  await w.tick();
  assert.deepEqual(calls.map((c) => new URL(c.url).host), ["api.x.com", "api.x.com"], "only X is checked");
  assert.equal(pages.length, 1, "X at 100 % used, once");
  for (const name of ["OpenRouter keys", "OpenRouter", "xAI", "Phala", "dRPC"])
    assert.equal(notes.filter((n) => n.includes(`${name} skipped`)).length, 1, `${name}: ${notes.join(" | ")}`);
  assert.ok(notes.some((n) => /xAI skipped.*XAI_TEAM_ID/.test(n)), "names what is missing");
  assert.ok(notes.some((n) => /OpenAI/.test(n)), "OpenAI: no balance API, noted once");
});

test("a failed or odd reply is noted and never stops the other providers", async () => {
  const { f } = providers({ orKey: 0, openrouter: 0, x: 0, xai: 0, phala: 0, drpc: 0 });
  const broken = (async (url: string, init?: RequestInit) => {
    if (url.includes("api.x.com")) return new Response("{}", { status: 401 });
    if (url.includes("drpc.org")) return Response.json({ data: [] }); // no balance field
    if (url.includes("phala")) throw new Error("socket hang up");
    return f(url, init);
  }) as typeof fetch;
  const notes: string[] = [];
  const pages: string[] = [];
  const w = balanceWatch({ env: ALL, page: async (x) => { pages.push(x); }, note: (x) => notes.push(x), fetch: broken, now: () => T0 });
  await w.tick();
  assert.equal(pages.length, 3, "the OpenRouter key, OpenRouter credits, xAI still page");
  assert.ok(notes.some((n) => /X API check failed: HTTP 401/.test(n)));
  assert.ok(notes.some((n) => /dRPC check failed: unexpected reply/.test(n)));
  assert.ok(notes.some((n) => /Phala check failed: socket hang up/.test(n)));
});

test("a provider whose boot read failed still pages only 90 % on its first good read", async () => {
  const { f } = providers({ orKey: 200, openrouter: 1000, x: 200, xai: 150 * 0.2, phala: 500, drpc: 50 }); // xAI 80 %
  let down = true;
  const flaky = (async (url: string, init?: RequestInit) => (down && url.includes("x.ai") ? new Response("", { status: 503 }) : f(url, init))) as typeof fetch;
  const pages: string[] = [];
  const w = balanceWatch({ env: ALL, page: async (x) => { pages.push(x); }, note: () => {}, fetch: flaky, now: () => T0 });
  await w.tick();
  down = false;
  await w.tick();
  assert.deepEqual(pages, []);
});
