// The Genome Vaults as the engine tells them (src/vaults.ts): the fact sheet of each chain event, the code-written posts
// and site lines word for word, the announcement types and priorities, and the knowledge a reply may draw on only once
// the vaults are deployed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PRIORITY, titleOf, typeOf } from "../src/announce.ts";
import { eventPost } from "../src/event-posts.ts";
import { MECHANICS, mechanicsFor } from "../src/mechanics.ts";
import { appendWeight, factNumbers, factSheet, postFilter } from "../src/voice.ts";
import { VAULT_TYPE, VAULT_X_EVENTS, vaultEventAbi, vaultFacts } from "../src/vaults.ts";

const TX = `https://etherscan.io/tx/0x${"ab".repeat(32)}`;
const E = 10n ** 18n;
const state = { live: 12, maxLive: 50, depositDna: 200_000 };
const post = (raw: Record<string, unknown>) => eventPost(factSheet(raw), 280 - appendWeight(TX));

test("vault facts: the event's own numbers (ETH to 4 decimals, DNA whole), the live count only when read", () => {
  assert.deepEqual(vaultFacts({ name: "Minted", args: { id: "3", owner: "0xabc", slot: "7" } }, state), { event: "vault_minted", slot: 7, live: 12, maxLive: 50, lockedDna: 200_000 });
  assert.deepEqual(vaultFacts({ name: "Minted", args: { id: "3", owner: "0xabc", slot: "7" } }), { event: "vault_minted", slot: 7 }, "a failed read states no count");
  assert.deepEqual(vaultFacts({ name: "Funded", args: { fromBlock: "100", toBlock: "200", amount: String(412_300_000_000_000_000n), perToken: String(34_358_333_333_333_333n), eligible: "12" } }),
    { event: "vault_funded", ethTotal: 0.4123, vaults: 12, perVaultEth: 0.0344 });
  assert.deepEqual(vaultFacts({ name: "Funded", args: { fromBlock: "100", toBlock: "200", amount: String(E / 20n), perToken: "0", eligible: "0" } }), { event: "vault_funded", ethTotal: 0.05, vaults: 0 }, "nothing per vault when none was eligible");
  assert.deepEqual(vaultFacts({ name: "Burned", args: { id: "3", owner: "0xabc", eth: String(E / 100n) } }, state, 7), { event: "vault_burned", slot: 7, ethReturned: 0.01, live: 12, maxLive: 50, lockedDna: 200_000 });
  assert.deepEqual(vaultFacts({ name: "Burned", args: { id: "3", owner: "0xabc", eth: "0" } }), { event: "vault_burned", ethReturned: 0 }, "no slot until its mint is indexed");
  assert.equal(vaultFacts({ name: "Claimed", args: {} }), null);
  // the fact sheet keeps every field a post draws on, and never an address
  const sheet = factSheet(vaultFacts({ name: "Minted", args: { id: "3", owner: "0xabc", slot: "7" } }, state)!);
  assert.deepEqual(Object.keys(sheet).sort(), ["event", "live", "lockedDna", "maxLive", "slot"]);
});

test("vault posts and site lines, word for word; a count or a constant the contract did not answer is left out", () => {
  assert.equal(post({ event: "vault_minted", slot: 7, live: 12, maxLive: 50, lockedDna: 200_000 }), "Genome Vault minted: slot 7 of 50. 200,000 DNA locked in it until its owner burns it. 12 vaults live now.");
  assert.equal(post({ event: "vault_minted", slot: 1 }), "Genome Vault minted: slot 1.");
  assert.equal(post({ event: "vault_funded", ethTotal: 0.4123, vaults: 12, perVaultEth: 0.0344 }), "Genome Vaults funded: 0.412 ETH from the treasury. Each of the 12 eligible vaults gets 0.0344 ETH, any remainder from earlier funds included.");
  assert.equal(post({ event: "vault_funded", ethTotal: 0.05, vaults: 0 }), "Genome Vaults funded: 0.05 ETH from the treasury. No vault was eligible yet, so it carries to the next fund.");
  assert.equal(post({ event: "vault_burned", slot: 7, ethReturned: 0.0343, live: 11, maxLive: 50, lockedDna: 200_000 }), "Genome Vault burned: slot 7 is free again. Its owner got the 200,000 DNA back; the 0.0343 ETH it had not collected is theirs too. 11 vaults live now.");
  assert.equal(post({ event: "vault_burned", slot: 7, ethReturned: 0, live: 1, maxLive: 50, lockedDna: 200_000 }), "Genome Vault burned: slot 7 is free again. Its owner got the 200,000 DNA back. 1 vault live now.");
  assert.equal(post({ event: "vault_burned", ethReturned: 0 }), "Genome Vault burned.");
  assert.equal(titleOf({ event: "vault_minted", slot: 7, live: 12, maxLive: 50, lockedDna: 200_000 }), "Genome Vault minted: slot 7 of 50, 200,000 DNA locked in it; 12 vaults live");
  assert.equal(titleOf({ event: "vault_funded", ethTotal: 0.4123, vaults: 12, perVaultEth: 0.0344 }), "Genome Vaults funded: 0.4123 ETH from the treasury, 0.0344 ETH to each of 12 eligible vaults, any remainder from earlier funds included");
  assert.equal(titleOf({ event: "vault_funded", ethTotal: 0.05, vaults: 0 }), "Genome Vaults funded: 0.05 ETH from the treasury; no vault was eligible yet, so it carries to the next fund");
  assert.equal(titleOf({ event: "vault_burned", slot: 7, ethReturned: 0, live: 11, maxLive: 50, lockedDna: 200_000 }), "Genome Vault burned: slot 7 is free again; its owner got the 200,000 DNA back; 11 vaults live");
  assert.equal(titleOf({ event: "vault_burned", ethReturned: 0.01 }), "Genome Vault burned; the 0.01 ETH it had not collected is its owner's");
});

test("vault announcements: by type and priority (the Safe's fund is money, a mint and a burn go with the games); only the three events", () => {
  assert.deepEqual([...VAULT_X_EVENTS].sort(), ["Burned", "Funded", "Minted"]);
  assert.deepEqual(vaultEventAbi.map((e) => (e as { name: string }).name).sort(), ["Burned", "Funded", "Minted"], "the ERC-721 Transfer (the token's signature) is never decoded as DNA's");
  for (const [name, type] of Object.entries(VAULT_TYPE)) assert.equal(typeOf({ event: "vault", name }), type);
  assert.deepEqual([PRIORITY.vault_funded, PRIORITY.vault_minted, PRIORITY.vault_burned], [1, 2, 2]);
});

test("vault knowledge: a reply hears it only once the vaults are deployed; every line postable, numbers the contract's", () => {
  assert.deepEqual(mechanicsFor("vaults", false, false), [], "not deployed: nothing says the vaults are live");
  assert.deepEqual(mechanicsFor("vaults", false), [], "the default is not deployed");
  assert.deepEqual(mechanicsFor("vaults", false, true), MECHANICS.vaults);
  assert.ok(MECHANICS.vaults.length >= 4);
  const all = MECHANICS.vaults.join(" ");
  assert.match(all, /at most 50 live at once/);
  assert.match(all, /locks exactly 200,000 DNA/);
  assert.match(all, /2\.5% royalty to the Safe/);
  assert.match(all, /nothing is promised/);
  assert.match(all, /every vault is equal/);
  assert.ok(!/\bclaim\b/.test(all), "the banned word");
  for (const l of MECHANICS.vaults) assert.deepEqual(postFilter(l, factNumbers({ mechanics: [l] })).filter((i) => i !== "over 280 weighted chars"), [], l);
});
