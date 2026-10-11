// Type-check only (never run; not a *.test.ts): the engine's record schemas (src/records.ts) must infer exactly the web's types
// (web/app/_data/types.ts and its Core, the source of truth). Checked by `npm run
// check` (tsc) in CI; nothing runs. A drift on either side fails the build with "Type 'false' is not assignable to 'true'".
import type { z } from "zod";
import type * as W from "../../web/app/_data/types.ts";
import type * as R from "../src/records.ts";

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const ok = <T extends true>() => true as T;

ok<Eq<z.infer<typeof R.ThreadStep>, W.ThreadStep>>();
ok<Eq<z.infer<typeof R.Thread>, W.Thread>>();
ok<Eq<z.infer<typeof R.Experiment>, W.Experiment>>();
ok<Eq<z.infer<typeof R.Pipeline>, W.Pipeline>>();
ok<Eq<z.infer<typeof R.MemoryEntry>, W.MemoryEntry>>();
ok<Eq<z.infer<typeof R.Epoch>, W.Epoch>>();
ok<Eq<z.infer<typeof R.JournalEntry>, W.JournalEntry>>();
ok<Eq<z.infer<typeof R.SecurityItem>, W.SecurityItem>>();
ok<Eq<z.infer<typeof R.AgentName>, W.Agent>>();
ok<Eq<z.infer<typeof R.Clone>, W.Clone>>();
ok<Eq<z.infer<typeof R.Leakage>, W.Leakage>>();
// engine-written idea statuses are the closed-round subset of the web's Idea status ("open" is chain-derived)
ok<Eq<z.infer<typeof R.IdeaStatus>["status"], Exclude<W.Idea["status"], "open">>>();
ok<Eq<Omit<z.infer<typeof R.CoreRecord>, "stage">, Pick<W.Core, "goal" | "task" | "hypothesis" | "confidence" | "next" | "simulations">>>();
