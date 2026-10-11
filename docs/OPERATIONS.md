# Operations

How the system is run and what to do when something goes wrong. Capacity and cost numbers: [CAPACITY.md](CAPACITY.md).

## Services

| Service | Start | Keys | Notes |
|---|---|---|---|
| engine | `node src/engine.ts` (enclave: the image in `deploy/`) | agent, anchor, log (TEE-derived), keeper; model keys (below) | one replica; `ENGINE_MODE` = `dry_run`, `live` or `halted` |
| indexer | `node src/indexer.ts` | none | writes `chain_log`; exits with code 2 on a reorg past finality (inspect the `cursor` row before restarting) |
| watchdog | `node scripts/watchdog.ts` | none, no database | rebuilds every posted jackpot list from chain data and pages on a mismatch |
| studio | `node src/studio.ts` | the image-model key | outside the enclave; the enclave re-checks every image it returns |
| web | `npm start` in `web/` | read-only database role | `/api/health` reports indexer freshness |

Configuration: `engine/.env.example` (names), defaults in `engine/src/config.ts` and `engine/src/policy.ts`.

## Model keys

One OpenRouter account with one key per consumer, and one small xAI key (routing: [MODELS.md](MODELS.md)):

| Variable | Where | Used for |
|---|---|---|
| `OPENROUTER_API_KEY_ENGINE` | engine (an enclave allowed env) | every engine model call except server-side search |
| `XAI_API_KEY` | engine (an enclave allowed env) | server-side search only, web and X (`research`, `x-scout`) |
| `OPENROUTER_API_KEY_SEQUENCER` | the Sequencer's GitHub build environment | the dev team (Claude Agent SDK) |
| `OPENROUTER_API_KEY_STUDIO` | studio, only with `STUDIO_VIA=openrouter` | post images and their rubric |

Keep each key in the operating system's secret store and pipe it straight into Railway, the CVM's encrypted env or the GitHub secret;
never paste it into a terminal, a file or a chat. On OpenRouter, give each key its own credit limit and a guardrail that
allows only the providers and models it needs (engine: Anthropic and xAI; Sequencer: Anthropic and the `dev-*` models).
The engine pins the provider on every request as well and refuses a reply from any other. A leaked key: revoke it on
OpenRouter (or xAI), put the new one in the same place, redeploy.

## Operator tools

| Script | When | What |
|---|---|---|
| `engine/scripts/route-a.ts build` | before launch | builds the launch package inputs (exact solc 0.8.26 Standard JSON, pack config) from `contracts/` |
| `engine/scripts/route-a-preflight.sh <launch.json>` | before submitting the launch | checks in order: the launchpad still admits our profile and fee policy, our pins on the packed request, the launchpad CLI's byte-identical local validation, then its remote preflight (which allocates, signs and broadcasts nothing); writes `preflight.json` |
| `engine/scripts/compose.ts <params.json>` | each engine release | renders the CVM compose and `deploy/release.json` (see `deploy/README.md`) |
| `engine/scripts/encode-logo.ts <source.mp4>` | when the logo video changes | re-encodes it to X's accepted H.264 profile (1080², 30 fps, no metadata) as `engine/media/dna-logo.mp4`; needs ffmpeg |
| `engine/scripts/plates.ts` | when the fallback plates change | cuts or generates the plates and writes `engine/media/plates/manifest.json` |
| `engine/scripts/owner-digest.ts <approve\|veto> <seq>` | a Safe owner approves or vetoes a delayed record | prints the 32 bytes to sign (below) |

## Owner approvals and vetoes

Some actions wait in public before they happen: an IdeaMarket outcome (1 hour before the agent proposes it on-chain), a
model swap (1 hour). Each is a signed log record with an `effectiveAt`. Two Safe owners can veto one; some need owner
approvals (a brain swap needs two). Drafts (a post's exact text) are approved the same way: one Safe owner's
`approve` signature over the draft's pending record. One owner is enough there because a draft gates a post, not a
fund move. Images on the account's own posts need no approval: one that passes every check posts on its own. The
engine counts a signature only if it recovers to a current `Safe.getOwners()` address read on-chain; Telegram only
carries it.

The persona (who DNA is, what it puts first, how it talks) is a private file, not part of the published source. The
engine reads it from `DNA_PERSONA`, the base64 of the whole file: in the enclave an allowed env set encrypted to the
CVM (the engine refuses to start without a valid one), on Railway a sealed variable. A local run can point
`PERSONA_FILE` at the file instead. Without either, outside the enclave, a neutral built-in default runs. Pipe it, never
paste it: `base64 < persona.md | tr -d '\n' | railway variable set DNA_PERSONA --stdin --service engine`, or append
`DNA_PERSONA=<that output>` to the CVM's encrypted env file the same way. Its sha256 is in every brain decision and
self-file record (`personaSha256`) and on /proof: the text stays private, any change is visible.

The signers' Telegram group id and user ids (`TELEGRAM_GROUP_ID`, `TELEGRAM_ALLOWED_USER_IDS`) are private: in the
enclave they are allowed envs the operator sets encrypted to the CVM, like the bot token, never literals in the public
compose or the release record. The user-id allowlist gates only the brakes (`/halt`, `/dryrun`, `/mute`, `/unmute`,
and `/delete <tweet id>`, which removes one of the account's own posts and nothing else) and the Reject button on a
draft: they only restrict or remove. It approves nothing; the signatures above are the gate for every
approval (drafts included) and every veto. The public log names who used a brake by their place on the allowlist
(`telegram:signer-2`), never by Telegram id; keep the allowlist's order when you change it.

1. The signers' group gets the record's seq (for an outcome: "report 1234 … /veto 1234 <signature>"; for a draft, the
   message ends with "owner-digest.ts approve 1234 … /approve 1234 <signature>").
2. An owner prints the digest: `CHAIN_ID=1 node engine/scripts/owner-digest.ts veto 1234`. It reads the record from
   `/api/log/1234`, refuses one the enclave did not sign or one that is neither a delayed action nor (to approve) a
   pending draft, and shows what it is (kind, ref and `effectiveAt`, or the draft's text and image sha256), the
   enclave's log signer (compare it with the one `/proof` attests) and the digest.
3. The owner signs the digest as an EIP-191 message over its raw 32 bytes with the Safe owner key:
   `cast wallet sign --ledger 0x<digest>` (or `--trezor`).
4. The owner sends `/veto 1234 <signature>` (or `/approve 1234 <signature>`) in the signers' group. The engine replies
   with what it stored, or why not.

A signature binds to one record of one enclave on one chain for one Safe, and to approve or veto only. A veto counts
whenever it arrives, also after `effectiveAt`. Planned: EIP-712 typed data, so the wallet shows the record's kind, ref and
time instead of 32 opaque bytes.

## Rehearsals

- `forge test --mc RehearsalForkTest` with `MAINNET_RPC_URL`: the full launch and first week on a mainnet fork with a real 2-of-3
  Safe, including the veto, pause, breaker and claw-back drills; prints a gas table.
- `engine/scripts/rehearsal.sh`: the operator path with the exact mainnet scripts on an anvil fork, then the indexer,
  the live web build and the engine in `dry_run`.
- `engine/scripts/e2e.sh`: anvil → launch → indexer → web → SSE → engine, in CI.

Last run on the launch commit (2026-10-09):

| Check | Result |
|---|---|
| `forge test` on a mainnet fork | 387 passed, 1 skipped (the funding batch on the live Safe; it passes when run alone with `FUNDING_SAFE` set) |
| Rehearsal, fresh 2-of-3 Safe (v1.4.1) and the project's live Safe (v1.5.0) | pass |
| Launch tx (`launchAndStampV1`, real ERC-1271 path) | 6,659,789 gas (cap 16,777,216) |
| Launch plan on the fork (`Launch.s.sol`) | launch tx 6,634,611 gas, calldata 28,932 B; 7 post-launch deploys 14,461,534 gas; wiring 616,228 gas |
| Post-launch deploys (10 contracts + 4 plates) | 18,265,150 gas |
| Safe T0 batch on the live Safe / pause batch | 1,696,554 / 81,561 gas |
| Universal Router buy / sell, baseline route | 251,824 / 212,652 gas |
| Universal Router sell, worst real route / 3 modules at the gas cap | 301,002 / 415,335 gas |
| Launch (0.5 ETH at the opening tick 201107), 2026-10-11 fork | buys 111.4M DNA with 0.2395 ETH (price to tick 198744), locks 0.2605 ETH + 111.3M DNA full-range at 0xdEaD, burns the ~47k DNA excess; launch tx 7,787,340 gas |
| ABI check (`engine/scripts/abi.ts`) | no drift |
| `rehearsal.sh` operator path (Safe 2-of-3, envelope, the launchpad's signature, launch with the opening tick 201107 and the LP NFT at 0xdEaD, post-launch, T0 batch from the Transaction Builder JSON) | pass; it stops at the indexer's database migration (no local database); `e2e.sh` covers the indexer, web and engine in CI on a local chain |
| Launch package (`route-a.ts build` draft → pack → local validate), 2026-10-08 | valid against the pack-config and request schemas |

## Incident playbooks

**Unexpected queued op (1 h window).** Every registry op is executable by anyone 1 h after `Queued`; that hour is the
Safe's veto. The engine posts every `Queued` to the signers' channel. Decode the op; anything unexpected → Safe
`cancel([id])`. Several bad ops or a suspected key compromise → one batch `pauseAgent` + `cancel([all pending ids])`.
After execution: `endCanary` for a canary, `rollback(0)` for an active module, `lowerLevel(n)` or `pauseAgent`.

**Jackpot list mismatch (1 h window).** A posted list can be drawn from 1 h after `postList`. If the watchdog pages a
mismatch or "not verified", the Safe calls `cancelList(window)`; the pot carries over. Check any list yourself with
`node engine/scripts/verify-draw.ts --window <n> --rpc <url1>,<url2>`.

**Breaker tripped** (3 module failures in 300 blocks). The engine sends `rollback(0)`; if it is down, anyone can.

**Bad module** (works but harms). Canary → `endCanary`; active → `rollback(0)`; pending ops for it → `cancel`.

**Agent key compromise.** `pauseAgent` (instant), cancel all pending agent ops in one transaction, claw back any bounty
allowance, then queue `SetAgent(new)` and redeploy the engine.

**Anchor key compromise.** It can only emit `Anchored` events: announce that roots from that key after a given block are
void, then queue `SetAnchorKey(new)`.

**Engine down.** Restart. If it misbehaves, the operator channel's `/halt` (persists across restarts). The contracts are
safe without it: anyone can execute due ops, roll back a tripped breaker and call the permissionless keepers; signers
watch `Queued` events directly while it is down.

**Indexer stale / RPC outage.** Restart the indexer (respect exit code 2); `RPC_URL` takes a fallback list.

**Leaked bot or X token.** Revoke and reissue at the provider, update the sealed env, redeploy; `/mute` stops posting at
once.

Reading pending ops:

```bash
N=$(cast call $REGISTRY "nextId()(uint256)" --rpc-url $RPC)
for id in $(seq 1 $N); do echo "id=$id $(cast call $REGISTRY "queued(uint256)(uint8,address,uint64,bytes)" $id --rpc-url $RPC | head -3 | tr '\n' ' ')"; done
# pending = queuedAt (3rd value) ≠ 0; agent ops = proposer (2nd value) = the agent address
```
