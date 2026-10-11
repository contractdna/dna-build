// Model tryouts: a role's golden set (engine/tryout/<role>/*.json: known answers, prompt-injection attempts, planted-bug
// builds) answered by a model, case by case, exactly as the role's real call asks it. Every case must pass for a swap
// (src/swap.ts). Command line: scripts/tryout.ts.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { allowedNumbers, noteCall, type RedTeamIn, redTeamCall, SCREEN_TASK, ScreenOut, textOk } from "./agents.ts";
import { type BrainKind, brainCall } from "./brain.ts";
import { type Call, untrustedCall } from "./llm.ts";
import { canonical } from "./log.ts";
import type { Role } from "./models.ts";
import { selfText } from "./self.ts";
import type { Tryout } from "./swap.ts";
import { factNumbers, factSheet, postFilter, writerCall } from "./voice.ts";

export const Case = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(["known", "injection", "planted-bug"]),
  input: z.unknown(),
  // field → expected value, or the list of acceptable values
  expect: z.record(z.string(), z.union([z.string(), z.boolean(), z.array(z.union([z.string(), z.boolean()])).min(1)])),
}).strict();
export type Case = z.infer<typeof Case>;

/** A fixed self-file for brain cases: the production shape (a level, past decisions with outcomes, an open risk), the
 *  same bytes on every run so tryouts compare like with like. */
export const TRYOUT_SELF = selfText({
  day: "2026-10-01", chain: { level: 5, paused: false },
  rows: [
    { seq: "10", kind: "brain", ref: "verdict:verdict:b20260930-1-r1", at: "2026-09-30T12:00:00.000Z", doc: { kind: "verdict", decision: { verdict: "ship" } } },
    { seq: "11", kind: "ship", ref: "ship:b20260930-1", at: "2026-09-30T12:05:00.000Z", doc: { build: "b20260930-1", verdictSeq: "10" } },
    { seq: "12", kind: "release", ref: "release:a1", at: "2026-09-30T13:10:00.000Z", doc: { build: "b20260930-1" } },
    { seq: "13", kind: "brain", ref: "build:build:q2", at: "2026-09-30T14:00:00.000Z", doc: { kind: "build", decision: { decision: "no-build" } } },
    { seq: "14", kind: "security", ref: "R1", at: "2026-09-30T15:00:00.000Z", doc: { id: "R1", severity: "low", title: "canary windows are predictable", status: "open" } },
  ],
});

/** The call each role makes for a case (the same prompt and schema as in production). */
export const TASKS: Partial<Record<Role, (c: Case, model: string) => Call<z.ZodType>>> = {
  intake: (c, m) => untrustedCall("intake", SCREEN_TASK, String(c.input), ScreenOut, m),
  brain: (c, m) => {
    const { kind, input } = c.input as { kind: BrainKind; input: unknown };
    return brainCall(kind, input, m, TRYOUT_SELF);
  },
  redteam: (c, m) => redTeamCall(false, c.input as RedTeamIn, m),
  gate: (c, m) => redTeamCall(true, c.input as RedTeamIn, m),
  narrate: (c, m) => noteCall(c.input, m),
  // input: the raw event (code reduces it to the fact sheet, as src/x.ts does) and the tone brief
  "x-voice": (c, m) => writerCall(factSheet(voiceIn(c).event), voiceIn(c).tone, m),
};
const voiceIn = (c: Case) => c.input as { event: Record<string, unknown>; tone: string[] };

/** Free-text roles: a case's expected fields are code's verdict on the text, by the checks production applies to it. */
const VERDICTS: Partial<Record<Role, (c: Case, data: unknown) => Record<string, boolean>>> = {
  // src/loop.ts uses a cycle note only if it passes textOk (here before sanitize: an obeyed link fails the case)
  narrate: (c, d) => ({ usable: textOk((d as { note: string }).note, allowedNumbers(c.input)) }),
  // src/x.ts posts the first candidate that passes postFilter. postable: one does; clean: every one does
  "x-voice": (c, d) => {
    const allowed = factNumbers(factSheet(voiceIn(c).event));
    const ok = (d as { candidates: string[] }).candidates.map((t) => !postFilter(t, allowed, true).length);
    return { postable: ok.some(Boolean), clean: ok.every(Boolean) };
  },
};
export const verdictOf = (role: Role, c: Case, data: unknown) => VERDICTS[role]?.(c, data) ?? data;

export function loadCases(role: Role, dir = new URL(`../tryout/${role}/`, import.meta.url)): Case[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const cases = files.flatMap((f) => z.array(Case).parse(JSON.parse(readFileSync(new URL(f, dir), "utf8"))));
  const ids = cases.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error(`tryout/${role}: duplicate case ids`);
  return cases;
}

export const matches = (data: unknown, expect: Case["expect"]) =>
  Object.entries(expect).every(([k, want]) => {
    const got = (data as Record<string, unknown> | null)?.[k];
    return Array.isArray(want) ? want.includes(got as never) : got === want;
  });

export type Ask = (call: Call<z.ZodType>) => Promise<{ data: unknown; costUsd: number }>;
/** Run `model` on the role's cases through `ask` (the live llm(), or a fixture in tests). A thrown call fails its case.
 *  `why` hears each failure's cause: the call's error, or the expected fields as answered. */
export async function tryout(role: Role, model: string, cases: Case[], ask: Ask, why?: (id: string, cause: string) => void): Promise<Tryout> {
  const task = TASKS[role];
  if (!task) throw new Error(`no tryout task for ${role}`);
  const failed: string[] = [];
  let costUsd = 0;
  for (const c of cases) {
    try {
      const r = await ask(task(c, model));
      costUsd += r.costUsd;
      const got = verdictOf(role, c, r.data) as Record<string, unknown> | null;
      if (!matches(got, c.expect)) {
        failed.push(c.id);
        why?.(c.id, `answered ${canonical(Object.fromEntries(Object.keys(c.expect).map((k) => [k, got?.[k] ?? null])))}, expected ${canonical(c.expect)}`);
      }
    } catch (e) {
      failed.push(c.id);
      why?.(c.id, `call failed: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  return { role, model, setSha256: createHash("sha256").update(canonical(cases)).digest("hex"), cases: cases.length, failed, costUsd: Number(costUsd.toFixed(6)) };
}
