// Staging run of the signers' Telegram channel against the real Bot API, the private signers group only, with the
// engine's own code (src/telegram.ts: tg, say, draftMessage, allowed, parseCallback, parseCommand):
//   bot identity and privacy mode → no webhook (getUpdates would fail) → the group's type and member count → every
//   allowlisted id is a member → an alert → a long alert (cut at 4000) → a text draft with the Reject button (approving
//   takes a Safe owner's signature) → waits for a signer to press it and to send /ping:
//   the press is checked with allowed() / parseCallback(), answered, and the keyboard removed (the returned message
//   must have none) → the updates read are confirmed (offset) → a closing message.
// Nothing is approved or posted: the drafts exist only in the group (no database). Run it while no engine polls this
// bot: a second getUpdates caller gets 409 (reported as such).
//   live: TELEGRAM_BOT_TOKEN=… TELEGRAM_GROUP_ID=… TELEGRAM_ALLOWED_USER_IDS=… node scripts/stage-telegram.ts [--wait 10]
//   dry:  node scripts/stage-telegram.ts --dry   (the local fakes; a signer's press and /ping are simulated)
// Output: stage/out/telegram-<UTC>/report.json (gitignored). The token is never printed.
import { parseArgs } from "node:util";
import { die, dryFakes, guardEnv, outDir, writeJson } from "./stage-lib.ts";

const NAME = "stage-telegram";
const { values: arg } = parseArgs({ options: { dry: { type: "boolean", default: false }, wait: { type: "string", default: "10" }, out: { type: "string" } } });
guardEnv(NAME, ["TELEGRAM_BOT_TOKEN"]);
const waitMin = Number(arg.wait);
if (!(waitMin >= 0 && waitMin <= 60)) die(NAME, "--wait is minutes in 0..60");
delete process.env.TELEGRAM_API_BASE;
const fakes = arg.dry ? await dryFakes() : null;
if (fakes) Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "dry", TELEGRAM_GROUP_ID: "-100", TELEGRAM_ALLOWED_USER_IDS: "7", TELEGRAM_POLL_TIMEOUT_S: "1" });
for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_GROUP_ID", "TELEGRAM_ALLOWED_USER_IDS"]) if (!process.env[k]) die(NAME, `needs ${k} (or --dry)`);
if (!/^-\d+$/.test(process.env.TELEGRAM_GROUP_ID!)) die(NAME, "TELEGRAM_GROUP_ID is a group id (negative)");
const dir = outDir("telegram", arg.out);

const { TG } = await import("../src/config.ts");
const { allowed, draftMessage, parseCallback, parseCommand, say, tg } = await import("../src/telegram.ts");
type Update = import("../src/telegram.ts").Update;
type Msg = { message_id: number; chat: { id: number }; reply_markup?: unknown };

const checks: { step: string; ok: boolean; detail?: unknown }[] = [];
const check = (step: string, ok: boolean, detail?: unknown) => { checks.push({ step, ok, detail }); console.error(`${NAME}: ${ok ? "ok  " : "FAIL"} ${step}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`); };
/** A Bot API error with the token cut out (tg() errors carry only the method, status and description). */
const why = (e: unknown) => (e as Error).message.replaceAll(TG.token ?? "\0", "<token>").slice(0, 300);
const step = async <T>(name: string, f: () => Promise<T>): Promise<T | undefined> => { try { return await f(); } catch (e) { check(name, false, why(e)); return undefined; } };

// ---------------------------------------------------------------- the bot, the group, the signers
const me = (await step("getMe", () => tg<{ username: string; can_read_all_group_messages?: boolean }>("getMe", {})))
  ?? (writeJson(dir, "report.json", { checks }), die(NAME, "the bot token was refused (getMe)"));
check("bot identity", true, { username: me.username, privacyMode: !me.can_read_all_group_messages });
const hook = await step("getWebhookInfo", () => tg<{ url: string; pending_update_count: number }>("getWebhookInfo", {}));
if (hook) check("no webhook (getUpdates works)", hook.url === "", { pending: hook.pending_update_count });
const chat = await step("getChat", () => tg<{ type: string }>("getChat", { chat_id: TG.group }));
if (chat) check("the group is a group", chat.type === "group" || chat.type === "supergroup", { type: chat.type });
const members = await step("getChatMemberCount", () => tg<number>("getChatMemberCount", { chat_id: TG.group }));
if (members !== undefined) check("member count (signers + bot; anyone else is a stranger)", members <= TG.allow.size + 1, { members, allowlisted: TG.allow.size });
for (const id of TG.allow) {
  const m = await step(`signer ${id}`, () => tg<{ status: string }>("getChatMember", { chat_id: TG.group, user_id: id }));
  if (m) check(`allowlisted id ${id} is in the group`, ["creator", "administrator", "member"].includes(m.status), { status: m.status });
}

// ---------------------------------------------------------------- what the engine sends
const run = Date.now() % 1e9; // the draft ids of this run (numeric: parseCallback's shape); no engine draft exists for them
const alertRes = await step("alert", () => say(`⚠ Staging run ${run}: this is how an engine alert looks. Nothing happened.`) as Promise<Msg>);
check("alert delivered", !!alertRes?.message_id);
const long = await step("long alert", () => say(`⚠ Staging run ${run}, a long alert (cut at 4000): ${"é—".repeat(2500)}`) as Promise<Msg>);
check("long alert delivered (cut at 4000 characters)", !!long?.message_id);
const textId = String(run * 10 + 1);
const td = draftMessage(textId, "x_post", { text: "Staging: a draft looks like this. Pressing a button decides nothing (no engine is listening).", media: "dna-logo.mp4" }, "0");
const textMsg = await step("text draft", () => say(td.text, td.markup) as Promise<Msg>);
check("text draft with keyboard delivered", !!textMsg?.message_id);
await step("ask", () => say(`Staging run ${run}: a signer, please press Reject on draft #${textId} and send /ping@${me.username}. Waiting ${waitMin} min.`));

// ---------------------------------------------------------------- a signer's press and a command, through the engine's checks
if (fakes) {
  const cq = (update_id: number, from: number, data: string) => ({ update_id, callback_query: { id: `q${update_id}`, from: { id: from }, message: { message_id: textMsg?.message_id ?? 1, chat: { id: TG.group } }, chat_instance: "1", data } });
  fakes.tgUpdates.push(cq(1, 666, `d:${textId}:r`), cq(2, 7, `d:${textId}:r`), { update_id: 3, message: { message_id: 9, chat: { id: TG.group }, from: { id: 7 }, text: "/ping@fake_bot" } });
}
let offset = 0;
const seen = { press: false, stranger: false, ping: false, keyboardRemoved: null as boolean | null };
const until = Date.now() + waitMin * 60_000;
while (Date.now() < until && !(seen.press && seen.ping)) {
  let updates: Update[];
  try {
    updates = await tg<Update[]>("getUpdates", { offset, timeout: Math.min(TG.pollTimeoutS, Math.max(1, Math.round((until - Date.now()) / 1000))), allowed_updates: ["message", "callback_query"] });
  } catch (e) {
    check("getUpdates", false, /409/.test(why(e)) ? "409: another poller (the engine?) uses this bot: stop it, or use a staging bot" : why(e));
    break;
  }
  for (const u of updates) {
    offset = u.update_id + 1;
    const ok = allowed(u);
    if (u.callback_query) {
      const q = u.callback_query, p = parseCallback(q.data);
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: ok ? "staging: seen, nothing decided" : "not allowed" }).catch((e) => check("answerCallbackQuery", false, why(e)));
      if (!ok) { seen.stranger = true; check("a press from an id not on the allowlist is refused", true, { from: q.from.id }); continue; }
      check("an allowlisted press parses", !!p && p.id === textId, { from: q.from.id, data: q.data });
      if (q.message) {
        const edited = await tg<Msg | true>("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch((e) => { check("editMessageReplyMarkup", false, why(e)); return undefined; });
        seen.keyboardRemoved = !!edited && edited !== true && !edited.reply_markup;
        check("editMessageReplyMarkup without reply_markup removes the keyboard", seen.keyboardRemoved, edited === true ? "returned true, not the message" : undefined);
      }
      seen.press = true;
    } else if (u.message?.text) {
      const { cmd } = parseCommand(u.message.text);
      if (cmd !== "/ping") continue;
      check(`/ping${u.message.text.includes("@") ? "@bot" : ""} reaches the bot and parses`, ok, { from: u.message.from?.id, allowlisted: ok });
      if (ok) { seen.ping = true; await step("pong", () => say(`pong (staging run ${run})`)); }
    }
  }
}
if (offset) await step("confirm updates (offset)", () => tg("getUpdates", { offset, timeout: 0 })); // read updates never reach the engine later
if (!seen.press) check("a signer pressed a draft button", false, `none within ${waitMin} min`);
if (!seen.ping) check("a signer's /ping arrived", false, `none within ${waitMin} min`);
await step("closing", () => say(`Staging run ${run} done: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed. Nothing was approved or posted.`));

const report = { mode: arg.dry ? "dry (local fakes)" : "live", at: new Date().toISOString(), run, bot: me.username, passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, seen, checks };
writeJson(dir, "report.json", report);
console.error(`${NAME}: ${report.passed} passed, ${report.failed} failed; ${dir}/report.json`);
await fakes?.close();
process.exit(0);
