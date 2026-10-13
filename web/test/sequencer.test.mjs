// /sequencer engine map: the story's order, and every id a beat, edge or phone step names exists in the graph.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BEATS, EDGES, NODES, TRACKS, rounded } from "../app/sequencer/graph.ts";
import { label, latest } from "../app/sequencer/now.ts";

const ids = new Set([...Object.keys(NODES), "brain", "gate"]);

test("the 9 beats keep their order", () => {
  assert.deepEqual(BEATS.map((b) => b.title), [
    "An idea arrives",
    "The brain decides to build",
    "The sequencer builds",
    "Back to the brain",
    "One public hour",
    "The fee loop",
    "Keep it, or roll it back",
    "Games and announcements",
    "Where the money goes",
  ]);
  assert.equal(BEATS.at(-1).money, true, "the money beat is last, so hiding money never reorders the rest");
});

test("every beat's edges and nodes exist", () => {
  for (const b of BEATS) {
    assert.ok(b.edges.length, b.title);
    for (const e of b.edges) assert.ok(e in EDGES, `${b.title}: edge ${e}`);
    for (const n of b.nodes) assert.ok(ids.has(n), `${b.title}: node ${n}`);
  }
});

test("a beat lights the brain or the gate exactly when one of its edges touches it", () => {
  for (const b of BEATS) for (const box of ["brain", "gate"]) {
    assert.equal(!!b[box], b.edges.some((e) => EDGES[e].from === box || EDGES[e].to === box), `${b.title}: ${box}`);
  }
});

test("every edge connects nodes that exist and is orthogonal", () => {
  for (const [id, e] of Object.entries(EDGES)) {
    assert.ok(ids.has(e.from), `${id}: from ${e.from}`);
    assert.ok(ids.has(e.to), `${id}: to ${e.to}`);
    for (let i = 1; i < e.p.length; i++) {
      const [[x1, y1], [x2, y2]] = [e.p[i - 1], e.p[i]];
      assert.ok(x1 === x2 || y1 === y2, `${id}: segment ${i} is not horizontal or vertical`);
    }
  }
});

test("phone tracks: four tabs, node steps exist, each track passes the public hour", () => {
  assert.deepEqual(TRACKS.map((t) => t.name), ["Build", "Fee loop", "Games", "Money"]);
  for (const t of TRACKS) {
    for (const s of t.steps) if (s.kind === "node") assert.ok(s.id in NODES, `${t.name}: ${s.id}`);
    assert.ok(t.steps.some((s) => s.kind === "gate"), `${t.name}: no public-hour gate`);
  }
});

test("the games row is jackpot, idea rewards, mystery, vote; idea rewards are fed 30% by the pot and paid when a build ships", () => {
  const row = Object.values(NODES).filter((n) => n.y === NODES.rewards.y).sort((a, b) => a.x - b.x);
  assert.deepEqual(row.map((n) => n.label), ["Jackpot", "Idea rewards", "Mystery", "Vote"]);
  const into = Object.values(EDGES).filter((e) => e.to === "rewards");
  assert.ok(into.some((e) => e.from === "pot" && e.label === "30%"), "pot → rewards, 30%");
  assert.ok(into.some((e) => e.from === "deploy" && e.label === "reward"), "shipped build → rewards");
  assert.equal(NODES.pot.text, "Feeds the jackpot (70%) and idea rewards (30%).");
});

test("game-row nodes do not overlap", () => {
  const row = Object.values(NODES).filter((n) => n.y === NODES.rewards.y).sort((a, b) => a.x - b.x);
  for (let i = 1; i < row.length; i++) assert.ok(row[i - 1].x + row[i - 1].w < row[i].x, `${row[i - 1].label} overlaps ${row[i].label}`);
});

test("right now: chain events get a short label and their box on the map", () => {
  assert.deepEqual(label("proposal #12 queued · SetParams"), { text: "Change #12 queued (SetParams), waits the public hour", node: "gate" });
  assert.deepEqual(label("fees distributed · 0.42 ETH"), { text: "Fees split · 0.42 ETH", node: "fee" });
  assert.deepEqual(label("buyback 0.15 ETH · burned 1.2M DNA"), { text: "Bought back with 0.15 ETH · burned 1.2M DNA", node: "burn" });
  assert.deepEqual(label("auto-liquidity added · 0.13 ETH"), { text: "Liquidity added · 0.13 ETH", node: "lp" });
  assert.deepEqual(label("module activated"), { text: "Module promoted to active", node: "livehook" });
  assert.deepEqual(label("canary deployment started"), { text: "Live test started", node: "livetest" });
  assert.deepEqual(label("queued op #3 cancelled by the Safe"), { text: "The Safe cancelled change #3", node: "safe" });
  assert.deepEqual(label("something new"), { text: "Something new.", node: null }, "unknown: the /live sentence, no box");
  for (const t of ["testing new configuration", "rollback executed", "canary ended · 0xab…cd back to proposed", "autonomy level 1 → 2", "agent paused by the Safe", "agent unpaused"]) {
    assert.ok(ids.has(label(t).node), t);
  }
});

test("right now: keeps the newest chain events in block order, ignores swaps, engine notes and sample lines", () => {
  const l = (id) => ({ id, time: "12:00", text: "x", tone: "plain" });
  const log = [l("100:2"), l("h:101:swaps"), l("e:9"), l("99:5"), l("101:0"), l(4)];
  assert.deepEqual(latest([], log).map((x) => x.id), ["99:5", "100:2", "101:0"]);
  // swaps pushed them out of the log: still kept; replays dedupe by id; log index 10 sorts after 9
  assert.deepEqual(latest(latest([], log), [l("h:102:swaps"), l("101:0"), l("102:10"), l("102:9")]).map((x) => x.id), ["101:0", "102:9", "102:10"]);
});

test("rounded corners", () => {
  assert.equal(rounded([[0, 0], [10, 0]]), "M0,0 L10,0");
  assert.equal(rounded([[0, 0], [40, 0], [40, 40]]), "M0,0 L31,0 Q40,0 40,9 L40,40");
});

test("the fee split reads the same on the desktop map and the phone track (35/30/25/10)", () => {
  assert.deepEqual([NODES.burn.label, NODES.lp.label, NODES.treasury.label, NODES.pot.label], ["Buyback & burn 35%", "Liquidity 30%", "Treasury 25%", "Games pot 10%"]);
  const money = TRACKS.find((t) => t.name === "Money").steps.filter((s) => s.kind === "node");
  const note = (id) => money.find((s) => s.id === id).note;
  assert.deepEqual([note("burn"), note("lp"), note("treasury")], ["35%", "30%", "25%"]);
  assert.match(note("pot"), /^10% /);
});
