// Small helpers: free loopback ports, polling, and the check's own anvil (offline: it only loads a state dump).
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  s.on("error", reject);
});

export async function waitFor(ok: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`not ready after ${ms} ms`);
}

let id = 0;
/** One JSON-RPC call. */
export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { code: number; message: string } };
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
  return j.result as T;
}

export type Anvil = { url: string; stop: () => void };
/** What the chain looks like beyond its state: the staging head's base fee and block producer (a zero coinbase, or a
 *  default base fee, would tell a page it is on a test chain). */
export type ChainLook = { baseFee: string; coinbase: string };
/** anvil on loopback, chain id 1, no fork (it reaches nothing). `state`: a dump (anvil_dumpState's hex) to load (its
 *  block number and time come with it); `look`: the base fee and coinbase to carry on with; `extra`: more flags. */
export async function startAnvil(state?: string, look?: ChainLook, extra: string[] = []): Promise<Anvil> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "pc-anvil-"));
  const args = ["--port", String(port), "--host", "127.0.0.1", "--chain-id", "1", "--silent", ...(look ? ["--base-fee", String(BigInt(look.baseFee))] : []), ...extra];
  const p: ChildProcess = spawn("anvil", args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir }, stdio: "ignore", detached: true });
  const stop = () => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); };
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitFor(() => rpc(url, "eth_chainId").then(() => true, () => false), 30_000);
    if (state && (await rpc(url, "anvil_loadState", [state])) !== true) throw new Error("anvil did not load the state dump");
    if (look) {
      await rpc(url, "anvil_setCoinbase", [look.coinbase]);
      // anvil lowers the base fee on every empty block; the pin holds for exactly one block (never anvil_mine)
      await rpc(url, "anvil_setNextBlockBaseFeePerGas", [look.baseFee]);
      await rpc(url, "evm_mine");
    }
  } catch (e) {
    stop();
    throw e;
  }
  return { url, stop };
}
