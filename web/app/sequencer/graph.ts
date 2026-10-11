// The /sequencer engine map: lanes, nodes, edges, the 9-beat story and the phone tracks, in the board's 1440-wide viewBox.
// The "now" lines are illustrations, shown in mock mode only (LIVE has the Right now strip). web/test/sequencer.test.mjs pins the structure.
import { FEE } from "../_data/launchFee.ts";

/** One colour per meaning; the board maps each to a CSS variable (sequencer.module.css). */
export type Tone = "ai" | "idea" | "dev" | "game" | "guard" | "money";
export const TONES: Tone[] = ["ai", "idea", "dev", "game", "guard", "money"];

export type Info = { label: string; tone: Tone; text: string; now: string };
export type Node = Info & { x: number; y: number; w: number; chip?: string; money?: true };
type Pt = [number, number];

export const NODES = {
  xideas: { x: 40, y: 64, w: 118, label: "Ideas on X", tone: "idea", text: "Anyone can post an idea to @contractdna.", now: "“A game where holders defend a price floor together.”" },
  intake: { x: 186, y: 64, w: 178, label: "Intake screen", chip: "SEALED", tone: "idea", text: "A sealed reader turns each post into a plain spec and drops anything that reads like an instruction. Junk is rejected with a public reason.", now: "14 posts today: 3 specs, 11 rejected (reasons public)." },
  market: { x: 420, y: 64, w: 150, label: "Idea market", tone: "idea", text: "Holders stake DNA on the ideas they back. Each round closes after 24 hours.", now: "Round 41 closed: 16 ideas." },
  data: { x: 600, y: 64, w: 150, label: "Market data", tone: "idea", text: "Every swap, fee and price move in the pool. Read every 15 minutes.", now: "Volatility up 18% this hour." },
  xposts: { x: 1230, y: 96, w: 170, label: "Posts on X", tone: "ai", text: "Short, plain-English announcements, each with a link to its proof. At most 15 a day.", now: "“Floor Defense is live. Proof →”" },
  notebook: { x: 1230, y: 206, w: 170, label: "Signed log", tone: "ai", text: "Every decision is signed inside a sealed machine and published. Anyone can check it wasn't edited later.", now: "Decision #2,184 signed." },
  redteam: { x: 400, y: 272, w: 130, label: "Red team", tone: "ai", text: "A second model attacks every proposal before it's queued, and again before it touches real trades.", now: "Passed: no finding." },
  shadow: { x: 780, y: 272, w: 150, label: "Shadow", chip: "2 H", tone: "ai", text: "For 2 hours the new fee is worked out on every 10th trade, never charged.", now: "Base 2.0%, ceiling 3.0%." },
  livetest: { x: 950, y: 272, w: 170, label: "Live test", chip: "4 H", tone: "ai", text: "Then it handles 1 in 6 blocks of real trades for 4 hours. Stop rules end it at once.", now: "212 trades, no stop rule hit." },
  livehook: { x: 780, y: 332, w: 200, label: "Live hook · DNA pool", tone: "ai", text: `The fee every trade pays. The hook itself is fixed forever; only its settings change, under a hard ${FEE.cap} cap.`, now: "Fee 2.2% → 2.1%." },
  lead: { x: 40, y: 432, w: 86, label: "Lead", tone: "dev", text: "Plans the build from the approved spec. Never sees the raw post.", now: "Plan: contract, page, 41 tests." },
  workers: { x: 146, y: 432, w: 96, label: "Workers", tone: "dev", text: "Several fast models write the contract, the page and the tests in parallel.", now: "5 workers." },
  tester: { x: 262, y: 432, w: 86, label: "Tester", tone: "dev", text: "Tries to break it: fuzzing, a copy of mainnet, planted bugs it must catch.", now: "Round 1: 2 bugs found." },
  fixer: { x: 408, y: 432, w: 86, label: "Fixer", tone: "dev", text: "Fixes every finding, then the tester runs again. At most 3 rounds, or the build is dropped.", now: "Round 2: all tests pass." },
  review: { x: 514, y: 432, w: 86, label: "Review", tone: "dev", text: "A reviewer checks the whole build, opens a public pull request and sends it to the brain.", now: "PR opened." },
  deploy: { x: 780, y: 512, w: 160, label: "Sealed deploy", tone: "dev", text: "The sealed engine checks the approved commit, compiles it itself and deploys. No wallet key ever lives on GitHub.", now: "Deployed and verified." },
  newgame: { x: 970, y: 490, w: 180, label: "New game", chip: "MAX 3", tone: "game", text: "Up to three new games live at once. One with no players for 2 days is retired and its money goes back to the Safe.", now: "Floor Defense: 140 players." },
  site: { x: 970, y: 536, w: 180, label: "Its page on the site", tone: "dev", text: "Each new game gets its own page. A page can only ask your wallet to call its own game.", now: "/play/floor-defense" },
  jackpot: { x: 770, y: 634, w: 96, label: "Jackpot", tone: "game", text: "10 winners per draw, split equally, picked by on-chain randomness.", now: "Draw 12: 0.31 ETH each." },
  rewards: { x: 878, y: 634, w: 120, label: "Idea rewards", tone: "game", text: "ETH for people whose idea ships, or whose fee idea is kept after its test. The brain sets the amount, and every payment waits one public hour.", now: "0.2 ETH to the author of Floor Defense." },
  mystery: { x: 1010, y: 634, w: 96, label: "Mystery", tone: "game", text: "A fee mutation sealed on-chain two days before it opens. Nobody can swap it.", now: "Opens in 2 days." },
  vote: { x: 1118, y: 634, w: 96, label: "Vote", tone: "game", text: "Every two days, three fee mutations on a ballot. Stakers vote.", now: "61% for option B." },
  safe: { x: 640, y: 716, w: 160, label: "Safe", chip: "VETO", tone: "guard", text: "The project's 2-of-3 multisig. Any two signers can cancel anything in the public hour. It can pause the AI, and it must sign new hook code.", now: "No veto this week." },
  trade: { x: 40, y: 804, w: 140, label: "Every trade", tone: "money", money: true, text: "Each buy or sell in the pool pays the fee.", now: "1,284 trades today." },
  fee: { x: 210, y: 804, w: 140, label: `Fee ${FEE.ours}`, tone: "money", money: true, text: `DNA's fee. Programmable's ${FEE.platform} launchpad fee is on top and is not ours.`, now: "3.1 ETH today." },
  treasury: { x: 380, y: 804, w: 130, label: "Treasury 30%", tone: "money", money: true, text: "Goes to the Safe. New games are funded from here, inside a published limit, through the public hour.", now: "0.1 ETH to Floor Defense." },
  pot: { x: 790, y: 804, w: 132, label: "Games pot 0%", tone: "money", money: true, text: "Feeds the jackpot (70%) and idea rewards (30%). Games share turns on later.", now: "3.1 ETH in the pot." },
  burn: { x: 955, y: 804, w: 170, label: "Buyback & burn 35%", tone: "money", money: true, text: "Buys DNA and burns it.", now: "1.09 ETH burned." },
  lp: { x: 1140, y: 804, w: 140, label: "Liquidity 35%", tone: "money", money: true, text: "Added to the pool automatically.", now: "0.93 ETH added." },
} satisfies Record<string, Node>;

export type NodeId = keyof typeof NODES | "brain" | "gate";

export const BRAIN = { x: 40, y: 128, w: 1140, h: 64 };
export const GATE = { x: 700, y: 236, w: 40, h: 434 };
/** The two boxes that are not ordinary nodes, for the side panel. */
export const INFO: Record<"brain" | "gate", Info> = {
  brain: { label: "Brain", tone: "ai", text: "One model that knows the whole project and its limits. It decides what to build, what ships, what retires and who gets rewarded, and signs each decision in a sealed machine.", now: "Build Floor Defense; test a 2.0% base fee." },
  gate: { label: "Public hour", tone: "guard", text: "Every change, deploy, game funding and idea reward waits one public hour. Two of the Safe's three signers can cancel it. If nobody does, it goes ahead.", now: "Floor Defense deploy: 41 min left to veto." },
};
export const info = (id: NodeId): Node | Info => (id === "brain" || id === "gate" ? INFO[id] : NODES[id]);

/** Lane titles (left column) and the hairlines between lanes. */
export const LANES: { title: string; y: number; sub?: string; x?: number; money?: true }[] = [
  { title: "INPUTS", y: 30 },
  { title: "PUBLIC", y: 56, x: 1230 },
  { title: "FEE LOOP", y: 250, sub: "tunes the live hook" },
  { title: "SEQUENCER · DEV TEAM", y: 398 },
  { title: "GAMES", y: 592, sub: "rounds inside contract limits" },
  { title: "MONEY", y: 776, money: true },
];
export const RULES: { y: number; money?: true }[] = [{ y: 224 }, { y: 380 }, { y: 572 }, { y: 680 }, { y: 752, money: true }];
export const HEIGHT = { money: 880, plain: 760 };

/**
 * An orthogonal edge: polyline `p`, drawn with rounded corners. `label` sits on segment `at` (default 0), nudged by
 * `above`/`below`/`side`/`ly`. `bus`: a shared trunk that other edges branch off (no arrowhead). `money`: the money layer.
 */
export type Edge = {
  from: NodeId; to: NodeId; p: Pt[]; tone: Tone;
  dash?: true; label?: string; at?: number; side?: true; above?: true; below?: true; ly?: number; money?: true; bus?: true;
};

export const EDGES = {
  e_x_in: { from: "xideas", to: "intake", p: [[158, 64], [186, 64]], tone: "idea" },
  e_in_b: { from: "intake", to: "brain", p: [[275, 83], [275, 128]], tone: "idea", label: "spec" },
  e_mk_b: { from: "market", to: "brain", p: [[495, 83], [495, 128]], tone: "idea" },
  e_dt_b: { from: "data", to: "brain", p: [[675, 83], [675, 128]], tone: "idea" },
  e_b_x: { from: "brain", to: "xposts", p: [[1180, 140], [1205, 140], [1205, 96], [1230, 96]], tone: "ai", label: "post", at: 1, side: true },
  e_b_nb: { from: "brain", to: "notebook", p: [[1180, 180], [1205, 180], [1205, 206], [1230, 206]], tone: "ai", label: "signed", at: 1, side: true },
  e_prop: { from: "brain", to: "redteam", p: [[465, 192], [465, 253]], tone: "ai", label: "propose" },
  e_rt_g: { from: "redteam", to: "gate", p: [[530, 272], [700, 272]], tone: "ai" },
  e_g_sh: { from: "gate", to: "shadow", p: [[740, 272], [780, 272]], tone: "ai" },
  e_sh_lt: { from: "shadow", to: "livetest", p: [[930, 272], [950, 272]], tone: "ai" },
  e_res: { from: "livetest", to: "brain", p: [[1035, 253], [1035, 192]], tone: "ai", label: "results" },
  e_keep: { from: "brain", to: "gate", p: [[655, 192], [655, 332], [700, 332]], tone: "ai", label: "keep", at: 1, below: true },
  e_g_lh: { from: "gate", to: "livehook", p: [[740, 332], [780, 332]], tone: "ai" },
  e_rb: { from: "brain", to: "livehook", p: [[1150, 192], [1150, 332], [980, 332]], tone: "ai", dash: true, label: "roll back · instant", at: 1 },
  e_spec: { from: "brain", to: "lead", p: [[83, 192], [83, 413]], tone: "ai", label: "spec" },
  e_ld_wk: { from: "lead", to: "workers", p: [[126, 432], [146, 432]], tone: "dev" },
  e_wk_ts: { from: "workers", to: "tester", p: [[242, 432], [262, 432]], tone: "dev" },
  e_ts_fx: { from: "tester", to: "fixer", p: [[348, 425], [408, 425]], tone: "dev", label: "bugs", above: true },
  e_fx_ts: { from: "fixer", to: "tester", p: [[408, 439], [348, 439]], tone: "dev", label: "retest · max 3", below: true },
  e_fx_rv: { from: "fixer", to: "review", p: [[494, 432], [514, 432]], tone: "dev" },
  e_verdict: { from: "review", to: "brain", p: [[557, 451], [557, 472], [20, 472], [20, 160], [40, 160]], tone: "dev", label: "for verdict", at: 1 },
  e_approve: { from: "brain", to: "gate", p: [[635, 192], [635, 512], [700, 512]], tone: "ai", label: "approve" },
  e_g_dp: { from: "gate", to: "deploy", p: [[740, 512], [780, 512]], tone: "dev" },
  e_dp_ng: { from: "deploy", to: "newgame", p: [[940, 512], [955, 512], [955, 490], [970, 490]], tone: "dev" },
  e_dp_st: { from: "deploy", to: "site", p: [[955, 512], [955, 536], [970, 536]], tone: "dev" },
  e_params: { from: "brain", to: "gate", p: [[615, 192], [615, 612], [700, 612]], tone: "ai", label: "game params", ly: 592 },
  e_g_gm: { from: "gate", to: "vote", p: [[740, 612], [758, 612], [758, 600], [1166, 600]], tone: "game", bus: true },
  e_d_jp: { from: "gate", to: "jackpot", p: [[818, 600], [818, 615]], tone: "game" },
  e_d_rw: { from: "gate", to: "rewards", p: [[938, 600], [938, 615]], tone: "game" },
  e_d_my: { from: "gate", to: "mystery", p: [[1058, 600], [1058, 615]], tone: "game" },
  e_d_vt: { from: "gate", to: "vote", p: [[1166, 600], [1166, 615]], tone: "game" },
  e_dp_rw: { from: "deploy", to: "rewards", p: [[900, 531], [900, 615]], tone: "dev", label: "reward", ly: 552 },
  e_veto: { from: "safe", to: "gate", p: [[720, 697], [720, 670]], tone: "guard", label: "veto", side: true },
  e_tr_fee: { from: "trade", to: "fee", p: [[180, 804], [210, 804]], tone: "money", money: true },
  e_split: { from: "fee", to: "lp", p: [[280, 823], [280, 846], [1200, 846]], tone: "money", money: true, bus: true },
  e_s_tr: { from: "fee", to: "treasury", p: [[445, 846], [445, 823]], tone: "money", money: true },
  e_s_pot: { from: "fee", to: "pot", p: [[850, 846], [850, 823]], tone: "money", money: true },
  e_s_bn: { from: "fee", to: "burn", p: [[1035, 846], [1035, 823]], tone: "money", money: true },
  e_s_lp: { from: "fee", to: "lp", p: [[1200, 846], [1200, 823]], tone: "money", money: true },
  e_fund_in: { from: "treasury", to: "gate", p: [[445, 785], [445, 652], [700, 652]], tone: "money", money: true, label: "funding", at: 1 },
  e_fund_out: { from: "gate", to: "newgame", p: [[740, 458], [1165, 458], [1165, 490], [1150, 490]], tone: "money", money: true },
  e_pot_jp: { from: "pot", to: "jackpot", p: [[850, 785], [850, 692], [818, 692], [818, 653]], tone: "money", money: true, label: "70%" },
  e_pot_rw: { from: "pot", to: "rewards", p: [[850, 692], [938, 692], [938, 653]], tone: "money", money: true, label: "30%" },
} satisfies Record<string, Edge>;

export type EdgeId = keyof typeof EDGES;

/** The story, in order. `brain`/`gate`: that box lights up too. `money`: hidden with the money layer. */
export type Beat = { title: string; text: string; edges: EdgeId[]; nodes: NodeId[]; brain?: true; gate?: true; money?: true };

export const BEATS: Beat[] = [
  { title: "An idea arrives", text: "A post on X becomes a plain spec. Anything that reads like an instruction is dropped, and junk gets a public reason.", edges: ["e_x_in", "e_in_b"], nodes: ["xideas", "intake"], brain: true },
  { title: "The brain decides to build", text: "It scores the idea 24 / 30, sends the spec to its dev team, and signs the decision into the public log.", edges: ["e_spec", "e_b_nb"], nodes: ["lead", "notebook"], brain: true },
  { title: "The dev team builds", text: "Workers write the contract, the page and the tests. The tester attacks it, the fixer repairs it. Round 2 of 3: everything passes.", edges: ["e_ld_wk", "e_wk_ts", "e_ts_fx", "e_fx_ts", "e_fx_rv"], nodes: ["lead", "workers", "tester", "fixer", "review"] },
  { title: "Back to the brain", text: "The finished build goes back to the brain, which gives the final verdict. Nothing the team builds ships on its own say-so.", edges: ["e_verdict"], nodes: ["review"], brain: true },
  { title: "One public hour", text: "The brain approves. The deploy and its funding wait one public hour, and two Safe signers can cancel. No veto: the sealed engine deploys it.", edges: ["e_approve", "e_g_dp", "e_dp_ng", "e_dp_st", "e_veto", "e_fund_in", "e_fund_out"], nodes: ["deploy", "newgame", "site", "safe", "treasury"], gate: true, brain: true },
  { title: "The fee loop", text: "Meanwhile the fee loop proposes a new fee: a red-team check, the public hour, 2 hours on paper, 4 hours on real trades. Fixed rules judge the result.", edges: ["e_prop", "e_rt_g", "e_g_sh", "e_sh_lt", "e_res"], nodes: ["redteam", "shadow", "livetest"], gate: true, brain: true },
  { title: "Keep it, or roll it back", text: "It worked, so it's promoted through the public hour again. The Safe signs this step until level 8. Had it failed, rollback is instant.", edges: ["e_keep", "e_g_lh", "e_rb"], nodes: ["livehook"], gate: true, brain: true },
  { title: "Games and announcements", text: "The AI sets each game round inside its contract limits, the brain rewards the people whose idea shipped, and every result goes to X with proof.", edges: ["e_params", "e_g_gm", "e_d_jp", "e_d_rw", "e_dp_rw", "e_d_my", "e_d_vt", "e_b_x", "e_pot_jp", "e_pot_rw"], nodes: ["jackpot", "rewards", "mystery", "vote", "xposts", "pot"], gate: true, brain: true },
  { title: "Where the money goes", text: "Every trade pays the fee: 35% buys and burns DNA, 35% deepens liquidity, 30% goes to the treasury. Games share turns on later.", edges: ["e_tr_fee", "e_split", "e_s_tr", "e_s_pot", "e_s_bn", "e_s_lp"], nodes: ["trade", "fee", "treasury", "pot", "burn", "lp"], money: true },
];

/** Phone: the same story as four vertical tracks. A step is a node (optionally relabelled), a public-hour gate, or a loop back to the brain. */
export type Step =
  | { kind: "node"; id: keyof typeof NODES; label?: string; note?: string }
  | { kind: "gate"; note: string }
  | { kind: "loop"; label: string };
export type Track = { name: "Build" | "Fee loop" | "Games" | "Money"; caption: string; steps: Step[]; money?: true };

const gate = (note: string): Step => ({ kind: "gate", note });
const loop = (label: string): Step => ({ kind: "loop", label });

export const TRACKS: Track[] = [
  { name: "Build", caption: "Ideas become games", steps: [
    { kind: "node", id: "xideas" }, { kind: "node", id: "intake", note: "sealed" }, loop("To the brain as a spec"), loop("The brain decides to build"),
    { kind: "node", id: "lead" }, { kind: "node", id: "workers" }, { kind: "node", id: "tester", note: "finds bugs" }, { kind: "node", id: "fixer", note: "max 3 rounds" },
    { kind: "node", id: "review" }, loop("Back to the brain for its verdict"), gate("Two Safe signers can cancel the deploy and its funding"),
    { kind: "node", id: "deploy" }, { kind: "node", id: "newgame", note: "max 3 live" }, { kind: "node", id: "site" },
    { kind: "node", id: "rewards", note: "the brain may pay its author" },
  ] },
  { name: "Fee loop", caption: "The live hook learns", steps: [
    loop("The fee loop proposes a fee"), { kind: "node", id: "redteam" }, gate("The Safe can cancel"), { kind: "node", id: "shadow", note: "2 h" }, { kind: "node", id: "livetest", note: "4 h" },
    loop("Fixed rules judge the result"), gate("Keeping it waits again"), { kind: "node", id: "livehook", note: "roll back is instant" },
  ] },
  { name: "Games", caption: "Rounds inside contract limits", steps: [
    loop("The AI sets game params"), gate("The Safe can cancel"), { kind: "node", id: "jackpot", note: "10 winners" }, { kind: "node", id: "rewards", note: "after 1 public hour" },
    { kind: "node", id: "mystery" }, { kind: "node", id: "vote" }, loop("The brain posts on X, with proof"), { kind: "node", id: "xposts" },
  ] },
  { name: "Money", caption: "Where every fee goes", money: true, steps: [
    { kind: "node", id: "trade" }, { kind: "node", id: "fee", note: `+${FEE.platform} Programmable` }, { kind: "node", id: "burn", label: "Buyback & burn", note: "35%" },
    { kind: "node", id: "lp", label: "Liquidity", note: "35%" }, { kind: "node", id: "treasury", label: "Treasury", note: "30%" }, gate("Funding for new games"),
    { kind: "node", id: "newgame", label: "New games" }, { kind: "node", id: "pot", label: "Games pot", note: "0% now · jackpot 70%, idea rewards 30%" },
  ] },
];

/** SVG path for an orthogonal polyline with rounded corners (radius r, shrunk on short segments). */
export function rounded(pts: Pt[], r = 9): string {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i === pts.length - 1) { d += ` L${x},${y}`; break; }
    const [px, py] = pts[i - 1], [nx, ny] = pts[i + 1];
    const k = Math.min(r, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    d += ` L${x - Math.sign(x - px) * k},${y - Math.sign(y - py) * k} Q${x},${y} ${x + Math.sign(nx - x) * k},${y + Math.sign(ny - y) * k}`;
  }
  return d;
}

/** Centre of an edge's label chip. */
export function labelAt(e: Edge): Pt {
  const i = e.at ?? 0, [x1, y1] = e.p[i], [x2, y2] = e.p[i + 1];
  let x = (x1 + x2) / 2, y = e.ly ?? (y1 + y2) / 2;
  if (e.above) y -= 11;
  if (e.below) y += 13;
  if (e.side && x1 === x2) x += 26;
  return [x, y];
}
