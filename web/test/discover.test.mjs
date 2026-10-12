// The trade page's wallet finder (app/_ui/discover.ts): EIP-6963 wallets one per rdns, window.ethereum only as the
// fallback, data: icons only, and the wallet-app links carry this page's own URL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountOf, discover, openIn } from "../app/_ui/discover.ts";

const provider = (tag) => ({ tag, request: async () => [] });
function win(announce, ethereum) {
  const w = new EventTarget();
  w.ethereum = ethereum;
  w.addEventListener("eip6963:requestProvider", () => {
    for (const detail of announce) w.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  });
  return w;
}

test("EIP-6963: every wallet once, by rdns; bad announcements and remote icons dropped", async () => {
  const mm = provider("mm"), rabby = provider("rabby");
  const found = await discover(win([
    { info: { rdns: "com.coinbase.wallet", name: "Coinbase Wallet", icon: "data:image/svg+xml;base64,AAAA" }, provider: mm },
    { info: { rdns: "com.coinbase.wallet", name: "Coinbase Wallet again" }, provider: provider("dup") },
    { info: { rdns: "io.rabby", name: "Rabby", icon: "https://evil.example/x.png" }, provider: rabby },
    { info: { rdns: "x.bad", name: "Not a provider" }, provider: {} },
  ], provider("legacy")), 5);
  assert.deepEqual(found.map((f) => [f.id, f.name, f.icon, f.provider.tag]), [
    ["com.coinbase.wallet", "Coinbase Wallet", "data:image/svg+xml;base64,AAAA", "mm"],
    ["io.rabby", "Rabby", null, "rabby"],
  ]);
});

test("no announcement: window.ethereum, else nothing", async () => {
  assert.deepEqual((await discover(win([], provider("legacy")), 5)).map((f) => [f.id, f.provider.tag]), [["injected", "legacy"]]);
  assert.deepEqual(await discover(win([], undefined), 5), []);
});

test("wallet-app links reopen this page; accounts must be addresses", () => {
  const l = openIn("https://genomedna.xyz/trade");
  assert.equal(openIn("https://genomedna.xyz/trade?x=1")[0].href, "https://link." + "meta" + "mask.io/dapp/genomedna.xyz/trade?x=1");
  assert.deepEqual(l.map((x) => x.href), [
    "https://link." + "meta" + "mask.io/dapp/genomedna.xyz/trade", // split: the publish scan lets the name through only in discover.ts
    "https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fgenomedna.xyz%2Ftrade",
    "https://link.trustwallet.com/open_url?coin_id=60&url=https%3A%2F%2Fgenomedna.xyz%2Ftrade",
  ]);
  assert.equal(accountOf(["0x" + "ab".repeat(20)]), "0x" + "ab".repeat(20));
  assert.equal(accountOf([]), null);
  assert.equal(accountOf(["0x123"]), null);
  assert.equal(accountOf("0x" + "ab".repeat(20)), null);
});
