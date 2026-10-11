// Model swaps. A swap starts from a tryout: the model the role runs now (activeModel) and the candidate each answer the
// role's golden set (engine/tryout/<role>/, src/tryout.ts); every case must pass. The proposal is a signed
// `model-change` record that takes effect one hour later (src/approve.ts: 2 owner vetoes or a paused agent stop it).
// The candidate's cost on the same golden set over the live model's is the projected change in the role's daily cost:
// above +20% the swap needs 2 owner approvals; a brain swap always does. The replaced model becomes the backup: the
// model a later swap can fall back to (there is no automatic failover).
import { approvalsNeeded, type Deps, effective, live, type Row, trustedRows } from "./approve.ts";
import { append } from "./log.ts";
import { REGISTRY, type Role, registryInfo } from "./models.ts";

export const SWAP_DELAY_MS = 3600_000;
export const MAX_COST_RISE = 1.2;

export type Tryout = { role: Role; model: string; setSha256: string; cases: number; failed: string[]; costUsd: number };
export type ModelChange = {
  kind: "model-change"; id: string; role: Role; from: string; to: string; backup: string; effectiveAt: string; needApprovals: number;
  costRatio: number | null; tryout: { current: Tryout; candidate: Tryout }; models: ReturnType<typeof registryInfo>; at: string;
};

const refuse = (why: string) => Object.assign(new Error(`model swap refused: ${why}`), { final: true });

/** The model-change record body for a passed tryout against `running`, the model the role runs now (activeModel). */
export function proposeSwap(current: Tryout, candidate: Tryout, running: string, now = Date.now()): ModelChange {
  const role = current.role;
  if (candidate.role !== role) throw refuse(`tryouts of two roles (${role}, ${candidate.role})`);
  if (current.model !== running) throw refuse(`the baseline tryout ran ${current.model}, the ${role} model is ${running}`);
  if (candidate.model === running) throw refuse(`${role} already runs ${running}`);
  if (candidate.setSha256 !== current.setSha256) throw refuse("the two tryouts ran different golden sets");
  if (candidate.cases === 0) throw refuse(`no golden set for ${role}`);
  if (candidate.failed.length) throw refuse(`${candidate.model} failed ${candidate.failed.join(", ")}`);
  // no baseline cost: the rise can't be shown to be ≤ 20%, so it needs the approvals
  const costRatio = current.costUsd > 0 ? Number((candidate.costUsd / current.costUsd).toFixed(4)) : null;
  const needApprovals = Math.max(approvalsNeeded({ kind: "model-change", role }), costRatio === null || costRatio > MAX_COST_RISE ? 2 : 0);
  return {
    kind: "model-change", id: `${role}:${new Date(now).toISOString()}`, role, from: running, to: candidate.model, backup: running,
    effectiveAt: new Date(now + SWAP_DELAY_MS).toISOString(), needApprovals, costRatio, tryout: { current, candidate }, models: registryInfo(), at: new Date(now).toISOString(),
  };
}

/** Publish a proposal as a signed `model-change` record (ref = the role). */
export const recordSwap = (c: ModelChange) => append("model-change", c.role, c);

/** The model a role runs now: the newest model-change in effect, else the registry's. */
export async function activeModel(role: Role, deps: Deps = live, rows: (role: Role) => Promise<Row[]> = (r) => trustedRows("model-change", r)) {
  for (const row of await rows(role)) {
    const c = JSON.parse(row.body) as Partial<ModelChange>;
    if (row.kind === "model-change" && row.ref === role && c.role === role && typeof c.to === "string" && (await effective(row, deps))) return c.to;
  }
  return REGISTRY.roles[role].model;
}
