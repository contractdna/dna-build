// The image's self-test: one check of a planted page (no guard, a wallet request straight to the wallet) on this
// container's own Chromium and anvil, offline. Exit 0 when the check ran and caught it.
//   node pagecheck/src/selftest.ts [chromium path]
import { check, PROFILES } from "./check.ts";
import { PAGECHECK } from "./server.ts";
import { startAnvil } from "./util.ts";

const a = await startAnvil();
try {
  const html = `<html><body><div data-dna-game></div><script>ethereum.request({ method: "eth_chainId" })</script></body></html>`;
  const r = await check({
    origin: "https://play.selftest.invalid", slug: "selftest", game: `0x${"11".repeat(20)}`, factory: `0x${"22".repeat(20)}`,
    backend: { files: { "/g/selftest": { body: html, type: "text/html" } } }, rpc: a.url, chromium: process.argv[2] ?? PAGECHECK.chromium,
    hours: 1, stepHours: 1, rounds: 1, randoms: [0.5], profiles: PROFILES.slice(1),
  });
  const ok = r.runs.length === 1 && r.violations.some((v) => v.kind === "guard") && r.violations.some((v) => /did not come through the guard/.test(v.detail));
  console.log(JSON.stringify({ ok, violations: r.violations.map((v) => `${v.kind}: ${v.detail}`), notes: r.notes }));
  process.exitCode = ok ? 0 : 1;
} finally {
  a.stop();
}
