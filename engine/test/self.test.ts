// The self-file: built from code constants, the chain and signed log rows only; the same facts give the same bytes;
// character memory (posts, people, jokes, mood) never reaches it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Row, SELF_KINDS, SELF_N, selfText } from "../src/self.ts";

const day = "2026-10-20";
const at = (d: string) => `${d}T12:00:00.000Z`;
let n = 100;
const row = (kind: string, ref: string, doc: Record<string, unknown>, d = "2026-10-19"): Row => ({ seq: String(n++), kind, ref, at: at(d), doc });

// brain decisions, each followed (or not) by what the signed log shows happened next
const build = row("brain", "build:build:q7", { kind: "build", decision: { decision: "build", reason: "fits", risks: [] } });
const noBuild = row("brain", "build:build:q8", { kind: "build", decision: { decision: "no-build", reason: "no test plan", risks: [] } });
const verdict = row("brain", "verdict:verdict:b20261019-7-r1", { kind: "verdict", decision: { verdict: "ship", reason: "all gates passed", issues: [] } });
const ship = row("ship", "ship:b20261019-7", { kind: "ship", build: "b20261019-7", idea: "q7", verdictSeq: verdict.seq, effectiveAt: at("2026-10-19") });
const release = row("release", "release:abc", { kind: "release", sha: "abc", build: "b20261019-7", effectiveAt: at("2026-10-19") });
const retire = row("brain", "retire:0xgame:2026-10-19", { kind: "retire", decision: { retire: true, reason: "idle" } });
const retireRec = row("retire", "retire:0xgame", { kind: "retire", game: "0xgame", brain: retire.seq, effectiveAt: at("2026-10-19") });
const reward = row("brain", "reward:reward:idea:3", { kind: "reward", decision: { amountEth: 0.05, reason: "kept" } });
const rewardRec = row("reward", "idea:3", { kind: "reward", to: "0x00000000000000000000000000000000000000aa", amount: "50000000000000000", brain: reward.seq });
const outcome = row("brain", "outcome:round:4", { kind: "outcome", decision: { ideas: [{ decision: "accept" }, { decision: "reject" }, { decision: "reject" }, { decision: "void" }] } });
const verdict2 = row("brain", "verdict:verdict:b20261019-9-r1", { kind: "verdict", decision: { verdict: "ship", reason: "ok", issues: [] } });
const ship2 = row("ship", "ship:b20261019-9", { kind: "ship", build: "b20261019-9", idea: "q9", verdictSeq: verdict2.seq, effectiveAt: at("2026-10-19") });
const cancel = row("ship-cancel", "ship:b20261019-9", { kind: "ship-cancel", build: "b20261019-9", ship: ship2.seq, why: "page check failed" });
// open risks
const secOld = row("security", "R1", { id: "R1", kind: "red-team", title: "canary band edge", severity: "medium", status: "open" }, "2026-09-01");
const secNew = row("security", "R1", { id: "R1", kind: "red-team", title: "canary band edge", severity: "medium", status: "resolved" }, "2026-10-01");
const secOpen = row("security", "R2", { id: "R2", kind: "red-team", title: "stale price feed", severity: "high", status: "open" }, "2026-09-02");
const kill = row("page-kill", "dice-9", { kind: "page-kill", slug: "dice-9", why: "G15" });
const rolled = row("memory", "mem-3", { id: 3, title: "flat 2.4% fee", decision: "rolled_back" });
const oldKill = row("page-kill", "coin-1", { kind: "page-kill", slug: "coin-1", why: "G15" }, "2026-09-01"); // older than a week
// character memory a careless reader might pick up: never in the self-file
const post = row("x_post", "p1", { text: "a post about fees", mood: "upbeat", joke: "running-gag", authorId: "12345" });
const tone = row("tone", "2026-10-19", { brief: "spicy" });

const rows = [build, noBuild, verdict, ship, release, retire, retireRec, reward, rewardRec, outcome, verdict2, ship2, cancel, secOld, secNew, secOpen, kill, rolled, oldKill, post, tone];
const facts = { day, chain: { level: 5, paused: false }, rows };

test("self-file: deterministic from the same facts, whatever order the rows come in", () => {
  const a = selfText(facts);
  assert.equal(selfText(structuredClone(facts)), a);
  assert.equal(selfText({ ...facts, rows: [...rows].reverse() }), a);
  assert.match(a, /^# DNA: self-file\n/);
  for (const h of ["## What I can do", "## What I can't do", `## My last ${SELF_N} decisions and what came of them`, "## Open risks"]) assert.ok(a.includes(`\n${h}\n`), h);
  assert.match(a, /Autonomy level 5 of 10/);
  assert.match(a, new RegExp(day));
});

test("self-file: can and can't come from code constants and the chain's level", () => {
  const a = selfText(facts);
  assert.match(a, /5\.00%/, "the hook's fee cap");
  assert.match(a, /shadow a candidate fee module, canary it/, "level 5 ops");
  assert.doesNotMatch(a, /promote a canary/, "level 8 ops are not mine at 5");
  // true on either hook: a module's fee never passes 5%; only a launch guard's own launch tax does, in its first blocks
  assert.match(a, /the hook never charges a module's project fee above 5\.00%; a hook with the launch guard charges its fixed launch tax \(90% stepping down to 10%, all of it to buyback-and-burn\) in the pool's first 9 blocks only/);
  assert.match(a, /Set or charge a project fee above 5\.00%/);
  assert.doesNotMatch(a, /never charges a project fee above/);
  assert.match(selfText({ ...facts, chain: { level: 8, paused: false } }), /promote a canary/);
  assert.match(selfText({ ...facts, chain: { level: 3, paused: false } }), /no registry ops/);
  assert.match(selfText({ ...facts, chain: { level: null, paused: null } }), /level could not be read/);
  assert.match(a, /Change the hook or the token/);
  assert.match(a, /the sequencer takes the ideas I accept from X or the idea market \(a game, a fee module or a page on the site\)/);
  assert.match(a, /Change my own code: an update lands only after an owner merges it/);
  assert.doesNotMatch(a, /## What my latest update changed/, "no notes: no section");
  assert.match(selfText({ ...facts, update: ["Site pages block any script the site did not put there"] }), /\n## What my latest update changed\n- Site pages block any script the site did not put there\n/);
});

test("self-file: each decision with what the signed log shows came of it", () => {
  const a = selfText(facts);
  const line = (r: Row) => a.split("\n").find((l) => l.includes(`#${r.seq} `)) ?? "";
  assert.match(line(build), /build q7: build\. After: ship record #\d+, released/);
  assert.match(line(noBuild), /build q8: no-build\. After: nothing recorded yet/);
  assert.match(line(verdict), /verdict b20261019-7-r1: ship\. After: ship record #\d+, released/);
  assert.match(line(verdict2), /ship\. After: ship record #\d+, stopped before release/);
  assert.match(line(retire), /retire 0xgame:2026-10-19: retire\. After: retire record #\d+/);
  assert.match(line(reward), /reward idea:3: 0\.05 ETH\. After: reward record #\d+: 0\.05 ETH/);
  assert.match(line(outcome), /outcome round:4: 1 accepted, 2 rejected, 1 void/);
  assert.doesNotMatch(a, /0x0{38}aa/, "no wallet addresses");
  assert.doesNotMatch(a, /all gates passed|no test plan/, "the brain's free-text reasons stay in their records");
});

test("self-file: only the last N decisions, newest first", () => {
  const many = Array.from({ length: SELF_N + 5 }, (_, i) => row("brain", `retire:g${i}:d`, { kind: "retire", decision: { retire: false, reason: "busy" } }));
  const a = selfText({ ...facts, rows: many });
  const lines = a.split("\n").filter((l) => / retire g\d+:d: keep\./.test(l));
  assert.equal(lines.length, SELF_N);
  assert.match(lines[0], new RegExp(`#${many.at(-1)!.seq} `));
  assert.ok(!a.includes(`#${many[0].seq} `), "the oldest fell off");
  assert.match(selfText({ ...facts, rows: [] }), /## My last \d+ decisions and what came of them\nNone yet\./);
});

test("self-file: open risks from the chain and the signed log", () => {
  const a = selfText({ ...facts, chain: { level: 5, paused: true } });
  const risks = a.slice(a.indexOf("## Open risks"));
  assert.match(risks, /The Safe has paused me/);
  assert.match(risks, /R2 \(high\): stale price feed/);
  assert.doesNotMatch(risks, /R1/, "a resolved item is not a risk");
  assert.match(risks, /page of dice-9 pulled/);
  assert.doesNotMatch(risks, /coin-1/, "older than a week");
  assert.match(risks, /ship of b20261019-9 stopped/);
  assert.match(risks, /fee experiment rolled back: flat 2\.4% fee/);
  assert.match(selfText({ ...facts, rows: [] }), /## Open risks\nNone recorded\./);
});

test("self-file: no character memory, by construction", () => {
  const a = selfText(facts);
  assert.doesNotMatch(a, /a post about fees|upbeat|running-gag|12345|spicy/i, "nothing from posts or the tone brief");
  for (const k of ["x_post", "tone", "draft", "announce", "journal", "intake", "binding", "thread", "step", "core"]) assert.ok(!(SELF_KINDS as readonly string[]).includes(k), k);
  const src = readFileSync(new URL("../src/self.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from "\.\/(voice|x|character|telegram|announce|card|studio)\.ts"/, "no writer-side module");
  assert.doesNotMatch(src, /\b(posts?|people|jokes?|mood|outbox|mention)\b/i, "no character tables or fields");
});
