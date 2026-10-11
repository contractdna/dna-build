// Build orders: the shared vector the workflow checks (same hashing and signing as the enclave log), and every refusal.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { canonical } from "../src/canonical.ts";
import { chainHash as logChainHash, logDigest as logLogDigest } from "../src/log.ts";
import { chainHash, logDigest, type Order, orderRef, verifyOrder } from "../src/seq-order.ts";

const key = `0x${"11".repeat(32)}` as const;
const enclave = privateKeyToAccount(key);
const spec = "A free game: each click starts or extends a one-hour round; the last clicker wins a tenth of the pot.";
const NOW = Date.parse("2026-10-09T12:00:00Z");
export const order = (over: Partial<Order> = {}): Order => ({
  v: 1, id: "o-20261009-1", build: "b-20261009", round: 1, slug: "lastclick", salt: `0x${"ab".repeat(32)}`, factory: `0x${"cd".repeat(20)}`, safe: `0x${"ef".repeat(20)}`,
  baseSha: "e".repeat(40), spec, specSha256: createHash("sha256").update(spec).digest("hex"), rubric: { value: 4, fit: 5, clarity: 4, originality: 3 },
  models: { lead: "anthropic/claude-opus-5.5", worker: "anthropic/claude-haiku-5.5", tester: "anthropic/claude-sonnet-5.5", fixer: "anthropic/claude-sonnet-5.5", review: "anthropic/claude-opus-5.5" },
  effort: { lead: "medium", worker: "max", tester: "high", fixer: "high", review: "high" },
  budget: { ceilingUsd: 12, perQueryUsd: { lead: 2, worker: 0.5, tester: 1, fixer: 1, review: 2 } },
  fixRounds: 3, issues: [], expiresAt: "2026-10-09T12:20:00Z", ...over,
});
/** Sign a body as the enclave log does. */
export async function signed(body: unknown, ref = orderRef(body as Order), by = enclave) {
  const text = canonical(body);
  const eprev = randomBytes(32).toString("hex");
  const ehash = chainHash(Buffer.from(eprev, "hex"), text).toString("hex");
  const esig = await by.signMessage({ message: { raw: `0x${logDigest(ehash, "build", ref)}` } });
  return { seq: "42", kind: "build" as const, ref, body: text, eprev, ehash, esig };
}

test("the same hashing as the enclave log (chain step and signed digest)", () => {
  const prev = randomBytes(32);
  assert.deepEqual(chainHash(prev, "abc"), logChainHash(prev, "abc"));
  assert.equal(logDigest("aa".repeat(32), "build", "order:x"), logLogDigest("aa".repeat(32), "build", "order:x"));
});

test("a signed, fresh order verifies", async () => {
  const r = await verifyOrder(await signed(order()), enclave.address, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.order.slug, "lastclick");
});

test("planted: every refusal", async () => {
  const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const good = await signed(order());
  const cases: [string, unknown, string | null, RegExp][] = [
    ["no pinned signer", good, null, /no enclave log signer/],
    ["another signer", await signed(order(), undefined, other), enclave.address, /not signed by the enclave/],
    ["an edited body", { ...good, body: good.body.replace("lastclick", "lastclicz") }, enclave.address, /does not hash/],
    ["a re-hashed edited body", await (async () => { const s = await signed(order()); const body = s.body.replace("lastclick", "lastclicz"); return { ...s, body, ehash: chainHash(Buffer.from(s.eprev, "hex"), body).toString("hex") }; })(), enclave.address, /not signed/],
    ["another ref", await signed(order(), "order:other-order-1"), enclave.address, /ref is not the order's/],
    ["expired", await signed(order({ expiresAt: "2026-10-09T11:59:59Z" })), enclave.address, /expired/],
    ["spec hash", await signed(order({ specSha256: "0".repeat(64) })), enclave.address, /spec does not hash/],
    ["a field too many", await signed({ ...order(), extra: 1 }), enclave.address, /not an order/],
    ["a budget over the ceiling", await signed(order({ budget: { ceilingUsd: 13, perQueryUsd: order().budget.perQueryUsd } })), enclave.address, /not an order/],
    ["round 5", await signed(order({ round: 5 })), enclave.address, /not an order/],
    // the SDK prices only Claude ids: any other model costs $0 a turn to it, so maxBudgetUsd would never stop a query
    ["a model the SDK can't price (another provider)", await signed(order({ models: { ...order().models, worker: "x-ai/grok-4.7" } })), enclave.address, /not an order/],
    ["a model the SDK can't price (no provider prefix)", await signed(order({ models: { ...order().models, lead: "claude-opus-5-5" } })), enclave.address, /not an order/],
    ["a model id with a path or a space", await signed(order({ models: { ...order().models, review: "anthropic/claude-opus 5.5/../x" } })), enclave.address, /not an order/],
    ["no safe", await signed((({ safe: _s, ...o }) => o)(order())), enclave.address, /not an order/],
    ["an expiry far ahead (a replayable order)", await signed(order({ expiresAt: "2026-10-09T12:31:00Z" })), enclave.address, /too far ahead/],
    ["a malformed record", { ...good, esig: "0x00" }, enclave.address, /malformed/],
    ["another kind", { ...good, kind: "brain" }, enclave.address, /malformed/],
  ];
  for (const [what, rec, signer, want] of cases) {
    const r = await verifyOrder(rec, signer, NOW);
    assert.equal(r.ok, false, what);
    assert.match(!r.ok ? r.why : "", want, what);
  }
});
