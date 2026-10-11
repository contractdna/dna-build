// X wallet bindings, the pure parts (src/rewards.ts): the deterministic intake regex (no model) and which binding is in
// force for an X user id at a given time (first binding at once, a rebinding 48 h later, a newer one replaces a pending
// one, binding back cancels it).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BINDING_REPLY, type BindingRecord, bindingAt, parseBinding, REBIND_DELAY_MS } from "../src/rewards.ts";

const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // the EIP-55 spec's own example
const lower = CHECKSUMMED.toLowerCase();

test("parseBinding: a mention of @contractdna with exactly one address; mixed case must be EIP-55", () => {
  assert.deepEqual(parseBinding(`@contractdna ${CHECKSUMMED}`), { address: CHECKSUMMED });
  assert.deepEqual(parseBinding(`@ContractDNA ${lower}`), { address: CHECKSUMMED }, "all lower case: no checksum to check");
  assert.deepEqual(parseBinding(`@someone @contractdna\n${lower} `), { address: CHECKSUMMED }, "reply prefixes and whitespace are fine");
  // only the exact format binds: any other words make it no binding (and no public confirmation)
  for (const t of [`@ContractDNA pay me at ${lower} please`, `@contractdna send me ETH ${CHECKSUMMED} I'm a long term holder`, `@contractdna airdrop to early supporters, start with me ${lower}`, `@contractdna ${CHECKSUMMED}.`]) assert.equal(parseBinding(t), null, t);
  assert.deepEqual(parseBinding(`@contractdna 0x${lower.slice(2).toUpperCase()}`), { address: CHECKSUMMED }, "all upper case");
  assert.deepEqual(parseBinding(`@contractdna ${CHECKSUMMED.replace("a", "A")}`), { error: "the address fails its checksum (EIP-55)" }, "one flipped letter");
  assert.deepEqual(parseBinding(`@contractdna ${CHECKSUMMED} ${`0x${"1".repeat(40)}`}`), { error: "more than one address" });
  assert.deepEqual(parseBinding(`@contractdna ${CHECKSUMMED} ${lower}`), { address: CHECKSUMMED }, "the same address twice is one address");
  assert.deepEqual(parseBinding(`@contractdna 0x${"0".repeat(40)}`), { error: "the zero address" });
  assert.equal(parseBinding(`${CHECKSUMMED} no mention of us`), null);
  assert.equal(parseBinding("@contractdna lower the fee at night"), null, "no address: not a binding");
  assert.equal(parseBinding(`@contractdnax ${CHECKSUMMED}`), null, "another account");
  assert.equal(parseBinding(`@contractdna 0x${"a".repeat(41)}`), null, "too long: not an address");
  assert.equal(parseBinding(`@contractdna tx 0x${"ab".repeat(32)}`), null, "a tx hash is not an address");
  assert.equal(BINDING_REPLY, "This links your X account to this wallet publicly; use a fresh wallet if you want.");
});

test("the public /rules page states the binding rules the code applies", async () => {
  const { readFileSync } = await import("node:fs");
  const { REWARD_HOLD_DAYS } = await import("../src/policy.ts");
  const { BINDING_LIMITS } = await import("../src/bindings.ts");
  const page = readFileSync(new URL("../../web/app/rules/page.tsx", import.meta.url), "utf8");
  for (const s of [`takes effect ${REBIND_DELAY_MS / 3600_000} hours after the post`, `waits up to ${REWARD_HOLD_DAYS} days`, "Use a fresh wallet if you want", "one wallet address", "Code reads it, not the AI", `At most ${BINDING_LIMITS.perDay} wallet posts count a day`, "Your first wallet counts at once and gets one reply on X"]) assert.ok(page.includes(s), s);
});

const H = 3600_000;
const T = Date.parse("2026-10-08T00:00:00Z");
const A = `0x${"a1".repeat(20)}`, B = `0x${"b2".repeat(20)}`, C = `0x${"c3".repeat(20)}`;
let seq = 0;
const b = (address: string, at: number, effectiveAt = at): BindingRecord & { seq: string } =>
  ({ kind: "binding", xUserId: "777", address: address as `0x${string}`, postId: "1", at: new Date(at).toISOString(), effectiveAt: new Date(effectiveAt).toISOString(), seq: String(++seq) });

test("bindingAt: the first binding is in force at once; a rebinding 48 h later; a newer one replaces a pending one; binding back cancels it", () => {
  assert.equal(REBIND_DELAY_MS, 48 * H);
  assert.deepEqual(bindingAt([], T), { cur: undefined, pending: undefined });
  const first = b(A, T);
  assert.equal(bindingAt([first], T).cur, first);
  assert.equal(bindingAt([first], T - 1).cur, undefined, "not before it was written");
  const re = b(B, T + H, T + H + REBIND_DELAY_MS);
  assert.deepEqual(bindingAt([first, re], T + 2 * H), { cur: first, pending: re });
  assert.deepEqual(bindingAt([first, re], T + H + REBIND_DELAY_MS), { cur: re, pending: undefined });
  // a hijacked account rebinds to B; its owner binds back to A within the 48 h: B never takes effect
  const back = b(A, T + 10 * H);
  assert.deepEqual(bindingAt([first, re, back], T + 100 * H), { cur: first, pending: undefined });
  // a newer rebinding replaces the pending one (and its own 48 h start again)
  const re2 = b(C, T + 20 * H, T + 20 * H + REBIND_DELAY_MS);
  assert.deepEqual(bindingAt([first, re, re2], T + H + REBIND_DELAY_MS), { cur: first, pending: re2 });
  assert.equal(bindingAt([first, re, re2], T + 20 * H + REBIND_DELAY_MS).cur, re2);
  // a later rebinding after one took effect
  const re3 = b(A, T + 60 * H, T + 60 * H + REBIND_DELAY_MS);
  assert.deepEqual(bindingAt([first, re, re3], T + 61 * H), { cur: re, pending: re3 });
  // order is by seq, whatever order the caller passes
  assert.deepEqual(bindingAt([re3, re, first], T + 61 * H), { cur: re, pending: re3 });
});
