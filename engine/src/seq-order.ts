// A Sequencer build order: what the enclave asks the sequencer to build, as a signed `build` log record. The workflow
// (sequencer/) checks the record against the enclave's log signer before anything runs: the hash chain step
// (ehash = sha256(eprev ‖ sha256(body))), the signature over logDigest(ehash, kind, ref), the kind and ref, the expiry
// and the spec's hash. Dependency-light on purpose (zod, viem, canonical): the workflow imports it from the base branch.
import { createHash } from "node:crypto";
import { type Hex, recoverMessageAddress } from "viem";
import { z } from "zod";
import { canonical } from "./canonical.ts";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
/** log.ts chainHash: sha256(prev ‖ sha256(body)). */
export const chainHash = (prev: Buffer, body: string) => sha256(Buffer.concat([prev, sha256(Buffer.from(body, "utf8"))]));
/** log.ts logDigest: what the log key signs for a record. */
export const logDigest = (ehash: string | Buffer, kind: string, ref: string | null) =>
  sha256(Buffer.concat([Buffer.from("dna/log/v1"), typeof ehash === "string" ? Buffer.from(ehash, "hex") : ehash, sha256(canonical([kind, ref]))])).toString("hex");

const hex = (n: number) => z.string().regex(new RegExp(`^0x[0-9a-f]{${n}}$`));
const R = z.number().int().min(0).max(5);
const Roles = <T extends z.ZodType>(t: T) => z.object({ lead: t, worker: t, tester: t, fixer: t, review: t }).strict();
export const DEV_ROLES = ["lead", "worker", "tester", "fixer", "review"] as const;
export type DevRole = (typeof DEV_ROLES)[number];
/** What an order builds: a new game (a contract and its page), new pages of the site (a new route folder), or a new fee or
 *  split module (proposed to the Safe, never switched on by the Sequencer), or a change to the engine (left for an owner
 *  to merge; never merged by the Sequencer). */
export const KINDS = ["game", "site", "module", "engine"] as const;
export type Kind = (typeof KINDS)[number];
/** An order without a kind builds a game (the orders from before kinds existed). */
export const kindOf = (o: { kind?: Kind }): Kind => o.kind ?? "game";

export const Order = z.object({
  v: z.literal(1),
  kind: z.enum(KINDS).optional(),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/),
  build: z.string().regex(/^[a-z0-9][a-z0-9-]{3,63}$/),
  round: z.number().int().min(1).max(4),
  slug: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/),
  salt: hex(64),
  factory: hex(40),
  /** the Safe the factory names (GameKit's `safe` immutable): the game's on-chain code hash depends on it */
  safe: hex(40),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  spec: z.string().min(20).max(4000),
  specSha256: z.string().regex(/^[0-9a-f]{64}$/),
  rubric: z.object({ value: R, fit: R, clarity: R, originality: R }).strict(),
  // OpenRouter ids of Claude models only (the sequencer runs on the Agent SDK). The SDK has no price for some of them and
  // prices those at a guess (Haiku 5.5: about 40× its real rate), so the workflow meters each query itself at
  // models.json prices, and the enclave dispatches no order with a model models.json has no price for
  models: Roles(z.string().max(100).regex(/^anthropic\/claude-[a-z0-9.-]+$/)),
  effort: Roles(z.enum(["low", "medium", "high", "xhigh", "max"])),
  budget: z.object({ ceilingUsd: z.number().positive().max(12), perQueryUsd: Roles(z.number().positive().max(12)) }).strict(),
  fixRounds: z.number().int().min(1).max(3),
  issues: z.array(z.string().max(300)).max(12),
  expiresAt: z.string().refine((s) => /Z$/.test(s) && Number.isFinite(Date.parse(s)), "ISO time in UTC"),
}).strict();
export type Order = z.infer<typeof Order>;

/** The dispatch payload: the stored record as the enclave signed it. */
export const OrderRecord = z.object({
  seq: z.string().regex(/^\d{1,18}$/), kind: z.literal("build"), ref: z.string().max(80), body: z.string().max(20_000),
  eprev: z.string().regex(/^[0-9a-f]{64}$/), ehash: z.string().regex(/^[0-9a-f]{64}$/), esig: z.string().regex(/^0x[0-9a-f]{130}$/),
}).strict();
export type OrderRecord = z.infer<typeof OrderRecord>;
/** An order expires this long after the enclave dispatches it. */
export const ORDER_TTL_MS = 20 * 60_000;
export const orderRef =(o: { id: string }) => `order:${o.id}`;

/** The order inside a dispatched record, or a reason it is refused. `signer`: the enclave's log signer (release.json). */
export async function verifyOrder(raw: unknown, signer: string | null | undefined, nowMs: number): Promise<{ ok: true; order: Order; record: OrderRecord } | { ok: false; why: string }> {
  if (!signer || !/^0x[0-9a-fA-F]{40}$/.test(signer)) return { ok: false, why: "no enclave log signer pinned: every order is refused" };
  const rec = OrderRecord.safeParse(raw);
  if (!rec.success) return { ok: false, why: `malformed record: ${rec.error.issues[0]?.message}` };
  const r = rec.data;
  if (chainHash(Buffer.from(r.eprev, "hex"), r.body).toString("hex") !== r.ehash) return { ok: false, why: "the body does not hash to ehash" };
  const by = await recoverMessageAddress({ message: { raw: `0x${logDigest(r.ehash, r.kind, r.ref)}` as Hex }, signature: r.esig as Hex }).catch(() => null);
  if (!by || by.toLowerCase() !== signer.toLowerCase()) return { ok: false, why: "not signed by the enclave's log key" };
  let body: unknown;
  try { body = JSON.parse(r.body); } catch { return { ok: false, why: "the body is not JSON" }; }
  const o = Order.safeParse(body);
  if (!o.success) return { ok: false, why: `not an order: ${o.error.issues[0]?.path.join(".")} ${o.error.issues[0]?.message}` };
  if (r.ref !== orderRef(o.data)) return { ok: false, why: "the record's ref is not the order's" };
  if (Date.parse(o.data.expiresAt) <= nowMs) return { ok: false, why: "the order expired" };
  // orders live 20 minutes from dispatch: a longer one could be dispatched again later
  if (Date.parse(o.data.expiresAt) - nowMs > ORDER_TTL_MS + 5 * 60_000) return { ok: false, why: "the order expires too far ahead" };
  if (sha256(o.data.spec).toString("hex") !== o.data.specSha256) return { ok: false, why: "the spec does not hash to specSha256" };
  return { ok: true, order: o.data, record: r };
}
