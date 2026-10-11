// A fake Anthropic-compatible model endpoint on loopback (what OpenRouter's /api/v1/messages looks like to the SDK), so
// the real Agent SDK and its CLI can run a role end to end with no model and no network. `reply` decides each turn's
// content blocks from the request (the conversation so far); every request is kept for the test to inspect.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
export type Req = { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> & { messages?: { role: string; content: unknown }[]; tools?: { name: string }[] } };
export const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** `model`: the name replies give the model (default: the one requested), e.g. a dated id. */
export async function fakeModel(reply: (r: Req, turn: number) => Block[] | Promise<Block[]>, usage = USAGE, model?: string) {
  const requests: Req[] = [];
  let turn = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const path = (req.url ?? "").split("?")[0];
      let body: Req["body"] = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
      const r = { path, headers: req.headers, body };
      requests.push(r);
      if (req.method !== "POST" || !path.endsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not here" } }));
        return;
      }
      const content = await reply(r, turn++);
      const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
      const msg = { id: `msg_${turn}`, type: "message", role: "assistant", model: model ?? String(body.model), content, stop_reason: stop, stop_sequence: null, usage };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const ev = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
      ev("message_start", { message: { ...msg, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
      content.forEach((b, index) => {
        if (b.type === "text") {
          ev("content_block_start", { index, content_block: { type: "text", text: "" } });
          ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
        } else {
          ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
          ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
        }
        ev("content_block_stop", { index });
      });
      ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}

const blocks = (r: Req) => (r.body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string }[]).map((b) => ({ role: m.role, ...b })) : []));
/** How many turns the model has taken in this conversation (its tool calls so far). */
export const step = (r: Req) => blocks(r).filter((b) => b.role === "assistant" && b.type === "tool_use").length;
/** Every tool result the model has been sent in this conversation, by tool_use id, as text. */
export function results(r: Req): Record<string, { text: string; error: boolean }> {
  const out: Record<string, { text: string; error: boolean }> = {};
  for (const b of blocks(r) as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
    if (b.type === "tool_result" && b.tool_use_id) out[b.tool_use_id] = { text: typeof b.content === "string" ? b.content : JSON.stringify(b.content), error: b.is_error === true };
  }
  return out;
}
/** The first user message's text (the role's prompt). */
export const promptOf = (r: Req) => JSON.stringify(r.body.messages?.find((m) => m.role === "user")?.content ?? "");
