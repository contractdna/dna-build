// X wallet bindings, engine side: a mention of @contractdna naming one 0x address (src/rewards.ts parseBinding, no
// model) becomes a signed `binding` record, ref `x:<X user id>`. The first binding is in force at once; a different
// address later is a rebinding, in force REBIND_DELAY_MS after it (announced on the site); binding back cancels a
// waiting one. A first binding gets one fixed X reply; changes are site-only. BINDING_LIMITS cap an account's records.
// Idea rewards for X ideas pay the binding in force.
import { announce } from "./announce.ts";
import { edb as sql } from "./db.ts";
import { append, type EnclaveRow, newestOf, RolledBack, rolledBack, trustedRecord } from "./log.ts";
import { type BindingRecord, bindingAt, REBIND_DELAY_MS } from "./rewards.ts";
import { enqueueX, skipReply } from "./x.ts";

export type Binding = BindingRecord & { seq: string };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Binding records an X account may write: a day's worth, and a lifetime's (so its whole history is one bounded read). */
export const BINDING_LIMITS = { perDay: 3, total: 100 };

/** Every binding record of one X user id the enclave signed, oldest first (the plain build trusts every row); at most
 *  BINDING_LIMITS.total exist per account. */
export async function bindingsOf(xUserId: string): Promise<Binding[]> {
  const ref = `x:${xUserId}`;
  const want = newestOf("binding", ref);
  const rows = await sql<(EnclaveRow & { seq: string; doc: BindingRecord })[]>`select seq::text, kind, ref, body, eprev, ehash, esig, doc from log
    where kind = 'binding' and ref = ${ref} order by log.seq limit ${BINDING_LIMITS.total + 20}`; // + room for skipped rows
  const out: Binding[] = [];
  for (const r of rows) if (await trustedRecord(r, "binding record") && r.doc.xUserId === xUserId) out.push({ ...r.doc, seq: r.seq });
  if (await rolledBack("binding", ref, out.at(-1)?.seq, want)) throw RolledBack(`binding ${ref}`);
  return out;
}

/** The binding in force for this X user id now (undefined: none yet). */
export const latestBinding = async (xUserId: string, now = Date.now()) => bindingAt(await bindingsOf(xUserId), now).cur;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Record a binding from mention `postId` by `xUserId`. "same": the address is already in force or waiting; "limit":
 *  over BINDING_LIMITS (nothing written, no reply either way). Otherwise the record and a site announcement; only a
 *  first binding gets the X reply (a change or a cancel is announced on the site only). */
export async function bind(xUserId: string, postId: string, address: `0x${string}`, now = Date.now()) {
  const recs = await bindingsOf(xUserId);
  const { cur, pending } = bindingAt(recs, now);
  if (same((pending ?? cur)?.address ?? "", address)) {
    await skipReply(postId, "binding: this wallet is already bound");
    return { status: "same" as const };
  }
  const today = recs.filter((r) => now - Date.parse(r.at) < 86_400_000).length;
  if (today >= BINDING_LIMITS.perDay || recs.length >= BINDING_LIMITS.total) {
    const why = today >= BINDING_LIMITS.perDay ? `more than ${BINDING_LIMITS.perDay} wallet bindings in 24 hours` : `more than ${BINDING_LIMITS.total} wallet bindings`;
    await skipReply(postId, `binding: ${why}`);
    return { status: "limit" as const, why };
  }
  const change = !cur ? "first" : same(cur.address, address) ? "cancel" : "rebind";
  const at = new Date(now).toISOString();
  const effectiveAt = new Date(change === "rebind" ? now + REBIND_DELAY_MS : now).toISOString();
  const body: BindingRecord = { kind: "binding", xUserId, address, postId, at, effectiveAt };
  const rec = await append("binding", `x:${xUserId}`, body);
  await announce(`binding:${rec.seq}`, { event: "binding_linked", change, wallet: short(address), xUserId, effectiveAt, record: rec.seq });
  if (change === "first") await enqueueX(`reply:${postId}`, "reply", { event: "binding_reply" }, { replyTo: postId });
  else await skipReply(postId, `binding: a ${change}, announced on the site`);
  return { status: change, seq: rec.seq, effectiveAt };
}
