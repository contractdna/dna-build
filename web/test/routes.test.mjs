// Route rendering rules that only show on the production server. In LIVE the root layout awaits connection(), so every
// page renders per request; a route with generateStaticParams is static (ISR) instead, and its runtime render then
// fails with DYNAMIC_SERVER_USAGE (a 500 on `next start`; `next dev` renders everything per request and hides it).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const APP = new URL("../app/", import.meta.url).pathname;
const pages = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "_template" ? [] : pages(join(dir, e.name))) : /^(page|layout)\.tsx$/.test(e.name) ? [join(dir, e.name)] : []);

test("no route uses generateStaticParams (it 500s in LIVE on the production server)", () => {
  const bad = pages(APP).filter((f) => /export\s+(async\s+)?function\s+generateStaticParams|export\s+const\s+generateStaticParams/.test(readFileSync(f, "utf8")));
  assert.deepEqual(bad.map((f) => f.slice(APP.length)), []);
});

test("/journal/[day] renders per request", () => {
  assert.match(readFileSync(join(APP, "journal/[day]/page.tsx"), "utf8"), /export const dynamic = "force-dynamic"/);
});
