# Architecture

Three parts: immutable contracts that set the limits, an engine that acts inside them, and a site that shows and
proves what happened. The contracts never depend on the engine: trading, fees, payouts and the safety switches work
without it.

## Contracts (`contracts/`)

| Contract | Role |
|---|---|
| `DNAToken` | ERC-20, 1B supply minted once to `Bootstrap`, burnable, no owner, metadata is a pure literal |
| `DNAHook` | The pool's only hook. Charges the project fee on the ETH leg, routed to a fee module (Active, plus a Canary on a slice of blocks, plus a Shadow sample); clamps every result to the 5% cap and falls back to the baseline on any module failure; trips a breaker after 3 failures in 300 blocks |
| `ModuleRegistry` | The only way to change the hook's route or a module's parameters: every op is queued for ≥ 1 h and executable by anyone after that. Proposers are the agent (within its autonomy level) and the Safe; the Safe can cancel, pause the agent and lower its level instantly |
| `FeeVault` | Holds the project fee (ERC-6909 claims) and splits it by the split module, inside fixed bounds |
| `BuybackBurn`, `LiquidityVault` | Buy DNA and burn it; add ETH-only liquidity that can never be removed |
| `GamePot`, `ConvictionVault`, `MutationBoard` | Holder jackpot (VRF draw over a posted, vetoable ticket list) and idea rewards (queued 1 h, Safe can cancel), staking weights, the ballot / mystery games |
| `IdeaMarket`, `BountyBoard` | Staked idea submissions and bounties |
| `Bootstrap`, `PlatformRevenue` | One-shot launch (both positions owned by `0xdEaD`: the supply, and the launch buy's DNA + the rest of the ETH full-range); the launchpad's fee to its fixed recipient |
| `modules/` | `AdaptiveFee` (fee = base + mult × volatility, capped), `BaselineSplit` |

Full design: [contracts/SPEC.md](../contracts/SPEC.md).

## Engine (`engine/`)

One Node process (`src/engine.ts`): a Postgres-backed job queue and scheduler, the chain watcher, keepers, the agent
loop, the X pipeline and the operator channel. Separate services: the indexer (`src/indexer.ts`, no keys), the jackpot
watchdog (`scripts/watchdog.ts`, no keys, no database) and the media studio (`src/studio.ts`, outside the enclave).

The agent loop (`src/loop.ts`), every 15 minutes:

1. **Observe** finalized chain data (two RPC providers must agree on the block hash).
2. **Hypothesis**: a model proposes a parameter vector; code clamps it to the registered bounds.
3. **Simulate**: replay recent swaps on a mainnet fork with the candidate (safety) and estimate revenue analytically.
4. **Red team**: a second model looks for reasons to stop.
5. **Decide**: deterministic gates AND red team ≠ block AND the main model's go. Any can stop; none can force.
6. **Act**: queue the registry op; the state machine drives Shadow → Canary → Active, with kill checks every tick.

Every step is a record in a hash-chained log. Untrusted text (X mentions, ideas, web pages) reaches models only through a
quarantined reader whose output is schema-checked data, never instructions.

### Enclave build

`ENCLAVE=1` (a literal in the hashed compose file) turns on: keys derived in the TEE (agent, anchor, log signer), an env
lockdown that refuses any variable outside `ALLOWED_ENVS` and the compose literals, no CLI and no operator path to the
agent key, signed state rows, the enclave's own log chain (the database is transport only), and a boot check against
log-head rollback. The image is reproducible (`.github/workflows/image.yml`); the compose hash that pins it must be on
the on-chain DstackApp allow-list. The first hash is allowed when the DstackApp is created; every later change goes
through a public 1 h timelock.

## Web (`web/`)

Next.js. Reads Postgres (written by the indexer and the engine) and one `LISTEN` channel for the live feed; it never
calls an RPC per visitor. `/proof` re-runs the attestation and record checks in the browser; `/api/log/<n>` serves the
signed records that on-chain anchors point to.

## Data flow of one change

```
model proposal → clamp → fork replay + gates → red team → record (signed) → registry.queue (agent key)
  → 1 h public queue (Safe may cancel) → keeper executes → Shadow → Canary (kill checks) → Active or rollback
  → daily log head anchored on-chain (anchor key)
```
