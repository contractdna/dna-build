// The brain and owner signatures against a real Postgres (fresh database per run) and the local API fakes: a decision
// is one cached call on the brain model, costed in llm_call, and a signed `brain` record; owner signatures are stored
// as `approve` / `veto` records and read back by effective().
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { privateKeyToAccount } from "viem/accounts";
import { startFakes } from "../scripts/fakes.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
const dbName = `dna_brain_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc`, ENGINE_MODE: "dry_run", LLM_MODE: "live",
    OPENROUTER_API_BASE: fakes.url, XAI_API_BASE: fakes.url, OPENROUTER_API_KEY_ENGINE: "k", XAI_API_KEY: "k",
  });
}
const { edb: sql, migrate } = await import("../src/db.ts");
const brain = await import("../src/brain.ts");
const approve = await import("../src/approve.ts");
const swap = await import("../src/swap.ts");
const { append } = await import("../src/log.ts");

before(async () => { if (ADMIN) await migrate(); });
after(async () => {
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await fakes.close();
});

test("decide: one cached call on the brain model, costed under `rest`, recorded as a signed brain record", { skip }, async () => {
  fakes.llm.anthropic = (b) => ({
    model: b.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ decision: "no-build", reason: "no test plan", risks: ["untested payout"] }) }],
    usage: { input_tokens: 200, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0, output_tokens: 100 },
  });
  const d = await brain.decide("build", { spec: "coin flip" }, "spec-1");
  assert.deepEqual(d.decision, { decision: "no-build", reason: "no test plan", risks: ["untested payout"] });
  assert.equal(d.contextSha256, brain.CONTEXT.sha256);
  const req = fakes.calls.filter((c) => c.path === "/v1/messages").at(-1)!;
  assert.deepEqual([req.body.model, req.body.provider], ["anthropic/claude-fable-5.1", { order: ["anthropic"], allow_fallbacks: false }]); // via OpenRouter, pinned
  assert.deepEqual(req.body.system[0].cache_control, { type: "ephemeral" });
  const [row] = await sql<{ budget: string; cost: string }[]>`select budget, cost_usd::text as cost from llm_call where agent = 'brain'`;
  assert.equal(row.budget, "rest");
  assert.equal(Number(row.cost), (200 * 10 + 2000 * 12.5 + 100 * 50) / 1e6);
  const [rec] = await sql<{ doc: { kind: string; decision: unknown } }[]>`select doc from log where kind = 'brain' and ref = 'build:spec-1'`;
  assert.deepEqual(rec.doc.decision, d.decision);
});

test("self-file: the first decision of the day signs one, the brain sees it, its record names the self-file, persona and context hashes", { skip }, async () => {
  const self = await import("../src/self.ts");
  const { PERSONA } = await import("../src/persona.ts");
  type SelfDoc = { kind: string; day: string; text: string; sha256: string; personaSha256: string | null; contextSha256: string };
  const selfs = () => sql<{ seq: string; ref: string; doc: SelfDoc }[]>`select seq::text, ref, doc from log where kind = 'self' order by log.seq`;
  // the decision in the first test had no self-file yet: it signed one (append-only log: it stays)
  const [s1, more] = await selfs();
  assert.ok(s1 && !more, "one self record, signed by the first decision");
  assert.equal(s1.ref, new Date().toISOString().slice(0, 10));
  assert.equal(s1.doc.sha256, createHash("sha256").update(s1.doc.text).digest("hex"));
  assert.deepEqual([s1.doc.personaSha256, s1.doc.contextSha256], [PERSONA.sha256, brain.CONTEXT.sha256]);
  assert.equal(PERSONA.sha256, null, "tests run on the neutral default persona");
  assert.ok(!("charter" in s1.doc) && !("voice" in s1.doc), "no persona text in the record");
  assert.match(s1.doc.text, /^# DNA: self-file\n/);
  const [first] = await sql<{ doc: { selfSha256: string; personaSha256: string | null } }[]>`select doc from log where kind = 'brain' and ref = 'build:spec-1'`;
  assert.deepEqual([first.doc.selfSha256, first.doc.personaSha256], [s1.doc.sha256, null]);
  // the same day: reused, and in the brain's message
  fakes.llm.anthropic = (b) => ({
    model: b.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ retire: false, reason: "players came back" }) }],
    usage: { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 50 },
  });
  const d = await brain.decide("retire", { game: "0xg", players48h: 3, ageH: 60 }, "0xg:2026-10-20");
  assert.deepEqual([d.selfSha256, d.personaSha256, d.contextSha256], [s1.doc.sha256, null, brain.CONTEXT.sha256]);
  assert.equal((await selfs()).length, 1);
  const req = fakes.calls.filter((c) => c.path === "/v1/messages").at(-1)!;
  assert.equal(JSON.parse(req.body.messages[0].content).self, s1.doc.text, "the self-file is in the brain's message");
  // the daily job signs a fresh one with both decisions and the chain's level; the next decision uses it
  self.SELF_DEPS.chain = async () => ({ level: 5, paused: false });
  await self.selfHandler.run({} as never);
  const s2 = (await selfs()).at(-1)!;
  assert.notEqual(s2.seq, s1.seq);
  assert.match(s2.doc.text, /#\d+ build spec-1: no-build\. After: nothing recorded yet\./);
  assert.match(s2.doc.text, /#\d+ retire 0xg:2026-10-20: keep\./);
  assert.match(s2.doc.text, /Autonomy level 5 of 10/);
  assert.equal((await brain.decide("retire", { game: "0xg", players48h: 3, ageH: 61 }, "0xg:2026-10-20b")).selfSha256, s2.doc.sha256);
  // today's newest made beside another persona or context (an older image or env) is not reused; racing decisions sign one
  for (const stale of [{ personaSha256: "00".repeat(32) }, { contextSha256: "00".repeat(32) }]) {
    await append("self", s2.ref, { ...s2.doc, ...stale });
    const n = (await selfs()).length;
    const [a, b] = await Promise.all([self.currentSelf(), self.currentSelf()]);
    const now = await selfs();
    assert.equal(now.length, n + 1, `one new record for both (${Object.keys(stale)[0]})`);
    assert.deepEqual([a.sha256, b.sha256], [now.at(-1)!.doc.sha256, now.at(-1)!.doc.sha256]);
    assert.deepEqual([now.at(-1)!.doc.personaSha256, now.at(-1)!.doc.contextSha256], [PERSONA.sha256, brain.CONTEXT.sha256]);
  }
});

test("log kinds: the database accepts exactly LOG_KINDS (rows of log_kinds); a new kind is one idempotent insert", { skip }, async () => {
  const { LOG_KINDS } = await import("../src/log.ts");
  const rows = await sql<{ kind: string }[]>`select kind from log_kinds order by kind`;
  assert.deepEqual(rows.map((r) => r.kind), [...LOG_KINDS].sort());
  await assert.rejects(sql`select * from log_append('not-a-kind', null, '{}')`, /log_kind_fk/);
  for (let i = 0; i < 2; i++) await sql`insert into log_kinds (kind) values ('test-kind') on conflict do nothing`;
  const [r] = await sql<{ seq: string }[]>`select seq::text from log_append('test-kind', null, '{}')`;
  assert.ok(r.seq);
  await assert.rejects(sql`delete from log_kinds where kind = 'test-kind'`, /log_kind_fk/, "a kind in use stays");
});

test("Telegram /approve and /veto: a delayed record by seq, the owner's signature is the gate", { skip }, async () => {
  const [o1, stranger] = [1, 9].map((n) => privateKeyToAccount(`0x${n.toString(16).padStart(64, "0")}`));
  const owners = async () => [o1.address.toLowerCase()];
  const doc = { kind: "model-change", id: "x-voice:tg", role: "x-voice", from: "a", to: "b", effectiveAt: "2026-10-08T00:00:00.000Z" };
  const rec = await append("model-change", "x-voice", doc);
  const t = approve.targetOf(approve.rowOf("model-change", "x-voice", doc));
  const sig = (a: typeof o1) => a.signMessage({ message: { raw: `0x${approve.ownerDigest("veto", t)}` } });
  assert.match(await approve.ownerCommand("veto", [rec.seq, await sig(stranger)], owners), /not a Safe owner's veto signature/);
  assert.match(await approve.ownerCommand("veto", [rec.seq, await sig(o1)], owners), /^veto of model-change x-voice \(record \d+\) stored as record \d+$/);
  assert.match(await approve.ownerCommand("veto", [rec.seq, await sig(o1)], owners), /^already stored/);
  assert.equal((await approve.signaturesOf("veto", t)).length, 1);
  const plain = await append("alert", "x", { text: "not a delayed action" });
  assert.match(await approve.ownerCommand("veto", [plain.seq, await sig(o1)], owners), /is not a delayed action/);
  assert.equal(await approve.ownerCommand("veto", ["999999999", await sig(o1)], owners), "no signed record 999999999");
});

test("owner signatures: stored once per owner, read back distinct per signer by effective() and activeModel()", { skip }, async () => {
  const [o1, o2, o3, stranger] = [1, 2, 3, 9].map((n) => privateKeyToAccount(`0x${n.toString(16).padStart(64, "0")}`));
  const owners = async () => [o1, o2, o3].map((o) => o.address.toLowerCase());
  const doc = { kind: "model-change", id: "brain:x", role: "brain", from: "claude-fable-5-1", to: "claude-opus-5-5", effectiveAt: "2026-10-08T00:00:00.000Z", needApprovals: 2 };
  await append("model-change", "brain", doc);
  const [row] = await approve.trustedRows("model-change", "brain");
  assert.equal(row.body, approve.rowOf("model-change", "brain", doc).body, "the stored body text is what is signed over");
  const t = approve.targetOf(row);
  const sign = (a: typeof o1, kind: "approve" | "veto") => a.signMessage({ message: { raw: `0x${approve.ownerDigest(kind, t)}` } });
  await assert.rejects(approve.submitSignature("approve", t, await sign(stranger, "approve"), owners), /not a Safe owner/);
  assert.ok((await approve.submitSignature("approve", t, await sign(o1, "approve"), owners)).rec);
  assert.deepEqual(await approve.submitSignature("approve", t, await sign(o1, "approve"), owners), { signer: o1.address.toLowerCase(), rec: null }, "the same owner again: no new record");
  const deps = { ...approve.live, now: () => Date.parse("2026-10-09T00:00:00Z"), owners, paused: async () => false };
  assert.equal(await approve.effective(row, deps), false, "one approval of two");
  // a forged earlier row labelled as o2 (signed by someone else) neither counts for o2 nor hides o2's real signature
  await append("approve", approve.targetKey(t), { target: t, signature: await sign(stranger, "approve"), signer: o2.address.toLowerCase(), at: new Date().toISOString() });
  assert.equal(await approve.effective(row, deps), false, "the forged row is not o2's approval");
  assert.ok((await approve.submitSignature("approve", t, await sign(o2, "approve"), owners)).rec, "o2 can still sign");
  assert.equal(await approve.effective(row, deps), true);
  assert.equal(await swap.activeModel("brain", deps), "claude-opus-5-5");
  // 60 rows of o1's veto (written past the dedupe) can't push o3's veto out of the read
  const v1 = await sign(o1, "veto");
  for (let i = 0; i < 60; i++) await append("veto", approve.targetKey(t), { target: t, signature: v1, signer: o1.address.toLowerCase(), at: new Date().toISOString() });
  assert.equal(await approve.effective(row, deps), true, "one owner's vetoes, however many");
  await approve.submitSignature("veto", t, await sign(o3, "veto"), owners);
  assert.equal((await approve.signaturesOf("veto", t)).length, 2);
  assert.equal(await approve.effective(row, deps), false, "2 owners vetoed");
  assert.equal(await swap.activeModel("brain", deps), "claude-fable-5-1", "vetoed: the registry's model");
});
