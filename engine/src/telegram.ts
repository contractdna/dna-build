// Telegram (Bot API over fetch; core.telegram.org/bots/api): getUpdates long poll, alerts, commands, and the generic
// draft primitive. Only the private signer group, and only allowlisted user ids — checked on messages AND on
// callback_query.from.id. The allowlist alone approves nothing: a draft is approved only by a Safe owner's signature
// (/approve, src/approve.ts); allowlisted users keep the brakes (/halt, /dryrun, /mute, /unmute, /delete: each only
// stops or removes, never acts) and Reject, and release or drop a reply the engine drafted for an important X account
// (Send / Skip, `x:<outbox id>:s|k`: they choose whether the exact drafted text goes out, never what it says). The log
// names a signer by allowlist place (signerTag), never by Telegram id. Plain text only (no parse_mode), so untrusted
// text can't inject formatting or links.
// Approvals: a draft row holds the exact final payload; the keyboard carries `d:<id>:a|r` (≤ 64 bytes); an approved
// draft is dispatched once (job dedupe `draft:<id>`) to the handler for its kind. Enclave: the draft
// row is never read for a decision; the newest verified 'draft' record is: pending → decide, approved {kind, payload,
// by} → dispatch, done/failed → nothing. Records only append, so an old approval can't be replayed after 'done'.
import { draftApprover } from "./approve.ts";
import { TG } from "./config.ts";
import { edb as sql } from "./db.ts";
import { ENCLAVE } from "./enclave.ts";
import { enqueue, type Handler } from "./jobs.ts";
import { append, isRolledBack } from "./log.ts";
import { latest } from "./records.ts";

type User = { id: number };
type Message = { message_id: number; chat: { id: number }; from?: User; text?: string };
export type Update = { update_id: number; message?: Message; callback_query?: { id: string; from: User; message?: Message; data?: string } };

export async function tg<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${TG.api}/bot${TG.token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
    signal: AbortSignal.timeout((TG.pollTimeoutS + 10) * 1000),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!body.ok) throw new Error(`telegram ${method}: ${res.status} ${body.description ?? ""}`);
  return body.result as T;
}

/** Pure: may this update act? Group chat + allowlisted sender, for messages and button presses alike. */
export function allowed(u: Update, cfg: { group?: number; allow: Set<number> } = TG): boolean {
  if (cfg.group === undefined) return false;
  const m = u.message ?? u.callback_query?.message;
  const from = u.callback_query ? u.callback_query.from : u.message?.from;
  return !!m && !!from && m.chat.id === cfg.group && cfg.allow.has(from.id);
}

export const parseCallback = (data?: string) => {
  const m = data?.match(/^d:(\d{1,18}):([ar])$/);
  return m ? { id: m[1], approve: m[2] === "a" } : null;
};

/** A held X reply's button: `x:<outbox id>:s` (Send) or `x:<outbox id>:k` (Skip). */
export const parseReplyButton = (data?: string) => {
  const m = data?.match(/^x:(\d{1,18}):([sk])$/);
  return m ? { id: m[1], send: m[2] === "s" } : null;
};
/** What a Send / Skip tap runs (src/x.ts pressReply): the outcome, said back to the group. */
export type ReplyButton = (id: string, send: boolean, by: string) => Promise<string>; // by: the signerTag

/** Send to the signer group (or stdout when Telegram isn't configured). */
export async function say(text: string, extra: Record<string, unknown> = {}) {
  if (!TG.token || TG.group === undefined) return void console.log(`[telegram off] ${text}`);
  return tg<Message>("sendMessage", { chat_id: TG.group, text: text.slice(0, 4000), ...extra });
}

export const alertHandler: Handler = {
  lane: "tg",
  run: async (job) => {
    const text = String(job.payload.text);
    await append("alert", (job.dedupe_key ?? job.kind).slice(0, 200), { text });
    return say(`⚠ ${text}`);
  },
};
export const alert = (text: string, dedupeKey?: string) => enqueue("alert", { text }, { dedupeKey });

/** Create a draft and ask the signers. `text` is the exact final text the approval publishes/sends. Approving takes a
 *  Safe owner's signature over the draft's pending record (src/approve.ts); the button only rejects. */
export async function createDraft(kind: string, payload: Record<string, unknown> & { text: string }) {
  const value = { kind, payload: JSON.parse(JSON.stringify(payload)) };
  const [dr] = await sql<{ id: string }[]>`insert into draft (kind, payload) values (${kind}, ${sql.json(value.payload as never)}) returning id::text`;
  const rec = await append("draft", dr.id, { id: dr.id, ...value, status: "pending" });
  const m = draftMessage(dr.id, kind, payload, rec.seq);
  const msg = await say(m.text, m.markup);
  if (msg) await sql`update draft set tg_message_id = ${msg.message_id} where id = ${dr.id}`;
  return dr.id;
}
/** What the signers see for a draft: the exact text, how a Safe owner approves it (its pending record `seq`), and a
 *  Reject-only keyboard: the allowlist can reject, never approve. */
export function draftMessage(id: string, kind: string, payload: { text: string; media?: unknown }, seq: string) {
  const markup = { reply_markup: { inline_keyboard: [[{ text: "Reject", callback_data: `d:${id}:r` }]] } };
  const media = typeof payload.media === "string" ? `\n\n+ media: ${payload.media}` : "";
  const how = `To approve, a Safe owner signs: node engine/scripts/owner-digest.ts approve ${seq}\nthen sends: /approve ${seq} <signature>`;
  return { markup, text: `Draft #${id} (${kind}). ${how}\n\nApproving publishes exactly this:\n\n${payload.text}${media}` };
}

/** How a signer appears in the public log: their place on the allowlist (`telegram:signer-2`), never their Telegram
 *  user id (the ids stay private; a hash of one would be guessable from the small id space). */
export const signerTag = (id: number, allow: Set<number> = TG.allow) => `telegram:signer-${[...allow].indexOf(id) + 1 || "unknown"}`;

/** Record a decision once (pending → approved/rejected) and dispatch approvals. `by`: the Safe owner's address for an
 *  approval (only src/approve.ts ownerCommand approves, after checking the signature), a Telegram user id for a reject
 *  (recorded as its signerTag). */
export async function decide(id: string, approve: boolean, by: number | string) {
  const rec = ENCLAVE.on ? await draftRec(id) : undefined;
  if (ENCLAVE.on && rec?.status !== "pending") return false;
  const [dr] = await sql<{ id: string; kind: string; payload: Record<string, unknown> }[]>`update draft set status = ${approve ? "approved" : "rejected"}, decided_by = ${typeof by === "number" ? signerTag(by) : null}, decided_at = now()
    where id = ${id} and status = 'pending' returning id::text, kind, payload`;
  if (!dr) return false;
  const value = rec ? { kind: rec.kind, payload: rec.payload } : { kind: dr.kind, payload: dr.payload }; // enclave: the signed payload
  await append("draft", dr.id, { id: dr.id, ...value, status: approve ? "approved" : "rejected", by: typeof by === "number" ? signerTag(by) : by });
  if (approve) await enqueue("draft", { id: dr.id }, { dedupeKey: `draft:${dr.id}` });
  return true;
}

type DraftRec = { id: string; kind: string; payload: Record<string, unknown>; status: string; by?: number };
/** The newest verified record of a draft; a hidden newer one (e.g. its 'done') reads as no record. */
const draftRec = (id: string) =>
  latest<DraftRec>("draft", id).then((r) => (r?.id === id ? r : undefined), (e) => (isRolledBack(e) ? undefined : Promise.reject(e))); // its own id, not a moved record

/** Approved draft → its kind's handler; the result (or error) is stored on the draft. */
export function draftHandler(byKind: Record<string, (payload: Record<string, unknown>, id: string) => Promise<unknown>>): Handler {
  return {
    lane: "default",
    run: async (job) => {
      const id = String(job.payload.id);
      let dr: { id: string; kind: string; payload: Record<string, unknown>; status: string } | undefined;
      if (ENCLAVE.on) {
        const rec = await draftRec(id);
        if (rec?.status !== "approved") return `draft ${id}: no verified approval record`;
        dr = { id, kind: rec.kind, payload: rec.payload, status: rec.status };
      } else {
        [dr] = await sql<{ id: string; kind: string; payload: Record<string, unknown>; status: string }[]>`select id::text, kind, payload, status from draft where id = ${id}`;
        if (!dr || dr.status !== "approved") return `draft ${id} not approved`;
      }
      // the gate in both builds: a current Safe owner's signature over the draft's pending record
      if (!(await draftApprover(id).catch((e) => (isRolledBack(e) ? null : Promise.reject(e))))) return `draft ${id}: no Safe owner's approval signature`;
      const h = byKind[dr.kind];
      try {
        if (!h) throw new Error(`no handler for draft kind ${dr.kind}`);
        const result = await h(dr.payload, dr.id);
        await sql`update draft set status = 'done', result = ${sql.json((result ?? null) as never)} where id = ${dr.id}`;
        await append("draft", dr.id, { id: dr.id, kind: dr.kind, status: "done" });
        return result;
      } catch (e) {
        const error = (e as Error).message;
        if (!(e as { final?: boolean }).final && job.attempts < job.max_attempts) throw e; // transient: retry
        await sql`update draft set status = 'failed', result = ${sql.json({ error } as never)} where id = ${dr.id}`;
        await append("draft", dr.id, { id: dr.id, kind: dr.kind, status: "failed", error });
        await alert(`Draft #${dr.id} (${dr.kind}) failed: ${error}`);
        return { error };
      }
    },
  };
}

/** `/veto@bot 123 0x…` → {cmd: "/veto", args: ["123", "0x…"]} (a group adds the bot's name to a command). */
export function parseCommand(text?: string) {
  const [first, ...args] = text?.trim().split(/\s+/) ?? [];
  return { cmd: first?.replace(/@\w+$/, "").toLowerCase(), args };
}
/** A command gets the sender's signerTag (never the raw Telegram id) and the words after it (`/veto 123 0x…` →
 *  ["123", "0x…"]). */
export type Commands = Record<string, (by: string, args: string[]) => Promise<string>>;

async function handle(u: Update, commands: Commands, reply?: ReplyButton) {
  if (!allowed(u)) {
    if (u.callback_query) await tg("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: "not allowed" }).catch(() => {});
    return; // silently ignore everyone else
  }
  if (u.callback_query) {
    const q = u.callback_query;
    const rb = parseReplyButton(q.data);
    if (rb && reply) {
      const out = await reply(rb.id, rb.send, signerTag(q.from.id));
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: out.slice(0, 190) });
      return void (await say(out));
    }
    const p = parseCallback(q.data);
    // an Approve press (an older message's button) approves nothing: only a Safe owner's signature does
    if (p?.approve) return void (await tg("answerCallbackQuery", { callback_query_id: q.id, text: "approving needs a Safe owner's signature: /approve <seq> <signature> (see the draft message)" }));
    const ok = p ? await decide(p.id, false, q.from.id) : false;
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: !p ? "unknown button" : ok ? "rejected" : "already decided" });
    // UNVERIFIED (Bot API docs only mark reply_markup optional): omitting it removes the inline keyboard
    if (ok && q.message) await tg("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
    if (ok) await say(`Draft #${p!.id} rejected by ${signerTag(q.from.id).slice(9)}`);
    return;
  }
  const { cmd, args } = parseCommand(u.message?.text);
  const run = cmd && commands[cmd];
  if (run) await say(await run(signerTag(u.message!.from!.id), args));
}

/** Long-poll loop. The offset is persisted, so a restart neither replays nor drops updates. */
export async function pollTelegram(commands: Commands, stop: () => boolean, reply?: ReplyButton) {
  if (!TG.token || TG.group === undefined) return console.log("telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_GROUP_ID unset, polling off");
  let [{ value } = { value: { offset: 0 } }] = await sql<{ value: { offset: number } }[]>`select value from state where key = 'engine_tg'`;
  let offset = value.offset;
  while (!stop()) {
    try {
      const updates = await tg<Update[]>("getUpdates", { offset, timeout: TG.pollTimeoutS, allowed_updates: ["message", "callback_query"] });
      for (const u of updates) {
        await handle(u, commands, reply).catch((e) => console.error("telegram update failed", u.update_id, e));
        offset = u.update_id + 1;
        await sql`insert into state (key, block, value) values ('engine_tg', 0, ${sql.json({ offset })})
          on conflict (key) do update set value = excluded.value, updated_at = now()`;
      }
    } catch (e) {
      console.error("telegram poll failed", (e as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
