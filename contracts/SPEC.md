# DNA contracts: design specification

This document specifies the DNA token, its Uniswap v4 hook and the contracts around them: what each contract does, the
constants it enforces, who may call what, and the invariants the test suites check. Section numbers are stable; source
comments cite them as `SPEC §n`.

- Token: DNA (symbol DNA).
- Toolchain: solc 0.8.26, EVM cancun, Foundry, OZ 5.7 (`cab19933`), OZ uniswap-hooks v1.1.1 (`bd5287c`, `BaseHook`),
  v4-core `d153b048` (ABI = deployed v4.0.0), v4-periphery `9969eec`, forge-std v1.17.0. All five are pinned as git
  submodules.
- Mainnet: PoolManager `0x000000000004444c5dc75cB358380D2e3dE08A90`, PositionManager
  `0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e`.

## 0. Contract set and deployment
| Contract | Stamped in launch graph | Constructor (no cycles) | Initializer |
|---|---|---|---|
| DNAToken | yes | `(bootstrap)` mints SUPPLY to it; metadata is a `pure tokenURI()` literal (no storage) | — |
| DNAHook | yes | `(poolManager, token, registry, feeVault, platformRevenue, buybackBurn)` — all addresses precomputed | — |
| Bootstrap | yes (the only initializer) | `(safe, positionManager, factory)`; factory = Programmable's `ProgrammableCreate2GraphDeployerV1` `0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887` (deploys every target, then calls each initializer with `msg.sender` = itself; same contract on route A and B) | factory-only `initialize(token, hook, launchParams)` |
| PlatformRevenue | yes | `(poolManager, recipient)` | — |
| ModuleRegistry, FeeVault, BuybackBurn, LiquidityVault | **no**: deployed right after launch via CREATE2 deployer `0x4e59…956c` at precomputed addresses | `(…, initializer = Safe)` — never the hook address. FeeVault never uses the hook, so it takes no initializer | `initialize(hook)` once, only `initializer`, only if `hook.code.length != 0` |
| IdeaMarket, BountyBoard | **no**: deployed after ModuleRegistry via CREATE2 deployer `0x4e59…956c` with the post-launch salt (idempotent re-runs); nothing references their addresses | IdeaMarket `(token, registry)`, BountyBoard `(registry)`; both cache `safe = registry.safe()` | — |
| ConvictionVault, GamePot, MutationBoard | **no**: post-launch CREATE2 (§9, §12–§14) | see §12–§14 | ConvictionVault `initialize(gamePot)`, GamePot `initialize(hook)` |

- ERC-6909 `mint(to, …)` credits addresses with or without code, so fees accrue safely to vaults not yet deployed.
- Hook with a code-less registry = baseline fee, no route (`setRoute` is registry-only; a code-less address can't call).
- `initializer = Safe` is baked into the vault initCode → vault addresses → hook immutables → mined hook salt. Fix it
  before salt mining.
- The launch graph's `components[]` must be sorted and `resultIndex` must point at the hook (launch-pipeline step).
- Launch route A: Programmable's self-serve API V3 packs the four graph targets (`engine/scripts/route-a.ts`): exact
  `solc 0.8.26+commit.8a97fa7a`, one Standard JSON; the packer derives the namespace, the CREATE2 addresses and the hook
  salt (mask `0x3fff`). The request (profile 3.6.0) pins the platform share at 3,000 hundredths of a bip =
  `PLATFORM_FEE`, and the project fee at 22,000 = `BASELINE_PROJECT_FEE` (25,000 effective).
- Launch gas: `launchAndStampV1` must fit the 16,777,216 transaction gas cap with a budget of ≤ 14M; `forge build
  --sizes` and a fork measurement check it (≈ 6.5M measured).

## 1. Constitution constants (immutable bytecode)
| Name | Value | Where |
|---|---|---|
| SUPPLY | 1,000,000,000e18 | DNAToken |
| MAX_PROJECT_FEE | 50_000 pips (5.00%; 5.30% to the trader with PLATFORM_FEE) | DNAHook |
| BASELINE_PROJECT_FEE | 22_000 (2.20%; 2.50% with the platform fee) | DNAHook |
| LAUNCH_PROJECT_FEE / LAUNCH_DECAY | 30_000 (3.00%) at pool initialization, linearly down to the 2.2% baseline over 1 hour (traders: 3.3% → 2.5%) | DNAHook |
| PLATFORM_FEE | 3_000 (0.30%) on top, same gross ETH basis (= the 3,000 hundredths of a bip Programmable's profile 3.6.0 binds) | DNAHook |
| CANARY_MAX_DELTA | 10_000 (±1 point vs active) | DNAHook |
| MODULE_GAS_CAP / guard | 40_000 / revert if `gasleft() < k·cap + 30_000`, k = 2 in a canary window (active + canary calls), else 1 | DNAHook |
| SHADOW | every 10th swap, 30_000 gas, gasleft-guarded, failures ignored | DNAHook |
| BREAKER | N = 3 failures within M = 300 blocks, counter reset on every route change | DNAHook + Registry |
| MIN_DELAY | 1 h (registry's own queue, every op: agent and Safe; the Safe's veto window) | ModuleRegistry |
| PARAMS_EPOCH | 1 h (one executed setParams per module per epoch) | ModuleRegistry |
| MIN_CANARY_WINDOW | 50 blocks | ModuleRegistry |
| MAX_AGENT_PENDING | 8 queued agent ops | ModuleRegistry |
| AGENT_ROLLBACK | level ≥ 5, cooldown 1 h, ≤ 3 / 24 h | ModuleRegistry |
| LEVEL_RAISE_PREDICATE | ≥ 5 days (5 × 7200 blocks) since last rollback | ModuleRegistry |
| MAX_LEVEL | 10 (constructor and `SetLevel` revert above it) | ModuleRegistry |
| LEVEL bitmaps | L4–L10 constant bitmaps (§3 ladder table) | ModuleRegistry |
| ALLOWANCE_LEVEL | 7: agent spends the bounty allowance | BountyBoard |
| SPLIT bounds | buyback 2000–5000, LP 2000–5000, treasury 1000–4000 bps; games 0–2000; valid iff in bounds and sum = 10_000, else the immutable baseline 3500/3500/3000/0 (games off) | FeeVault |
| MIN_DISTRIBUTE | 0.05 ETH | FeeVault |
| BUYBACK | price limit sqrtP·9975/10000 (0.50% price), max 1 ETH, min 1e12 wei (dust: `NothingToBuy`), cooldown 1 h (caps buyback throughput at ≤ 24 ETH/day) | BuybackBurn |
| PoolKey | (ETH, DNA, DYNAMIC_FEE_FLAG, tickSpacing 1, hook) | DNAHook |

## 2. DNAHook (immutable, all 14 flags, OZ BaseHook; every callback implemented)
- Address mined so low 14 bits = `0x3fff`.
- `beforeInitialize`: only `(ETH, token, DYNAMIC_FEE_FLAG, 1, this)`, once → `poolId`, and records
  `launchedAt = block.timestamp` (the launch-fee clock; nothing else writes it). Otherwise revert.
- **Launch fee (baseline only):** `base = elapsed ≥ 1 h ? 22_000 : 22_000 + 8_000·(3600 − elapsed)/3600` (floor),
  `elapsed = now − launchedAt`. `base` replaces the flat baseline everywhere the baseline applies: the empty route, a
  failing module (breaker fallback) and the canary clamp's reference when no module is active. An active or canary
  module's own answer is never changed. After the hour `base` is exactly 22_000, so nothing differs from the flat
  baseline. `baselineFee()` reads it.
- `afterInitialize`: no-op (dynamic LP fee starts at 0; never changed). A future Uniswap protocol fee would still apply
  on top — disclosed.
- Liquidity + donate callbacks: selector / zero delta, no external calls; **remove never reverts**.
- `beforeSwap(sender, key, params)`:
  1. `key.toId() == poolId`.
  2. `sender == buybackBurn` → pips 0 and no module call: DNA's own buybacks pay no project fee, only the platform
     fee, through the same fee path as any swap (steps 4–5 and `afterSwap`, partial-fill check included).
  3. Else pips:
     - `if (gasleft() < k·MODULE_GAS_CAP + 30_000) revert OutOfGasBudget()` (k = 2 in a canary window, else 1). No
       module call at all (empty route) ⇒ no guard.
     - Route (pushed by registry): `active`, `activeParams`, `canary`, `canaryParams`, `window {start, every, len,
       phase}`, `shadow`, `shadowParams`.
     - In canary window and canary set → call canary; clamp result to `[active − 1pt, active + 1pt]` where `active` =
       active module's result for the same ctx (or baseline). Else call active.
     - `staticcall{gas: MODULE_GAS_CAP}`, copying at most 32 bytes back; revert / returndata length ≠ 32 / value >
       uint24 → baseline (`base`, the launch fee during the first hour) + `_fail()`; the word is read as uint256 (never
       `abi.decode` into uint24, which would revert the swap); clamp to `[0, MAX_PROJECT_FEE]`.
     - Window check only if `canary != 0 && canaryPeriod != 0 && block.number >= canaryStart` (no modulo by zero).
     - Every 10th swap (`swapCount` counts buybacks too; cadence only): shadow staticcall (only if
       `gasleft() > 30_000 + 30_000`; short gas ⇒ skipped, never failed), `emit ShadowFee(shadow, pips)`.
  4. Transient-store pips.
  5. ETH specified: `fee = exactIn ? fromGross(amt, pips+PLATFORM_FEE) : fromNet(amt, pips+PLATFORM_FEE)`;
     `project = floor(gross·pips/1e6)`; `platform = fee − project`; mint (skip zeros) project → FeeVault, platform →
     PlatformRevenue; return `toBeforeSwapDelta(fee, 0)`.
- `afterSwap`: ETH specified → assert native leg == expected (else `PartialNativeFill`). ETH
  unspecified → fee from the actual ETH delta `e`: exact-in sell (DNA in, ETH out) `fee = fromGross(e, T)`, gross = e;
  exact-out buy (DNA out, ETH in) `fee = fromNet(e, T)`, gross = e + fee (fromGross here would under-charge:
  T/(1+T)); mint, return `int128 fee`. There is no partial-fill check on an unspecified DNA leg: the trader's own
  slippage limit covers it. Update observables on every swap, buybacks included (one packed slot: `lastTick`, `volEma`,
  `lastBlock`, `swapCount`). Never
  calls `swap`, `modifyLiquidity`, or `unlock`.
- `setRoute(Route)`: registry-only; resets `(failCount, windowStart)`.
- `_fail()`: `if (block.number > windowStart + 300) {failCount = 1; windowStart = block.number;} else failCount++` ;
  `emit ModuleFailed(...)`.
- Views: `poolKey()`, `route()`, `observables()`, `breaker() returns (failCount, windowStart)`. Pool manager:
  BaseHook's public `poolManager()`.

## 3. ModuleRegistry (queue + roles + autonomy + anchors)
- Roles: `safe` (immutable), `agent` (rotatable via queue), `anchorKey` (rotatable via queue), `agentPaused` flag.
- Modules: `register(addr, kind, specHash, paramBounds)` queued: the Safe registers anything; the agent (L10) only
  Safe-approved bytecode (below). Stores `extcodehash`, re-checked on every advance. Status:
  `Proposed → Shadow → Canary → Active`. Explicit transitions only:
  - `Proposed → Shadow` (setShadow), `Shadow → Canary` (setCanary), `Canary → Active` (promoteActive).
  - **Plate reuse:** a module displaced from the shadow slot (setShadow of another), the canary slot (setCanary of
    another) or the active slot (promoteActive of another; Fee and Split), or ended by `endCanary`, returns to
    `Proposed`, so pre-registered plates rotate indefinitely without re-register.
  - `rollback` → `RolledBack` (rollback is for harm), terminal until a fresh `register` (only from `None` / `Retired` /
    `RolledBack`). `Retired` is unreachable; the enum value is kept for ABI stability.
  - Split modules have no shadow/canary slot (FeeVault reads only `splitRoute()`): their Shadow/Canary are
    bookkeeping, nothing is displaced.
- Queue: `queue(op)`; agent may queue only ops its level allows (below), max 8 pending, not when paused; `execute(id)`
  anyone after `queuedAt + MIN_DELAY` (immutable, own check), re-judging an agent op on current state (proposer still
  agent, unpaused, level, module kind/status, approval, live codehash); `cancel(ids[])` Safe-only batch.
- Ops (internal only, no arbitrary calls): `register`, `setShadow`, `setCanary(window.len ≥ 50)`, `promoteActive`,
  `setParams` (within registered bounds, one per module per `PARAMS_EPOCH` = 1 h), `setAgent`, `setAnchorKey`,
  `setLevel` (≤ 10; raise needs ≥ 5 days since last rollback), `unpauseAgent`,
  `approveCodehash(codehash, kind, minParams, maxParams)` (needs min ≤ max), `revokeCodehash(codehash)`.
  - `setParams` has no per-step limit by design (disclosed): at level 6+ the AI can move the live fee anywhere within
    its registered range (launch: 1%–3.5%) once per hour; the range and the 5% cap are the only limits.
- Immediate (lock-fast): `pauseAgent()` Safe; `lowerLevel(n)` Safe; `rollback(kind)` by Safe, agent (level ≥ 5,
  cooldown 1 h, ≤ 3/day, not paused), or anyone when `hook.breaker().failCount ≥ 3` (the hook already scopes the count
  to its 300-block window; the registry does not re-implement it) → active/canary cleared to baseline, module
  `RolledBack`, `lastRollbackBlock = block.number` (resets the 5-day level-raise clock; never auto-lowers the level).
- `endCanary()` immediate, by the Safe or the agent (level ≥ 5, not paused): reverts `NoCanary` without a Fee canary
  and `BreakerTripped` while tripped (a push resets the breaker; only rollback may change the route then); clears the
  canary slot + window, canary module → `Proposed` (reusable), pushes the route, `CanaryEnded(module, by)`. Not a
  rollback: `lastRollbackBlock` and the agent rollback quota are untouched. It is an immediate veto for the L5 agent over
  any canary, the Safe's included, and the route push resets the hook's breaker counter. Non-escalating (it can only
  remove the canary, never route anything new); the Safe's recourse is `lowerLevel(4)` or `pauseAgent()`.
- Autonomy ladder. Levels are raised only by the Safe via queued `setLevel` (5-day rule: ≥ LEVEL_RAISE_BLOCKS since the
  last rollback), lowered instantly by `lowerLevel`. Bitmaps are `constant`s, cumulative; bit i = Op(i) plus
  `ROLLBACK_BIT`, `END_CANARY_BIT`, `ACTIVE_PARAMS_BIT` (setParams on the active Fee module), `SPLIT_BIT` (any module op
  on a Split-kind module). An agent op needs its Op bit, plus `SPLIT_BIT` for a Split module, plus `ACTIVE_PARAMS_BIT`
  for setParams on the active Fee module, plus an approval for register.

  | Level | Agent may (adds to the level below) |
  |---|---|
  | ≤ 3 | nothing on-chain |
  | 4 | setShadow (Fee) |
  | 5 | setCanary (Fee), setParams on non-active Fee modules (proposed / shadow / canary plates), rollback, endCanary |
  | 6 | setParams on the active Fee module |
  | 7 | BountyBoard allowance: fund own proposals from it, award allowance-funded bounties (§11) |
  | 8 | promoteActive (Fee), queued 1 h |
  | 9 | split-kind module ops: setShadow / setCanary / promoteActive / setParams on Split modules |
  | 10 | register, only bytecode whose `extcodehash` the Safe approved (`approveCodehash`), same kind, registered bounds inside the approved bounds; starts `Proposed` |

  Agent can never: setAgent, setAnchorKey, setLevel, unpauseAgent, approveCodehash, revokeCodehash, cancel, pause,
  lowerLevel, register un-approved bytecode.
- Pushes route + params to the hook on every change. The split route is pulled: FeeVault reads `splitRoute()`.
- `setCanary` requires `50 <= len < period`. `execute` reverts while the breaker is tripped (a route push resets the
  hook's counter, so only `rollback` may change the route then).
- `anchor(root, uri)` by anchorKey → event.

### 3.1 Launch configuration (registry, T0)
- Safe queues `register` for **3 AdaptiveFee plates** (separate deployments of the same bytecode, Kind.Fee) with bounds
  that keep the project fee in **1%–3.5%**. AdaptiveFee params are `[0] base pips, [1] multiplier ×1e4, [2] cap pips,
  [3] unused` and the fee is `min(base + mult·volEma/1e4, cap)`, so bound both pip words:
  `minParams = [10_000, multMin, 10_000, 0]`, `maxParams = [35_000, multMax, 35_000, 0]`. Then every in-bounds fee is
  ≥ min(base, cap) ≥ 10_000 (1%) and ≤ cap ≤ 35_000 (3.5%) whatever the multiplier; `multMin/multMax` only shape the
  volatility response.
- Launch set (`script/Launch.s.sol` `feeBounds` / `plateParams`): bounds `[10_000, 1_000, 10_000, 0]`–
  `[35_000, 18_000, 35_000, 0]` (multiplier 0.1×–1.8×); plates A `[15_000, 3_000, 35_000, 0]`,
  B `[20_000, 10_000, 35_000, 0]`, C `[25_000, 18_000, 35_000, 0]`. Low multipliers matter: launch-day `volEma` is
  large, and a plate pinned at its cap gives the loop no signal (DevActions, local only, uses 10_000–18_000). The hook's
  ±1 pt canary clamp and 5% cap still apply on top.
- Same T0 batch: `register` **BaselineSplit** (Kind.Split; params ignored, so `p = min = max = 0`).
- Timing: the T0 registers are executable at T0 + 1 h, so the first shadow → canary → promotion can land within hours
  of T0 (each step one 1 h queue). Every queued op, the agent's included, is executable by anyone 1 h after `Queued`:
  that hour is the Safe's whole veto window (`cancel`, or `pauseAgent` / `lowerLevel`, both immediate). Signers must be
  reachable within 1 h.
- The plates then rotate shadow → canary → (endCanary / displaced) → Proposed → shadow without re-register; a
  rolled-back plate needs a fresh Safe `register`.
- `multMax` must stay < 2^32: AdaptiveFee reads the multiplier as `uint32` (low 32 bits), so a larger bound would let
  in-bounds values wrap.
- Before raising to L10: `approveCodehash(AdaptiveFee codehash, Fee, minParams, maxParams)`. Approval is per codehash,
  so it covers every deployment of that bytecode, including plates the Safe rolled back; `revokeCodehash` to withdraw.
  - Approve only codehashes of modules whose behaviour is fully determined by runtime bytecode + calldata (pure /
    view-of-calldata, no storage reads). `extcodehash` doesn't cover constructor-written storage, so an L10 agent could
    deploy a copy of approved bytecode with its own stored values under the Safe's approval. Review the constructor
    before every `approveCodehash`.
  - `revokeCodehash` is queued (1 h) but the Safe's `cancel` is immediate: to stop a pending agent `register`, cancel it
    at once (and queue the revoke). The Safe wins the race.

## 4. Vaults
- **FeeVault** `distribute()` (anyone, balance ≥ 0.05 ETH): read split policy route from registry, staticcall
  gas-capped, exactly 4 words (128 B) back or baseline; valid iff in bounds and sum = 10_000, else baseline.
  `totalDistributed` sums every distributed amount. ERC-6909 `transfer` buyback share → BuybackBurn, LP share →
  LiquidityVault, game share → GamePot (skipped when 0); treasury share via unlock → burn → `take` ETH to Safe.
  Rounding remainder → treasury.
- **PlatformRevenue**: claims; `claim()` anyone → unlock, burn, `take` to immutable recipient.
- **BuybackBurn** `process()` (anyone, cooldown 1 h): size = min(claims, 1 ETH). `NothingToBuy` (a revert: the
  cooldown is not spent) when size < `MIN_SIZE` (1e12 wei; the keeper never calls on less) or when `out` below is ≤ 0.
  Unlock → swap ETH→DNA **exact-out** for `out = c·P(limit) − (2^32 + 64)` DNA with limit sqrtP·9975/10000
  (> MIN_SQRT_PRICE), where `g = size·(1 − 0.30%)` and `c = (g − 64)·(1 − 0.10%) − 128` → burn exactly the claims
  spent (pool ETH + fee) → take DNA → `token.burn(all)`; the rest stays as claims.
  - Spent ≤ size in any pool state: each DNA costs ≤ 1/P(limit) ETH; the buffers cover v4's rounding over ≤ 64 swap
    steps in the 0.5% band (< 2 wei ETH and < 1 wei DNA a step, and < 2^32 DNA wei from the last step's Q96 price
    rounding since L < 2^128) and the highest protocol fee v4 allows (0.10%, added to an exact-out swap's ETH); so
    pool ETH ≤ g, and g + fromNet(g) ≤ size. Proof: `BuybackBurn.unlockCallback`.
  - Pays no project fee, only the 0.30% platform fee (`PLATFORM_FEE`, = the hook's): exact-out puts ETH on the
    unspecified side, so the hook charges it on the ETH that actually filled, and a fill stopped by the limit is a
    partial fill, not a revert (an exact-in buy stopped short reverts `PartialNativeFill`).
  - The limit is relative to spot at execution (no TWAP): a front-runner can move spot first, but gains ≤ 0.5% × 1 ETH
    per hour while paying the trading fee (2.5% after the launch hour) on both legs. Accepted, as in CLAUS.
- **LiquidityVault** `add()` (anyone, cooldown 4 h, fixed `WIDTH = 2_000` ticks, so callers cannot choose the shape):
  `tick` from slot0; `lower = tick + 2`, `upper = min(lower + WIDTH, MAX_TICK)`; `L = getLiquidityForAmount0(budget)`;
  `need = getAmount0Delta(…, roundUp)`; burn exactly `need`; `modifyLiquidity(+L, salt = counter)`; assert zero deltas.
  No decrease path.

- Deploy checklist: `PlatformRevenue.recipient` and the Safe receive ETH via `take` (plain call with value) and are
  immutable — verify both accept plain ETH before deploying, or claims are stuck forever.

## 5. Bootstrap (factory-only, last initializer, one-shot)
1. Initialize the pool at the opening price.
2. Mint the DNA-only launch position below the opening tick via PositionManager to `0xdEaD`; assert
   `ownerOf == 0xdEaD`.
3. Buy DNA with all `msg.value` (normal fees; `msg.value > 0` required).
4. Burn all bought DNA and any token dust; ETH dust → Safe. Assert `token.balanceOf(this) == 0`, `balance == 0`.

## 6. DNAToken
OZ ERC20 + ERC20Burnable; SUPPLY to Bootstrap; no owner. `tokenURI()` is `pure` and returns an inline
`data:application/json` literal (≤ 16,384 B) with name, symbol, description, website/external_url
https://genomedna.xyz, x (`https://x.com/` + the single constant `X_HANDLE` = `contractdna`; mainnet paths need
`X_HANDLE_CONFIRMED` to equal it), image https://genomedna.xyz/token.png. Name "DNA", symbol "DNA". Programmable display
rules: name ≤ 32 chars, symbol `^[A-Z0-9]+$` ≤ 10, description ≤ 280 B, https-only URLs, never fetched remotely. The X
handle must be fixed before hook salt mining.

## 7. Modules (launch)
`AdaptiveFee` (FeePolicy: base + multiplier·volEma, both bounded; input-independent gas, no loops, no external calls),
`BaselineSplit` (the launch split 3500/3000/2500/1000: buyback / LP / treasury / games; FeeVault's own baseline stays
3500/3500/3000/0). Review rule for any module: no DELEGATECALL, no external reads, input-independent gas.

## 8. Invariants (fuzz + invariant suites)
1. `project == floor(gross·pips/1e6)`, `platform ∈ [floor(gross·PLATFORM_FEE/1e6), +1 wei]` exact-in, `+2 wei`
   exact-out, pips ≤ 5%, on every swap (a buyback: pips 0, platform only).
2. Fee independent of tx gas above the minimum.
3. Hook never calls swap / modifyLiquidity / unlock.
4. Remove-liquidity never reverts because of the hook.
5. Only the canonical pool initializes.
6. Module revert/garbage/OOG ⇒ baseline (the decaying launch fee in the first hour), swap succeeds; canary within
   ±1 point of active.
7. Split shares in bounds, sum exact.
8. No queued op before 1 h (`MIN_DELAY`, agent and Safe alike); agent never holds forbidden powers at any level 0–10
   (every queued agent op is in its level's bitmap; registers only approved bytecode); paused agent can do nothing;
   rollback always reachable by Safe. Fee slot invariant: a Fee module is Shadow / Canary / Active iff it sits in that
   route slot; displaced and ended plates are `Proposed`; endCanary never moves `lastRollbackBlock` or the agent quota.
9. Launch LP owned by 0xdEaD; LiquidityVault liquidity non-decreasing.
10. Token supply only decreases.
11. Launch fee: the baseline is 3% at initialization, `22_000 + 8_000·(3600 − t)/3600` at t < 1 h, 2.2% from 1 h on;
    its clock is set once, by the only initialization.

## 9. Launch pipeline and post-launch wiring
- The launch graph (Programmable envelope, hook salt mining) stamps DNAToken, DNAHook, PlatformRevenue and Bootstrap in
  one `launchAndStampV1` transaction; `script/Launch.s.sol` (`LaunchPlanner`) plans it, and the fork rehearsal
  (`test/fork/Rehearsal.t.sol`) runs it against the real Programmable Router with a real Safe and measures gas.
- The post-launch CREATE2 set is, in order, ModuleRegistry, BuybackBurn, LiquidityVault, ConvictionVault, GamePot,
  FeeVault, MutationBoard (`LaunchPlanner.postLaunchInits`); none holds the hook or the token in init code.
- The Safe T0 batch is `initialize(hook)` on registry, BuybackBurn, LiquidityVault, GamePot, then
  `ConvictionVault.initialize(gamePot)`, then the four registers (§3.1).
- `VRF_COORDINATOR` / `VRF_KEY_HASH` are constants in the planner (address-shaping, never env); `EXCLUDED_WALLETS` is
  env and checked on mainnet paths (non-empty, no zero, ⊇ Safe owners). `LaunchLocal` deploys `LocalVRFCoordinator`
  (permissionless `fulfill`, local only).

## 10. IdeaMarket (not stamped; CREATE2 after ModuleRegistry, no initializer)
Anyone stakes DNA to back ideas; per 24-hour round, stakes on rejected ideas are paid pro-rata to stakers of accepted
ideas. Immutable escrow: no owner, no admin withdraw, no pause, no upgrade, no sweep.
Constructor `(token, registry)`: requires `registry.code.length != 0` and
`MAX_IDEAS · MAX_PER_IDEA ≤ token.totalSupply() ≤ uint128.max` (stake sums fit `uint128`, `s·R` fits `uint256`);
caches `safe = registry.safe()`, `START = block.timestamp`.

### 10.1 Design
| Topic | Rule | Rationale |
|---|---|---|
| "Accepted" | Selected for implementation after research + red-team | Defined by the off-chain pipeline; the chain only records the outcome |
| Roles | From ModuleRegistry: `safe` cached; `agent()`, `anchorKey()`, `agentPaused()` read live per call. No own roles | One rotation/pause point |
| Queue | Own 24 h delay, one pending outcome per round, `MIN_DELAY = 24 h` | Registry ops are a closed set |
| Who submits | Anyone: opening stake ≥ `MIN_SUBMIT` (refundable stake) **plus** `SUBMIT_FEE` burned via `burnFrom` (approve stake + fee). Unpaused agent: stake 0, no fee (X-mention intake). Safe and anchorKey cannot submit | Anti-spam; X users need no wallet |
| Slots | `MAX_IDEAS = 128`/round = 112 public + 16 reserved agent slots; bitmaps `uint128`, `index` `uint8` | Agent intake can't be crowded out |
| Idea text | Event only (`title` 1–120 B, `body` ≤ 1,000 B, UTF-8 bytes), not stored | Untrusted: never HTML, untrusted store only |
| Stake side | One-sided "back this idea"; no unstake until Final | No free exit on outcome hints |
| Rounds | `round = (now − START) / 24 h`; an idea belongs to the round of its submit block (a last-second submit lands in whichever round the block is in); staking only while that round is current. Round r ideas = `[firstId, firstId + count)` | Closed set for payouts; enumerable |
| Caps | `MIN_STAKE` per call, `MAX_PER_ADDRESS` per address per round (opening stake included), `MAX_PER_IDEA` | Whale capture + TVL bound (sybils bypass per-address; disclosed) |
| No operator staking | submit-with-stake / stake revert for safe, agent(), anchorKey() | Weak vs fresh addresses (disclosed) |
| Outcomes | accepted / void per idea via two disjoint bitmaps; the rest rejected | O(1) storage settle |
| Resolver | Safe or unpaused agent `proposeOutcome` in `[roundEnd, roundEnd + 3 d)`; final after 24 h; Safe `cancelOutcome` while pending | Timelocked public outcome + guardian veto |
| Stale proposer | `finalize` re-checks a non-Safe proposer is still `agent()` and unpaused; if not, the Safe must `cancelOutcome` then re-propose (propose needs status Open), or the round expires all-void. Operating rule: cancel pending agent outcomes before queueing UnpauseAgent, or a stale proposal becomes finalizable again | Same as registry execute |
| Liveness | From `roundEnd + 3 d + 24 h`, anyone finalizes any non-Final round (Open, or Proposed with a pending/stale proposal) as all void | No stuck funds |
| Payout | `A` = accepted stake, `R` = rejected stake; accepted position `s` → `s + floor(s·R/A)`; void → `s`; rejected → 0 | |
| `A == 0` | Round treated as all void: every position (rejected included) refunds `s`. No burn path for stakes | Stakes are never destroyed when nobody wins |
| Empty rounds | `count == 0` never proposes or finalizes; nothing to pay | |
| Dust | ≤ 1 wei per accepted position stays locked | No sweep fn |
| Unclaimed | Never expires; `claim(ids)` skips zero positions silently, reverts if a held position's round isn't Final | No admin path |
| Token | Direct `transferFrom` / `transfer` / `burnFrom` (OZ ERC20Burnable: reverts, no fee-on-transfer, no hooks) | |
| Reentrancy | No guard; CEI; only external calls are DNA + registry views | DNA has no callbacks |
| Late-stake race | Operational rule, no contract change: the engine researches a round only after it closes; during a round the UI shows only `open` (no research or red-team hints). `MAX_PER_IDEA` bounds the rest | Nobody can stake on leaked outcome hints |
| XP | Off-chain from events | |

### 10.2 Constants
ROUND_LENGTH 24 h · RESOLVE_WINDOW 3 d after round end · MIN_DELAY 24 h · MIN_SUBMIT 10,000 DNA · SUBMIT_FEE 1,000
(burned) · MIN_STAKE 1,000 · MAX_PER_ADDRESS 1,000,000/round (0.1%) · MAX_PER_IDEA 2,000,000 (0.2%) ⇒ ≤ 256M at
risk/round · MAX_IDEAS 128 = 112 public + MAX_AGENT_IDEAS 16. Lock-up ≤ 24 h + 3 d + 24 h = 5 d.

### 10.3 Storage
`nextId` (from 1) · `ideas[id] = {uint32 round; uint8 index; uint128 staked}` · `stakeOf[id][addr]` ·
`roundStakeOf[round][addr]` · `rounds[r] = {Status status (Open/Proposed/Final); uint8 count; uint8 agentCount;
uint32 firstId; uint40 proposedAt; address proposer}` + `{uint128 accepted; uint128 voided}` +
`{uint128 acceptedStake; uint128 rejectedStake}` (set at finalize).

### 10.4 Functions
- `submit(title, body, amount) → id`: byte caps; agent: `amount == 0`, unpaused, `agentCount < 16`; else not
  safe/anchorKey, `amount ≥ MIN_SUBMIT`, public slots < 112, caps; `firstId` set on first submit; `index = count++`;
  stake + `burnFrom(sender, SUBMIT_FEE)`.
- `stake(id, amount)`: known id; idea round == current; `amount ≥ MIN_STAKE`; not operator; caps; effects then
  `transferFrom`.
- `proposeOutcome(round, accepted, voided, reportHash, uri)`: Safe or unpaused agent; window; status Open; count > 0;
  disjoint; `accepted | voided < uint256(1) << count` (computed in uint256 so count == 128 works).
- `cancelOutcome(round)`: Safe; Proposed → Open.
- `finalize(round)`: anyone; not Final; count > 0; (a) Proposed, ≥ 24 h, proposer valid → apply; (b) else if
  ≥ `roundEnd + 3 d + 24 h` → accepted = 0, voided = all; else revert. Loop ≤ 128 ideas for A, R → Final.
- `claim(ids) → total`: per id read + zero `stakeOf`, sum payouts, one `transfer` to msg.sender.
- Views: `currentRound`, `roundEnd`, `ideas`, `rounds`, `stakeOf`, `roundStakeOf`, `claimable(id, staker)`.

### 10.5 Events
IdeaSubmitted(id idx, round idx, author idx, index, stake, title, body) · Staked(id idx, staker idx, amount,
ideaTotal), also emitted for the opening stake (single accounting path for indexers) · OutcomeProposed(round idx,
by idx, accepted, voided, reportHash, uri, eta) · OutcomeCancelled(round idx) · RoundFinalized(round idx, accepted,
voided, acceptedStake, rejectedStake, expired) · Claimed(id idx, staker idx, stake, payout).
Chain can't provide: researching/simulating/red-team status (engine), resolution text (from uri, checked vs
reportHash), X handle (in body).

### 10.6 UI requirements
Add `void` idea status (voided bit, or the round expired); show rejected stakes as refunded when `acceptedStake == 0`.
Count title/body in UTF-8 bytes. Approve stake + 1,000 DNA fee, then submit (fee is burned, non-refundable). Copy must
disclose: the oracle is the team's agent, the Safe can veto, funds lock up to ~5 days, and payouts are never called
"yield". No geofence.

### 10.7 Invariants
1 balance ≥ Σ obligations (payout if Final, else stake) · 2 Final round Σ payouts ∈ [A+R−n, A+R] (n = accepted
positions); void and `A == 0` positions = stake; rejected 0 · 3 DNA leaves only via claim (to msg.sender); supply falls
only by submit-fee burns · 4 a position pays once; stakes change only in their current round; caps and slot limits
hold · 5 finalize ≥ 24 h after proposal unless expired-void; Safe can always cancel pending; operators never hold
stake · 6 every round with ideas finalizable by roundEnd + 3 d + 24 h · 7 DNA totalSupply never increases.

## 11. BountyBoard (not stamped; CREATE2 after ModuleRegistry)
Safe escrows ETH per bounty; the agent proposes and recommends; the Safe funds, awards and cancels. From autonomy level
7 the agent also spends a Safe-funded **allowance**. Constructor `(registry)`: requires code; `safe` cached; agent,
`agentPaused` and `level` read live. `ReentrancyGuardTransient` on every ETH-moving fn, `Address.sendValue`, CEI.

| Topic | Rule |
|---|---|
| Currency | ETH only (treasury share is ETH to the Safe; Safe holds no DNA) |
| Funding | Safe `propose` with `msg.value == reward > 0` → Open, or `fund` an agent proposal (`msg.value == reward`, before deadline) |
| Agent power | Unpaused agent: `propose` (`msg.value == 0` → Proposed), `recommend` (event only, Open only). Anyone else proposing reverts. Below level 7 it never moves ETH |
| Allowance (L7) | Safe `fundAllowance()` payable (> 0) and `withdrawAllowance(amount)` any time (≤ allowance). Unpaused agent at `registry.level() ≥ 7`: `fund(id)` its Proposed bounty from the allowance (`msg.value == 0`, `reward ≤ allowance`, before deadline) → Open, `fromAllowance = true`; `award` only `fromAllowance` bounties. The agent never withdraws, never touches Safe-escrowed bounties. Cancel/expire of an Open allowance bounty returns its reward to the allowance (no ETH moves). Claw-back: batch `cancel(ids)` + `withdrawAllowance(all)` in one Safe tx, or `lowerLevel(6)` / `pauseAgent()` first so the agent can't fund or award in between |
| Award | Safe (any Open bounty) or the L7 agent (allowance-funded only), one winner (≠ 0), Open only (also after deadline until expired), no queue (Safe is 2-of-3) |
| Submissions | `submit(id, uri 1–512 B)` event only, Open and before deadline; untrusted |
| Payment | Push `sendValue`; reverting winner reverts the award, bounty stays Open, Safe picks another |
| Expiry | Anyone `expire`: Proposed at/after deadline → Expired; Open at/after `deadline + 7 d` (`AWARD_GRACE`) → Expired, escrow to Safe (or back to the allowance) |
| Forced ETH | No receive(); forced ETH is ignored; invariants use ≥ |
| Text | `title` 1–120 B, `request` ≤ 2,000 B, ≤ 16 requirements; events only, untrusted |

States: None → Proposed → Open → Awarded | Cancelled | Expired; Proposed → Cancelled | Expired.
`Bounty {uint96 reward; uint64 deadline; Status status; bool fromAllowance; address winner}`; `uint256 allowance`.

Functions: `propose(reward, deadline, title, request, requirements) payable → id` · `fund(id) payable` Safe (ETH) or
L7 agent (allowance) · `fundAllowance() payable` Safe · `withdrawAllowance(amount)` Safe · `submit(id, uri)` ·
`recommend(id, winner, bytes32 ref)` agent · `award(id, winner, bytes32 ref)` Safe, or L7 agent for allowance
bounties → Awarded then sendValue · `cancel(id)` Safe (refund if Open) · `expire(id)` anyone.

Events: BountyProposed(id, by, reward, deadline, title, request, requirements, funded) · BountyFunded(id, reward,
fromAllowance) · WorkSubmitted(id, by, uri) · AwardRecommended(id, winner, ref) · BountyAwarded(id, winner, reward,
ref) · BountyClosed(id, expired, refunded) (refunded = to the Safe, or to the allowance for `fromAllowance`) ·
AllowanceFunded(amount, allowance) · AllowanceWithdrawn(amount, allowance).

Invariants: balance ≥ Σ Open rewards + allowance (== without forced ETH); ETH leaves only to the Safe (cancel/expire
of Safe-escrowed Open, allowance withdrawals) or the winner, exactly `reward`, once; terminal states absorbing; Proposed
holds no ETH; the agent never sends or receives ETH, below level 7 never changes balances or the allowance, and never
awards a Safe-escrowed bounty; paused agent does nothing.

UI: `proposed` status; `review` derived (Open & now ≥ deadline); `closed` = Cancelled | Expired; the treasury view
shows Safe balance + BountyBoard escrow.

## 12. ConvictionVault (not stamped; CREATE2 post-launch)
Holds locked DNA; MutationBoard votes (`weightAt`) and the off-chain holder-jackpot ticket builder (§13) read its
weights. No owner, pause, proxy or admin withdraw. Constructor `(registry, initializer = Safe, excluded[])` (no token:
DNA is a launch-graph output, this vault must be addressable before the graph): `safe` cached, agent / anchorKey read
live; `excluded[]` = the Safe signers' EOAs + team wallets (launch-config input; zero entries revert; the mainnet launch
path refuses an empty list). `initialize(gamePot)` once, by `initializer`, only to an initialized pot whose `vault()` is
this vault; it binds DNA = `pot.token()` and nothing else (locks revert until then; `TokenBound`).
- `lock(amount ≥ MIN_LOCK 10,000 DNA, ≤ uint96, tier)`: tier 12 h / 3 d / 7 d = minimum term; operators and
  `excluded` revert. Positions are creation-ordered ids, immutable `tier`/`start`, non-transferable, no expiry, no
  extend.
- Weights (hundredths): `currentWeight(id, T) = amount × min(tierMult × streakMult, MAX_MULT 40,000) / 10,000`;
  tierMult 200 / 250 / 300 (×2 / ×2.5 / ×3) while the term in force at T runs (`T < termStart + term`), else 200 (×2,
  still locked); streakMult by `T − start`: ≥ 2 d 125, ≥ 5 d 150, ≥ 10 d 200; combined ceiling ×4 (a 7 d term at a
  10 d streak is ×4, not ×6). Staked DNA always weighs ×2–×4; held DNA counts ×1 in the ticket builder.
  `weightAt(id, T)` = that if not withdrawn and `start + MIN_AGE (12 h) ≤ T`, else 0 (votes). For T < start: the
  weight at lock.
- `withdraw(ids)` (owner, plain CEI): only after the term in force; `Withdrawn(id, owner, amount)`.
- `recommit(ids, tier)` (owner; holding always beats churning): only once the current term has ended; starts a new
  committed term (`termStart = now`, chosen tier) **without touching `start`**, so the streak keeps growing and MIN_AGE
  is unchanged; the tier multiplier applies for the new term and drops to ×2 when it ends; withdraw is blocked again
  until then. Every recommit is kept (`_recommits[id]`, packed `termStart << 8 | tier`) and `termAt(id, T)` returns the
  term in force at T, so `currentWeight` / `weightAt` at a past T never change (a recommit after a ballot's start leaves
  that ballot's vote weight as it was).
- No on-chain draw state: the jackpot reads weights off-chain.
- Invariants: DNA held = `totalLocked` = Σ amount not withdrawn; every live position weighs within [×2, ×4] of its
  amount; recommit ≥ withdraw-and-relock at any later T.

## 13. GamePot (ships at launch: not stamped, CREATE2 right after it, its address is in FeeVault's init code and `initialize(hook)` is in the Safe T0 batch)
No owner, pause or proxy; value leaves only to winners, idea-reward recipients, BuybackBurn or the VRF subscription.
PoolBound-style: `(poolManager, initializer = Safe, vault, registry, coordinator, keyHash)`; `initialize(hook)` (Safe
T0 batch) reads FeeVault / BuybackBurn from the hook and LiquidityVault from FeeVault, requires
`FeeVault.gamePot() == this`, creates the VRF v2.5 subscription it owns, adds itself as consumer and opens window 1
`[now, now + drawInterval)`. Coordinator and keyHash are immutable (no migration code: a retired coordinator ends the
jackpot via `rescueToBuyback` and a split rollback).
- Accounting: assets = ETH claims + native ETH (`receive` takes coordinator refunds; `sync` settles ETH into claims).
  `sync()` (anyone) splits arrivals above `jackpotPot + ideaReserve + draw.prize (escrow) + owedTotal + queuedRewards`
  70/30 jackpot/idea reserve; jackpot above `POT_CAP` 15 ETH and idea reserve above `RESERVE_CAP` 15 ETH → BuybackBurn
  claims (also a reserve a cancelled reward lifted over the cap, at the next sync).
- Holder jackpot: every DNA holder by time-weighted average balance over a window (staked DNA at its §12 weight,
  water-filled per-wallet cap, minimum balance), built off-chain in the enclave; the chain sees only the Merkle root.
  Exactly one unresolved draw at a time (`draw`): posted → requested (escrowed) → fulfilled → settled or voided.
- Windows: `rollWindow()` (anyone, once `now ≥ windowEnd`): next window `[prev end, prev end + drawInterval)`, so a
  late roll never moves it; after an outage each call opens one window and the closed ones in between are skipped (the
  pot carries over). `latestClosedWindow()` = the open window once it ended, else the previous one.
- `postList(w, {capBps, minBalance}, root, totalTickets, holders, lastLeaf, lastProof, uri, dataHash)`: agent (L ≥ 5,
  unpaused) or Safe, anchor-before-send. `w` = the latest closed window, `now ≤ end_w + LIST_GRACE 24 h`,
  `w > lastDrawnWindow`, nothing requested or fulfilled; a list for the same window needs `cancelList` first; a newer
  window's list replaces a never-requested one. Bounds: `capBps ∈ [50, 200]`, `minBalance ∈ [100, 1,000,000] DNA`
  (both edges in). Binding: `root ≠ 0`, `totalTickets > 0`, `holders > 0`, `lastLeaf.index == holders − 1`,
  `lastLeaf.tickets > 0`, `lastLeaf.cumStart + lastLeaf.tickets == totalTickets`, `lastProof` verifies. Leaf =
  `keccak256(bytes.concat(keccak256(abi.encode(index, account, cumStart, tickets))))` (OZ double hash, `leafHash`),
  sorted-pair tree, odd node promoted (engine/src/tickets.ts; golden vector in GamePot.t.sol). `eta = now + LIST_DELAY
  1 h`; `ListPosted`. The chain does NOT bind `holders` to the root's leaf count (OZ `verify` is position-free): a
  longer list posted as a shorter one passes here. The defence is the watchdog's full rebuild (holders, Σ, root,
  dataHash) and the Safe's 1 h `cancelList`.
- `cancelList(w)`: Safe only, the posted window's list, until `requestDraw` (again after an abort).
- `requestDraw()` (anyone, from the list's eta, nothing requested or fulfilled): top the subscription up to
  `SUB_MIN = 200 gwei × (200k verify + 300k CALLBACK_GAS + 50k billing) × 1.24` (0.1364 ETH) from the pot;
  `prize = min(pot − top-up, PRIZE_CAP 3 ETH) ≥ MIN_PRIZE 0.25 ETH` (0.025 ETH per winner; else wait: the engine posts
  no list while `pot < MIN_PRIZE + top-up`); gas gate `basefee × 550k × 1.24 ≤ 20% × prize`; escrow the prize; one
  word, 3 confirmations, native payment, 200 gwei keyHash `0x8077…d3d9`. After an abort it re-requests the same list.
- `rawFulfillRandomWords` (coordinator only; unknown / stale / repeated requestId ignored, never reverts): stores `rand`
  and `fulfilledAt`; nothing else (`DrawFulfilled(reqId, w, rand)`). Measured ≈ 65k gas (CALLBACK_GAS 300k).
- **10 winners per draw, equal split**: one VRF word, expanded:
  `ticketAt(rand, j, total) = keccak256(abi.encode(rand, j)) mod total` (public pure; engine/src/tickets.ts and
  web/app/play/draw/tickets.ts use the same, golden vector in all three test suites).
- `settle(leaves[], proofs[])` (anyone, the keeper): fulfilled draw, `leaves.length == proofs.length ≥ 1`. The walk,
  j = 0, 1, … while `j < MAX_TICKETS 32` and fewer than `WINNERS 10` accounts: `leaves[k]` must hold ticket
  `ticketAt(rand, j, totalTickets)` (`cumStart ≤ t < cumStart + tickets`, else `NotWinningLeaf`) and its proof must
  verify (`BadProof`); an account already picked this draw is skipped; an excluded one (`isExcluded`: Safe,
  `registry.agent()`, `registry.anchorKey()`, `vault.excluded`, PoolManager, hook, FeeVault, BuybackBurn,
  LiquidityVault, the vault, this pot, 0x0, 0x…dEaD) is skipped with `WinnerExcluded(w, account, 0)`; otherwise it is
  winner n. The input must be exactly the walk's tickets (`k == leaves.length`, else `BadList`), so each draw has one
  valid input. Distinctness is by account. Fewer than 10 accounts in reach: fewer winners. Then CEI: close the draw,
  `lastDrawnWindow = w`, `share = prize / 10`, `jackpotPot += prize − share × n` (dust, unfilled ranks),
  `Drawn(w, rand, prize, share, n, ticketsUsed)` before any push; one TAKE of `share × n`; per rank, **before each
  push** `gasleft ≥ PUSH_GAS × 64/63 + 40k` (else the whole settle reverts `LowGas`: a settler can't starve any push
  into the claim path), assembly `call` with PUSH_GAS 50k and no returndata copy; a failed push records
  `prizes[++drawCount] = {winner, uint64 amount, uint32 wonAt}` (one slot; amount 0 = claimed or expired);
  `Winner(w, rank, account, share, prizeId)` (prizeId 0 = pushed). Failed shares: `owedTotal += failed` and one SETTLE
  back to claims.
  - Disclosure: the list is fixed before randomness, so a withholding VRF operator knows the winners before fulfilling;
    bounded by PRIZE_CAP.
  - Gas: settle worst case (10 cold receivers that burn PUSH_GAS and fail, 10 claim records) 1,280,726 gas on a
    17-level tree, 1,307,585 with 10 equal holders (30 tickets walked) and **1,629,213 with both (17-level proofs × all
    32 tickets)**, pinned ≤ 1.65M; the keeper sends settle with a 1.8M gas floor (measured + ~10%, engine games.ts
    SETTLE_GAS_MIN) so a receiver that burns more at inclusion than at estimation can't turn every retry into
    LowGas; postList ≈ 137k.
- `voidDraw()` (anyone): `DRAW_SETTLE_WINDOW` 7 d after a fulfilment nobody settled → escrow back,
  `lastDrawnWindow = w`.
- `abortDraw()` after `VRF_TIMEOUT` 36 h: escrow back, the list stays (re-requested by the next `requestDraw`; a
  disclosed deviation from "never re-request", VRF-operator-only, bounded by PRIZE_CAP). A late fulfilment of an
  aborted request is ignored but still charges the subscription (one fulfilment, from the float). `rescueToBuyback()`
  only while a request is stuck now (requested, unfulfilled, ≥ 36 h, and ≥ `STALL` 14 d since the first unfulfilled
  request): aborts it inline, then jackpot (escrow included) + idea reserve → BuybackBurn; owed prizes stay and
  queued rewards stay payable; never on a fulfilled draw; a healthy pot is never rescuable. `recreateSubscription()` once `getSubscription` reverts and nothing
  is requested.
- `claim(prizeIds, to)` (that winner, ETH to any `to`) for owed shares and rewards; `expireClaim` (anyone) after
  `CLAIM_WINDOW` 7 d returns the share or reward to the jackpot.
- `drawInterval` (default 24 h) set by the agent (L ≥ 5, unpaused) or the Safe within immutable [12 h, 3 d]:
  `proposeDrawInterval` → anyone `executeDrawInterval` after 1 h (agent proposer re-judged), only while the open window
  runs (`RollFirst`), so it applies from the next window → Safe `cancelDrawInterval` until then.
- Idea rewards (30% of arrivals; the brain decides each amount off-chain, from a signed `reward` record):
  - `queueReward(to, amount, ideaRef)`: agent (L ≥ 5, unpaused) or Safe; `sync` first; `to` not `isExcluded` (same set
    as the jackpot); `MIN_REWARD` 0.01 ETH ≤ amount ≤ `MAX_REWARD_BPS` 25% of `ideaReserve`; rolling day budget: the
    first queue at least 24 h after the previous day's start opens a day (`budgetStart`) with
    `dayBudget = 25% × ideaReserve` then, and Σ queued that day (`daySpent`, a cancel does not give it back) ≤
    `dayBudget`. The amount moves `ideaReserve → queuedRewards` (escrow); `eta = now + 1 h`;
    `RewardQueued(id, to, amount, ideaRef, eta)`. `ideaRef` = the signed reward record's hash (the watchdog checks it).
    One record backs one reward: `rewardOfRef[ideaRef]` holds the id; a second queue on a used ref reverts `RefUsed`
    (also after the first was paid or its claim expired).
  - `cancelReward(id)`: Safe only, until paid: escrow back to `ideaReserve`, its `ideaRef` free again; `RewardCancelled(id)`.
  - `payReward(id)` (anyone, from eta): reverts while `registry.agentPaused()`, when an agent proposal's proposer is no
    longer the agent at L ≥ 5, or when `to` became excluded (the Safe cancels it). CEI: delete, one TAKE, the same
    push as `settle` (PUSH_GAS, `LowGas` guard); a failed push records `prizes[++drawCount]` (claimable like a prize,
    expires to the jackpot) and SETTLEs back; `RewardPaid(id, to, amount, claimId)` (claimId 0 = pushed).
- Every external entry that moves value (`sync`, `postList`, `requestDraw`, `settle`, `voidDraw`, `abortDraw`,
  `claim`, `expireClaim`, `rescueToBuyback`, `recreateSubscription`, `queueReward`, `payReward`) is `nonReentrant`:
  a receiver re-entering during the push is locked out and sees the draw (or reward) closed and the payout owed.
- Invariants: claims + ETH ≥ jackpot + idea reserve + escrow + owed + queued rewards (exact after a failed push: no
  70/30 double count); inflow = held + winners and reward recipients + BuybackBurn + subscription funding − refunds;
  `queuedRewards` = Σ open reward escrows; `daySpent ≤ dayBudget`; no reward queued over its caps, to an excluded
  address, or paid while the agent is paused; `owedTotal` = Σ prizes not
  pushed, claimed or expired; an escrow exists only with a request; a share is paid at most once (push or claim or
  expiry); the Safe and the agent never receive value; every rank's ticket settles exactly one leaf; no account is
  paid twice per draw; Σ shares paid or owed + returned to the pot = prize.

## 14. MutationBoard (holds nothing; CREATE2 post-launch, nothing references it)
Constructor `(vault, registry)`; `safe` cached, agent / paused / level read live. No owner, pause or proxy. Votes and
mysteries pick what is **tested** next, never what is kept.
- Ballot: `propose(options[3])` agent (L ≥ 5, unpaused) or Safe, at most one per 48 h (`BALLOT_EVERY`); voting opens
  1 h later (Safe `cancelBallot` until resolved; a veto inside that hour frees the slot) and lasts 24 h (`VOTING`).
  `vote(ballot, option, positionIds)`: owner of each position; weight = `vault.weightAt(id, ballotStart)` (streak
  included, 0 if younger than MIN_AGE at the start or withdrawn; a later recommit never changes it); re-voting moves
  the stored prior weight. `winner` = highest tally, ties and all-zero → lowest index. The agent records
  `ballotRun(ballot, option = winner, registryOpId)` (checked on chain: the op is still queued and its proposer is the
  current agent, so record it before the op executes) or `ballotSkipped(ballot, reasonHash)`.
- Mystery: `seal(keccak256(salt32 ‖ payload), revealAt ∈ [now + 2 d, now + 7 d])` agent or Safe, one sealed at a time,
  non-zero commitment (`BadSeal` otherwise, also for a reveal time outside the window); `reveal(id, salt,
  payload ≤ 2,048 B)` by anyone within 24 h of `revealAt`; `markBroken` after that; Safe `cancelSeal` (event
  `CancelledByGuardian`); the agent records `mysteryRun(id, registryOpId)` (same queue check) or
  `mysteryRejected(id, reasonHash)`.
