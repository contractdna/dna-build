// The public model registry (engine/models.json): which model plays each role, its backup, its route (OpenRouter, or
// xAI direct for server-side search), its price, and each model's OpenRouter id. Read once at
// boot. Outside the enclave a few legacy env vars may override a role's model for operations; the overrides are
// reported by registryInfo(), which every brain and model-change record carries. Inside the enclave those env vars are
// refused by the env lockdown, so the image's models.json is the whole truth there.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

export const ROLES = ["brain", "main", "research", "intake", "x-voice", "x-scout", "x-audit", "redteam", "gate", "narrate", "vision", "dev-lead", "dev-worker", "dev-tester", "dev-fixer", "dev-review"] as const;
export type Role = (typeof ROLES)[number];
export type Price = { in: number; out: number; cached: number; write?: number };
/** A model's prices; `long`: the rate card for prompts over `overTokens` input tokens (models priced by prompt length). */
export type Pricing = Price & { long?: Price & { overTokens: number } };

const usd = z.number().finite().nonnegative();
const Long = z.object({ overTokens: z.number().int().positive(), priceIn: usd, priceOut: usd, priceCached: usd, priceWrite: usd.optional() }).strict();
const Entry = z.object({
  model: z.string().min(1), backup: z.string().min(1), via: z.enum(["openrouter", "xai"]),
  priceIn: usd.optional(), priceOut: usd.optional(), priceCached: usd.optional(), priceWrite: usd.optional(), longPrompt: Long.optional(),
}).strict().refine((e) => [e.priceIn, e.priceOut, e.priceCached].every((p) => p === undefined) ? e.longPrompt === undefined : [e.priceIn, e.priceOut, e.priceCached].every((p) => p !== undefined), {
  message: "give priceIn, priceOut and priceCached together (or no prices at all: the model is then charged the worst case)",
});
export type Entry = z.infer<typeof Entry>;
const File = z.object({ about: z.string().optional(), openrouter: z.record(z.string(), z.string().regex(/^[a-z0-9-]+\/[a-z0-9.-]+$/)), roles: z.object(Object.fromEntries(ROLES.map((r) => [r, Entry])) as Record<Role, typeof Entry>).strict() }).strict();

export type Registry = { roles: Record<Role, Entry>; prices: Map<string, Pricing>; openrouter: Record<string, string> };

const flat = (p: { priceIn: number; priceOut: number; priceCached: number; priceWrite?: number }): Price =>
  ({ in: p.priceIn, out: p.priceOut, cached: p.priceCached, ...(p.priceWrite === undefined ? {} : { write: p.priceWrite }) });

/** Parse a registry file; refuses unknown/missing roles, partial prices, one model priced two ways, an X-search (xai)
 *  role that is not Grok, and an OpenRouter role whose model or backup has no OpenRouter id. */
export function parseRegistry(json: unknown): Registry {
  const { roles, openrouter } = File.parse(json);
  const prices = new Map<string, Pricing>();
  for (const r of ROLES) {
    const e = roles[r];
    for (const id of [e.model, e.backup]) {
      if (e.via === "xai" && providerOf(id) !== "xai") throw new Error(`models.json: ${r} runs server-side search on xAI direct, so its models must be grok (got ${id})`);
      if (e.via === "openrouter" && !openrouter[id]) throw new Error(`models.json: ${r} uses ${id}, which has no OpenRouter slug`);
    }
    if (e.priceIn === undefined) continue;
    const p: Pricing = { ...flat(e as Required<Pick<Entry, "priceIn" | "priceOut" | "priceCached">>), ...(e.longPrompt ? { long: { overTokens: e.longPrompt.overTokens, ...flat(e.longPrompt) } } : {}) };
    const seen = prices.get(e.model);
    if (seen && JSON.stringify(seen) !== JSON.stringify(p)) throw new Error(`models.json: ${e.model} is priced differently in two roles`);
    prices.set(e.model, p);
  }
  return { roles: roles as Record<Role, Entry>, prices, openrouter };
}

const bytes = readFileSync(new URL("../models.json", import.meta.url));
/** models.json as committed, without env overrides. */
export const BASE = parseRegistry(JSON.parse(bytes.toString("utf8")));

/** Legacy ops env vars → the roles they set. */
const OVERRIDE_ENVS: Record<string, Role[]> = {
  GROK_MODEL: ["main", "research", "intake", "x-voice", "x-scout"], NARRATE_MODEL: ["narrate"], REDTEAM_MODEL: ["redteam"], REDTEAM_GATE_MODEL: ["gate"], MEDIA_VISION_MODEL: ["vision"],
};
export function applyOverrides(reg: Registry, env: Record<string, string | undefined>) {
  const roles = { ...reg.roles };
  const overrides: Partial<Record<Role, string>> = {};
  for (const [k, rs] of Object.entries(OVERRIDE_ENVS)) {
    const v = env[k];
    if (!v) continue;
    providerOf(v); // an id no provider serves fails at boot
    for (const r of rs) {
      if (roles[r].via === "openrouter") slugOf(v, reg); // so does one OpenRouter has no id for
      else if (providerOf(v) !== "xai") throw new Error(`${k}=${v}: ${r} runs server-side search on xAI, grok only`);
      if (roles[r].model !== v) { roles[r] = { ...roles[r], model: v }; overrides[r] = v; }
    }
  }
  return { ...reg, roles, overrides };
}

/** A model's own provider (every call derives it from the model, so a swap may cross providers). */
export function providerOf(id: string): "anthropic" | "xai" {
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("grok-")) return "xai";
  throw new Error(`no provider for model ${id}`);
}

/** OpenRouter's names for a model's own provider: `slug` pins routing (a base slug never matches a service tier such as
 *  anthropic/fast), `name` is what a reply reports as its provider. */
export const ORIGIN = { anthropic: { slug: "anthropic", name: "Anthropic" }, xai: { slug: "xai", name: "xAI" } } as const;
/** A model's OpenRouter id (models.json `openrouter`: the one place they are mapped). */
export function slugOf(id: string, reg: Pick<Registry, "openrouter"> = BASE) {
  const s = reg.openrouter[id];
  if (!s) throw new Error(`no OpenRouter slug for model ${id} (models.json openrouter)`);
  return s;
}

/** Our id for a model string: our own id as is, or the model an OpenRouter id maps to (undefined: neither). */
export const idOf = (s: string, reg: Pick<Registry, "openrouter"> = BASE) =>
  Object.hasOwn(reg.openrouter, s) ? s : Object.keys(reg.openrouter).find((k) => reg.openrouter[k] === s);
/** The models (OpenRouter ids) among `ids` that models.json has no price for. */
export const unpriced = (ids: string[], reg: Pick<Registry, "openrouter" | "prices"> = BASE) => ids.filter((s) => !reg.prices.has(idOf(s, reg) ?? ""));

export const REGISTRY = applyOverrides(BASE, process.env);
/** The model a role uses at boot (the registry plus env overrides; swaps in effect: src/swap.ts activeModel). */
export const model = (role: Role) => REGISTRY.roles[role].model;
/** What a decision record carries about the registry it ran under. */
export const registryInfo = (reg: { overrides: Partial<Record<Role, string>> } = REGISTRY) => ({ sha256: createHash("sha256").update(bytes).digest("hex"), overrides: reg.overrides });

/** Unknown model (e.g. a server-side fallback): the most expensive listed rate of any card. */
const cards = [...BASE.prices.values()].flatMap((p) => (p.long ? [p, p.long] : [p]));
const worst = (k: "in" | "out" | "cached") => Math.max(...cards.map((p) => p[k]));
/** The rate card for a call of `promptTokens` input tokens (cached and cache-written tokens included). */
export function priceOf(id: string, promptTokens = 0): Price {
  const p = BASE.prices.get(id);
  if (!p) return { in: worst("in"), out: worst("out"), cached: worst("cached"), write: worst("in") * 1.25 };
  const { long, ...base } = p;
  if (!long || promptTokens <= long.overTokens) return base;
  const { overTokens: _, ...card } = long;
  return card;
}
