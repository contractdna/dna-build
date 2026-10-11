// After `SITE_ROLE=play next build`: the wallet guard as built must still be plain async/await (guard.ts runs it
// through Function#toString). A transpiled generator helper would mean the guard calls a patchable global instead.
//   node scripts/check-guard-build.mjs [.next]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".next";
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
walk(join(dir, "server"));
let found = 0;
const bad = [];
for (const f of files) {
  const s = readFileSync(f, "utf8");
  for (let i = s.indexOf("isDNAGuard"); i >= 0; i = s.indexOf("isDNAGuard", i + 1)) {
    found++;
    const around = s.slice(Math.max(0, i - 12_000), i + 12_000);
    for (const h of ["_async_to_generator", "__awaiter", "regeneratorRuntime", "_asyncToGenerator"]) if (around.includes(h)) bad.push(`${f}: ${h} near the guard`);
  }
}
if (!found) { console.error("the guard is not in the server build"); process.exit(1); }
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
console.log(`guard build: plain async/await (${found} place(s) checked)`);
