// A model tryout from the command line (the logic: src/tryout.ts).
//   node scripts/tryout.ts <role> <candidate-model>
// runs the role's golden set on the model the role runs now (the newest model-change in effect, else the registry's)
// and on the candidate (live calls: keys, a database and the spend caps apply), and prints both results and the
// model-change record a swap would publish. It publishes nothing.
import { llm } from "../src/llm.ts";
import type { Role } from "../src/models.ts";
import { activeModel, proposeSwap } from "../src/swap.ts";
import { loadCases, TASKS, tryout } from "../src/tryout.ts";

const [role, candidate] = process.argv.slice(2) as [Role, string];
if (!TASKS[role] || !candidate) {
  console.error(`usage: node scripts/tryout.ts <${Object.keys(TASKS).join("|")}> <candidate-model>`);
  process.exit(2);
}
const cases = loadCases(role);
const running = await activeModel(role);
const current = await tryout(role, running, cases, llm);
const cand = await tryout(role, candidate, cases, llm);
console.log(JSON.stringify({ current, candidate: cand }, null, 2));
try {
  console.log(JSON.stringify(proposeSwap(current, cand, running), null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
const { edb } = await import("../src/db.ts");
await edb.end({ timeout: 1 });
