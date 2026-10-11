// The watchdog's balances-only mode (scripts/watchdog.ts --balances-only or WATCHDOG_MODE=balances): it boots with no
// deployment file and no RPC, runs only the balance loop and answers /health.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const script = new URL("../scripts/watchdog.ts", import.meta.url).pathname;

async function boot(args: string[], env: Record<string, string>) {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", PORT: String(port), CHAIN_ID: "999999", ...env } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  try {
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      if (r) return { status: r.status, body: await r.json(), out };
      if (child.exitCode !== null) return { status: 0, body: null, out };
      await new Promise((res) => setTimeout(res, 100));
    }
    return { status: 0, body: null, out };
  } finally { child.kill(); }
}

for (const [how, args, env] of [["--balances-only", ["--balances-only"], {}], ["WATCHDOG_MODE=balances", [], { WATCHDOG_MODE: "balances" }]] as const) {
  test(`${how}: boots without a deployment file or RPC and serves /health`, async () => {
    const r = await boot([...args], { ...env, FUNDED_USD_X: "25" });
    assert.equal(r.status, 200, r.out);
    assert.equal(r.body.mode, "balances");
    assert.equal(r.body.ok, true);
    assert.match(r.out, /balances only/);
    assert.match(r.out, /X API skipped \(no X_BEARER_TOKEN\)/);
  });
}

test("without the mode the full watchdog still needs its deployment file", async () => {
  const r = await boot([], {});
  assert.equal(r.status, 0);
  assert.match(r.out, /ENOENT|999999/);
});
