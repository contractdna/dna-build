// How a role's query runs. `sdkDriver`: the Claude Agent SDK, through OpenRouter (ANTHROPIC_BASE_URL; the key from
// OPENROUTER_API_KEY_SEQUENCER as the auth token; no ANTHROPIC_API_KEY), with only the role's tools (dontAsk: nothing
// else is ever approved), the path guard on every tool call, no settings or memory files read from anywhere, no
// session saved, the model and effort the order names, the query's turn limit, and a timer. The driver meters the
// query's spend itself (each model call's tokens at models.json prices) and stops it past its cap; the SDK's own budget
// is only a backstop, since the SDK prices some models at a guess (ledger.ts). The offline
// simulation runs the same driver against a loopback fake of the model API; unit tests use `scriptDriver`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { DevRole, Kind } from "../../engine/src/seq-order.ts";
import { type Access, guardHook } from "./guard.ts";
import { gatesServer } from "./gatetool.ts";
import { loopbackOr } from "./ci.ts";
import { backstopUsd, MAX_OUTPUT_TOKENS, meter, usageUsd } from "./ledger.ts";

export type Query = {
  role: DevRole; model: string; effort: "low" | "medium" | "high" | "xhigh" | "max"; system: string; prompt: string;
  maxBudgetUsd: number; maxTurns: number; timeoutMs: number; access: Access; slug: string; schema?: z.ZodType;
  /** the order's kind (absent: a game): which kit forge runs with */
  kind?: Kind;
};
/** `raw`: what the model last answered, unparsed (its structured output, else its last reply's text and tool inputs), so
 *  an answer the schema refused can be read. */
export type Result = { costUsd: number; subtype: string; turns: number; output: unknown; text: string; modelUsage?: unknown; replied?: string[]; raw?: string };
export type Driver = { run: (q: Query) => Promise<Result> };

export const OPENROUTER = "https://openrouter.ai/api";

/** The env the SDK's CLI gets: nothing of the runner's but PATH, a throwaway HOME, and the OpenRouter credentials. */
export function sdkEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const key = env.OPENROUTER_API_KEY_SEQUENCER;
  if (!key) throw new Error("OPENROUTER_API_KEY_SEQUENCER is not set");
  return {
    PATH: env.PATH ?? "/usr/bin:/bin", HOME: mkdtempSync(join(tmpdir(), "seq-home-")),
    ANTHROPIC_BASE_URL: loopbackOr(env.SEQ_MODEL_API, OPENROUTER), ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
    // every reply may be as long as the meter charges an unfinished one for
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MAX_OUTPUT_TOKENS),
  };
}

/** The JSON Schema the CLI takes for structured output: without `$schema` (the CLI refuses zod's 2020-12 tag). */
export function jsonSchema(s: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(s) as Record<string, unknown>;
  return rest;
}

const OVER = "the query is over its budget";
/** What the cap hook reads: whether the query is past its cap, and whether the call behind a tool call is metered. */
export type Cap = { over: () => boolean; metered: (toolUseId: string) => boolean };
/** Once the query is past its cap, its next tool call ends it in-band: the CLI stops before another model call (an
 *  abort only closes the CLI's stdin and leaves it a grace window in which it calls the model again). The stream
 *  reaches the driver a little after the CLI asks for the tool, so the hook first waits (up to `waitMs`) until the call
 *  that asked for it is metered. */
export const capHook = (cap: Cap, waitMs = 5_000) => async (_input: unknown, toolUseId?: string) => {
  for (const t = Date.now(); toolUseId && !cap.metered(toolUseId) && Date.now() - t < waitMs;) await new Promise((ok) => setTimeout(ok, 5));
  return cap.over() ? { continue: false, stopReason: OVER, hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: OVER } } : {};
};
const UNCAPPED: Cap = { over: () => false, metered: () => true };

/** The SDK options of one query (pure, so the test can pin every safety-relevant field). */
export function sdkOptions(q: Query, root: string, env: Record<string, string>, abort: AbortController, end = Date.now() + q.timeoutMs, cap = UNCAPPED): Options {
  const usesGates = q.access.tools.some((t) => t.startsWith("mcp__gates__"));
  return {
    cwd: root, env, model: q.model, effort: q.effort, systemPrompt: q.system,
    tools: q.access.tools.filter((t) => !t.startsWith("mcp__")), allowedTools: q.access.tools, permissionMode: "dontAsk",
    canUseTool: async () => ({ behavior: "deny", message: "not allowed" }),
    settingSources: [], persistSession: false, maxTurns: q.maxTurns, maxBudgetUsd: backstopUsd(q.maxBudgetUsd, q.model), abortController: abort,
    includePartialMessages: true, // the raw stream events the driver meters the query's spend from
    // no matcher: the guard and the cap see every tool call
    hooks: { PreToolUse: [{ hooks: [guardHook(q.access) as never, capHook(cap) as never] }] },
    ...(usesGates ? { mcpServers: { gates: gatesServer(root, q.slug, abort.signal, end, q.kind) } } : {}),
    ...(q.schema ? { outputFormat: { type: "json_schema" as const, schema: jsonSchema(q.schema) } } : {}),
  };
}

export function sdkDriver(root: string, env = sdkEnv()): Driver {
  return {
    async run(q) {
      const abort = new AbortController();
      const end = Date.now() + q.timeoutMs;
      const timer = setTimeout(() => abort.abort(), q.timeoutMs);
      const spend = meter(q.model);
      let over = false;
      let cut = false; // the query was aborted (its timer, or a call started past the cap)
      let result: Result = { costUsd: q.maxBudgetUsd, subtype: "no_result", turns: 0, output: null, text: "" };
      let said = "";
      try {
        // read to the end, even past the cap: every call the CLI makes is metered
        for await (const m of query({ prompt: q.prompt, options: sdkOptions(q, root, env, abort, end, { over: () => over, metered: spend.metered }) })) {
          if (m.type === "stream_event") {
            // a call that starts past the cap had no tool call to stop it at (the model answered without one): end it now
            if (over && (m.event as { type?: string }).type === "message_start") abort.abort();
            spend.see(m.event);
            over ||= spend.usd() > q.maxBudgetUsd;
            continue;
          }
          if (m.type === "assistant") {
            const blocks = (m as { message?: { content?: { type?: string; text?: string; input?: unknown }[] } }).message?.content ?? [];
            said = blocks.map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? JSON.stringify(b.input) : "")).filter(Boolean).join("\n").slice(0, 8000);
            continue;
          }
          if (m.type !== "result") continue;
          const r = m as { subtype: string; num_turns?: number; result?: string; structured_output?: unknown; modelUsage?: unknown };
          // the larger of the two: the meter prices each call on its own card, modelUsage also counts any call not streamed
          // (at a result nothing was cut off: a call the CLI retried after a broken stream produced no more than it showed)
          const costUsd = Math.max(spend.usd(), usageUsd(r.modelUsage, q.model) ?? q.maxBudgetUsd);
          over ||= costUsd > q.maxBudgetUsd;
          result = {
            costUsd, subtype: r.subtype, turns: r.num_turns ?? 0,
            output: q.schema && r.structured_output !== undefined ? q.schema.safeParse(r.structured_output).data ?? null : null, text: String(r.result ?? ""), modelUsage: r.modelUsage,
            raw: r.structured_output !== undefined ? JSON.stringify(r.structured_output).slice(0, 8000) : said,
          };
        }
      } catch (e) {
        // the SDK throws after an error result (turns, its backstop budget): keep that result's own subtype and cost
        if (abort.signal.aborted) result = { ...result, subtype: "timeout", costUsd: Math.max(result.costUsd, spend.charge()) };
        else if (result.subtype === "no_result" || result.subtype === "success") result = { ...result, subtype: `error: ${String((e as Error).message).slice(0, 200)}` };
      } finally {
        clearTimeout(timer);
        cut = abort.signal.aborted;
        abort.abort(); // however the query ended, no forge run it started goes on
      }
      // past its cap (stopped mid-query, or finished over it): a budget stop, charged what it spent; an aborted query
      // also for the most its unfinished call could have produced
      if (over) result = { ...result, subtype: "error_max_budget_usd", costUsd: Math.max(cut ? spend.charge() : spend.usd(), result.subtype === "no_result" ? 0 : result.costUsd) };
      const replied = spend.models();
      if (result.raw === undefined && said) result = { ...result, raw: said };
      return replied.length ? { ...result, replied } : result;
    },
  };
}

/** Tests and the local simulation: each query is answered by `answer` (which may write files as the role would). */
export const scriptDriver = (answer: (q: Query) => Promise<Partial<Result>> | Partial<Result>): Driver => ({
  async run(q) {
    const r = await answer(q);
    return { costUsd: 0.1, subtype: "success", turns: 1, output: null, text: "", ...r };
  },
});
