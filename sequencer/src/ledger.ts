// One order's spend. Each query may spend at most its role's cap and what is left of the order's ceiling minus a
// margin (the driver stops a query after the model call that takes it past its cap, so it can overshoot by that call).
// Queries running in parallel hold their cap until they finish, so together they can't pass the ceiling either. The
// order's total is what report.json says the run cost; the enclave clips it to the ceiling and keeps the full ceiling
// if it is missing. Every cost here is token counts at models.json prices, never the SDK's own figure: the SDK prices a
// model it has no row for (Haiku 5.5 on 0.3.282: costBasis "unknown") at a guess, about 40× too high for Haiku.
import { idOf, priceOf } from "../../engine/src/models.ts";
import type { DevRole } from "../../engine/src/seq-order.ts";

type Tokens = { in: number; out: number; cacheRead: number; cacheWrite: number };
const count = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** A model's card (a model models.json doesn't know: the priciest listed rate) for a call of `promptTokens`. */
const card = (model: string, promptTokens = 0) => priceOf(idOf(model) ?? model, promptTokens);

/** One model call's cost: input is the uncached remainder; cache writes at the 5-minute write price. */
function usd(model: string, t: Tokens, promptTokens = 0) {
  const p = card(model, promptTokens);
  return (t.in * p.in + t.out * p.out + t.cacheRead * p.cached + t.cacheWrite * (p.write ?? p.in * 1.25)) / 1e6;
}

/** A query's cost from the SDK's result modelUsage (token totals per reported model name; its costUSD is ignored), all
 *  priced as the query's requested `model`, as engine/src/llm.ts prices an OpenRouter reply: a reply may name the model
 *  with a release date or in another spelling, and that must not fall to the priciest card. Totals don't say how long
 *  each prompt was, so this is the base card; the meter prices each call on its own card. null: no usage. */
export function usageUsd(modelUsage: unknown, model: string): number | null {
  if (!isObj(modelUsage)) return null;
  return Object.values(modelUsage).reduce<number>((a, u) => {
    const v = isObj(u) ? u : {};
    return a + usd(model, { in: count(v.inputTokens), out: count(v.outputTokens), cacheRead: count(v.cacheReadInputTokens), cacheWrite: count(v.cacheCreationInputTokens) });
  }, 0);
}

/** The most output tokens the CLI asks any dev model for in one call (0.3.282: 64,000; 32,000 for Haiku). */
export const MAX_OUTPUT_TOKENS = 64_000;

/** A running query's cost, call by call, from the SDK's raw stream events: message_start opens a call (its prompt
 *  counts), message_delta brings its final output count. Every call is priced as the requested `model` (the stream's
 *  name for it is not trusted for the price, see usageUsd), on the card for its prompt length.
 *  `usd()`: what the stream has shown (the charge at a result: a call the CLI retried after a broken stream produced no
 *  more than it showed). `charge()`: that, plus MAX_OUTPUT_TOKENS for a call left unfinished, for a query that was
 *  aborted, so a stopped query is never under-reported.
 *  `metered(id)`: the call that asked for tool call `id` is fully counted. */
export function meter(model: string) {
  const calls: { reported: string; u: Record<string, number>; tools: string[]; done: boolean }[] = [];
  const total = (cut: boolean) => calls.reduce((a, { u, done }) => {
    const t = { in: count(u.input_tokens), out: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens) };
    if (cut && !done) t.out = Math.max(t.out, MAX_OUTPUT_TOKENS);
    return a + usd(model, t, t.in + t.cacheRead + t.cacheWrite);
  }, 0);
  const merge = (u: Record<string, number>, from: unknown) => {
    if (isObj(from)) for (const [k, v] of Object.entries(from)) u[k] = Math.max(u[k] ?? 0, count(v));
  };
  return {
    see(e: unknown) {
      if (!isObj(e)) return;
      const last = calls[calls.length - 1];
      if (e.type === "message_start" && isObj(e.message)) {
        const u: Record<string, number> = {};
        merge(u, e.message.usage);
        calls.push({ reported: String(e.message.model ?? ""), u, tools: [], done: false });
      } else if (e.type === "content_block_start" && last && isObj(e.content_block) && e.content_block.type === "tool_use") last.tools.push(String(e.content_block.id));
      else if (e.type === "message_delta" && last) {
        merge(last.u, e.usage);
        last.done = true;
      }
    },
    metered: (id: string) => calls.some((c) => c.done && c.tools.includes(id)),
    usd: () => total(false),
    charge: () => total(true),
    /** The names the replies gave the model, each once (for the report: a reply that named another model shows). */
    models: () => [...new Set(calls.map((c) => c.reported).filter((n) => n !== ""))],
  };
}

/** The SDK's own maxBudgetUsd for a query: a backstop the cap always reaches first. The SDK may price the model at a
 *  guess (Opus-class list rates for Haiku), so it is the cap × how far the priciest listed card is above the model's. */
export function backstopUsd(cap: number, model: string) {
  const p = card(model), worst = priceOf("");
  const ratios = (["in", "out"] as const).filter((k) => p[k] > 0).map((k) => worst[k] / p[k]);
  return Math.round(cap * Math.max(1, ...ratios) * 100) / 100;
}

/** `replied`: the names the replies gave the model (another name than `model` shows here; the cost is priced as `model`). */
export type Spent = { role: DevRole; model: string; costUsd: number; subtype: string; turns: number; modelUsage?: unknown; replied?: string[] };
export const MIN_QUERY_USD = 0.25;
const cents = (x: number) => Math.floor(x * 100) / 100;

export class Ledger {
  readonly ceilingUsd: number;
  readonly perQueryUsd: Record<DevRole, number>;
  readonly margin: number;
  readonly entries: Spent[] = [];
  private held = 0;
  constructor(ceilingUsd: number, perQueryUsd: Record<DevRole, number>) {
    this.ceilingUsd = ceilingUsd;
    this.perQueryUsd = perQueryUsd;
    this.margin = Math.min(3, ceilingUsd / 4);
  }
  get spent() {
    return this.entries.reduce((a, e) => a + (Number.isFinite(e.costUsd) && e.costUsd > 0 ? e.costUsd : 0), 0);
  }
  /** Hold maxBudgetUsd for a query of `role`; null when there is not enough left to start one. */
  take(role: DevRole): number | null {
    const cap = cents(Math.min(this.perQueryUsd[role], this.ceilingUsd - this.margin - this.spent - this.held));
    if (cap < MIN_QUERY_USD) return null;
    this.held += cap;
    return cap;
  }
  /** The query that held `cap` finished with this spend. */
  settle(cap: number, e: Spent) {
    this.held = Math.max(0, this.held - cap);
    this.entries.push(e);
  }
}
