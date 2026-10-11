// The workflow's first job: is this dispatch a fresh order the enclave signed, on the run's first attempt, and the
// order's only run?
//   node sequencer/src/verify.ts --payload <client_payload.json> --out <order.json>
// Env: GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN (the job's token, actions: read) to list the workflow's runs.
// The enclave's log signer comes from deploy/release.json on main (owned by the maintainers); while it is null, every
// order is refused. Writes the order and, for the next jobs, its base commit, slug, id and round to $GITHUB_OUTPUT.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { orderRef, verifyOrder } from "../../engine/src/seq-order.ts";
import { firstAttemptOnly, firstRunOnly } from "./ci.ts";

const { values: a } = parseArgs({ options: { payload: { type: "string" }, out: { type: "string" }, release: { type: "string" } } });
if (!a.payload || !a.out) throw new Error("usage: verify.ts --payload <file> --out <order.json> [--release deploy/release.json]");
firstAttemptOnly();
const release = JSON.parse(readFileSync(a.release ?? new URL("../../deploy/release.json", import.meta.url), "utf8")) as { logSigner?: string | null };
const r = await verifyOrder(JSON.parse(readFileSync(a.payload, "utf8")), release.logSigner, Date.now());
if (!r.ok) {
  console.error(`refused: ${r.why}`);
  process.exit(1);
}
const again = await firstRunOnly(orderRef(r.order));
if (again) {
  console.error(`refused: ${again}`);
  process.exit(1);
}
writeFileSync(a.out, `${JSON.stringify(r.order, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base_sha=${r.order.baseSha}\nslug=${r.order.slug}\nid=${r.order.id}\nround=${r.order.round}\n`);
console.log(`order ${r.order.id} round ${r.order.round}: ${r.order.slug} on ${r.order.baseSha}`);
