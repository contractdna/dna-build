# Slither triage: DNA contracts

## What was analysed
- Tool: Slither 0.11.6, solc 0.8.26 via Foundry, 2026-10-08.
- Command (from `contracts/`): `slither . --filter-paths "lib/|script/|test/"`, so the scope is `src/` only
  (`script/programmable` is vendored Programmable code; `script/` and `test/` are not deployed).
- Contracts covered: every contract in `src/`: DNAToken, DNAHook, Bootstrap, PlatformRevenue, ModuleRegistry, FeeVault,
  BuybackBurn, LiquidityVault, IdeaMarket, BountyBoard, GamePot, ConvictionVault, MutationBoard, GameFunder, the modules
  (AdaptiveFee, BaselineSplit, DirectionalFee, ParamSplit, SizeTierFee), the libraries and the interfaces.

## Result
- 98 contracts analysed (with dependencies), 102 detectors, **192 results: 4 High, 68 Medium, 94 Low, 26 Informational** (re-run after GamePot gained idea rewards).
- Verdict: **no exploitable issue**. Every result is a false positive or accepted design; the reasons are below,
  per detector, then per newly covered contract.
- `forge lint` reports the same patterns; its accepted lints are listed in [../README.md](../README.md#lint).

### The one real finding: return bomb in `FeeVault.currentSplit` (Low, fixed)
An earlier run flagged a return bomb: `FeeVault.currentSplit` copied the split module's whole return data, so a
malicious module could return a huge buffer and make `distribute()` pay for copying it.

- Fix: the split-module call is an assembly `staticcall` that copies at most 128 bytes (the 4-word split) and accepts
  the answer only when exactly 128 bytes come back, the same pattern as `DNAHook._staticcallPips`. The result is gone;
  the assembly block shows up as an Informational `assembly` result.
- Regression test: `Vaults.t.sol::test_split_returnBombCostBounded`. The largest bomb that fits the 40k module gas cap
  costs 57,401 gas with the fix; the unfixed code spends 106,879 and fails the test.

## Results by detector

| Detector | Impact | Count | Where |
|---|---|---|---|
| unchecked-transfer | High | 4 | ConvictionVault 2, IdeaMarket 2 |
| incorrect-equality | Medium | 29 | DNAHook 2, GamePot 4, IdeaMarket 2, ModuleRegistry 21 |
| unused-return | Medium | 25 | Bootstrap 1, BuybackBurn 1, DNAHook 2, FeeVault 4, GamePot 11, LiquidityVault 3, ModuleRegistry 1, MutationBoard 1, PlatformRevenue 1 |
| reentrancy-no-eth | Medium | 4 | GamePot 4 |
| uninitialized-local | Medium | 9 | DNAHook 2, GamePot 4, IdeaMarket 2, ModuleRegistry 1 |
| divide-before-multiply | Medium | 1 | GamePot 1 |
| timestamp | Low | 61 | BountyBoard 4, BuybackBurn 1, ConvictionVault 5, DNAHook 6, GameFunder 2, GamePot 15, IdeaMarket 4, LiquidityVault 1, ModuleRegistry 16, MutationBoard 7 |
| missing-zero-check | Low | 10 | DNAHook 5, FeeVault 1, GamePot 1, ModuleRegistry 3 |
| reentrancy-events | Low | 10 | Bootstrap 1, BuybackBurn 1, DNAHook 1, FeeVault 1, GamePot 2, LiquidityVault 1, ModuleRegistry 2, PlatformRevenue 1 |
| reentrancy-benign | Low | 9 | DNAHook 1, GamePot 7, ModuleRegistry 1 |
| calls-loop | Low | 3 | GamePot 1, MutationBoard 2 |
| shadowing-local | Low | 1 | IDNA 1 |
| assembly | Info | 7 | DNAHook 3, FeeVault 1, GamePot 1, AdaptiveFee 1, DirectionalFee 1 |
| unindexed-event-address | Info | 5 | ConvictionVault 1, ModuleRegistry 3, IDNA 1 |
| naming-convention | Info | 4 | ConvictionVault 3, IdeaMarket 1 |
| cyclomatic-complexity | Info | 3 | DNAHook 1, GamePot 1, ModuleRegistry 1 |
| costly-loop | Info | 2 | GamePot 1, ModuleRegistry 1 |
| low-level-calls | Info | 3 | Bootstrap 1, FeeVault 1, GameFunder 1 |
| missing-inheritance | Info | 1 | ConvictionVault 1 |
| too-many-digits | Info | 1 | DNAHook 1 |

### High
- **unchecked-transfer** (IdeaMarket `claim` / `_stake`, ConvictionVault `withdraw` / `lock`): false positive. `token` is
  the immutable DNA (OpenZeppelin 5 ERC20): it reverts on failure and never returns `false`.

### Medium
- **incorrect-equality**: false positive. No comparison is against a balance an attacker can nudge by a wei; all are
  enum dispatch (`ModuleRegistry._apply` `op == Op.X`, `levelOps` constant table), bitmap membership
  (`levelOps(level) & bit == 0`, IdeaMarket accepted/voided bits), sentinels (`q.queuedAt == 0`, `m.code.length == 0`,
  GamePot `pendingInterval.eta == 0`, `stalledSince == 0`, `rewards[id].amount == 0`: an open reward is always
  ≥ MIN_REWARD), zero skips
  (`DNAHook._accrue` `fee == 0`, first-swap EMA seed) and the shadow cadence (`count % SHADOW_EVERY == 0`: timing it
  gains nothing, a shadow never charges).
- **unused-return**: false positive. `poolManager.unlock` callbacks return `""`; v4 ERC-6909 `transfer` returns `true`
  or reverts; `settle{value}` returns the `msg.value` sent; `getSlot0` / `getSubscription` / `queued` are destructured
  for the fields needed; LiquidityVault asserts settlement right after `modifyLiquidity` (`currencyDelta == 0`).
- **reentrancy-no-eth** (GamePot `requestDraw`, `queueReward`, `rescueToBuyback`): false positive. Every one is
  `nonReentrant` (OpenZeppelin `ReentrancyGuardTransient`), and the calls go to the PoolManager, the registry and the
  Chainlink VRF coordinator, all fixed at construction.
- **uninitialized-local**: false positive. Zero is intended: `fee` when ETH is unspecified,
  "no canary" in a Split rollback event, accumulators and flags (`IdeaMarket.finalize`, `GamePot.settle` `n`, `k`,
  `dup`, `failed`).
- **divide-before-multiply** (GamePot `settle`): accepted. `share = prize / WINNERS; paid = share * n`: every winner gets
  the same share and the remainder (dust and unfilled ranks) stays in the jackpot pot by design.

### Low
- **timestamp**: accepted. Registry 1 h delay, `PARAMS_EPOCH`, agent rollback cooldown, buyback / liquidity cooldowns,
  bounty deadlines, idea rounds, jackpot windows, list delay, VRF timeouts, the reward hour and day budget, ballot
  windows, GameFunder's 7-day budget, conviction terms:
  all hours to days, where a validator's few seconds of skew changes nothing. Many flagged comparisons contain no
  timestamp at all (Slither taints a whole function once any branch reads `block.timestamp`).
- **missing-zero-check**: accepted. DNAHook's constructor addresses are precomputed CREATE2 addresses checked by
  `test/Launch.t.sol`; a zero `FeeVault.registry` means the baseline split forever by design; ModuleRegistry `agent` /
  `anchorKey` zero = role disabled (both rotatable through the Safe queue); `initializer` is the Safe;
  `GamePot.initialize(hook_)` is guarded by `PoolBound` (initializer-only, once, the hook must have code).
- **reentrancy-events / reentrancy-benign**: false positive. Calls go to fixed trusted contracts: the immutable hook
  (`setRoute` makes no external call), the PoolManager (re-entry blocked by `AlreadyUnlocked`; tested by
  `test_distribute_reentrantSafePaidOnce`, `test_platform_reentrantRecipientPaidOnce`), the VRF coordinator
  (GamePot `_newSubscription`, `initialize`, behind `nonReentrant` or the one-shot initializer); GamePot
  `queueReward` / `payReward` call only the PoolManager and the registry, behind `nonReentrant` (a reward recipient's
  re-entry during the push is tested in `test_reward_reentrantRecipient`). `Bootstrap.initialize`
  is factory-only and one-shot; its only untrusted call (`safe.call`) is last and followed by postconditions.
- **calls-loop**: accepted. `GamePot.isExcluded` reads the registry and vault for one address (called for ≤ 10
  winners); `MutationBoard.vote` loops over the caller's own positions; a failing call should revert the whole call.
- **shadowing-local** (`IDNAHook.setRoute(Route route)` shadows `route()`): a parameter name in an interface.

### Informational
- **assembly**: reviewed. `DNAHook._staticcallPips` (32-byte-capped staticcall, no return bomb), `_tload` / `_tstore`
  (transient pips slot); `FeeVault.currentSplit` (the return-bomb fix above); `AdaptiveFee` / `DirectionalFee`
  (branchless min and select for input-independent gas, fuzzed in the module tests); `GamePot._push` (used by `settle`
  and `payReward`: a gas-capped ETH push that copies no return data; a failed push becomes a claimable prize).
- **costly-loop**: `ModuleRegistry.cancel` is a Safe-only batch (the caller sizes it); `GamePot._push` writes ≤ 10 prizes
  per settle (one per reward).
- **cyclomatic-complexity**: `DNAHook._projectPips`, `ModuleRegistry._apply` (flat enum dispatch), `GamePot.settle`
  (proof checks per leaf); each is covered by unit tests and the invariant suites.
- **low-level-calls**: `FeeVault` `registry.staticcall` (a code-less registry → baseline, intended); `Bootstrap`
  `safe.call{value: dust}` and `GameFunder.sweep` (whole balance to the Safe), both checked; the Safe must accept plain
  ETH.
- **unindexed-event-address**, **naming-convention** (`IdeaMarket.START`, ConvictionVault's `T` time parameter),
  **missing-inheritance** (ConvictionVault has `initialize` without declaring `IInitializable`), **too-many-digits**
  (`DNAHook.T_SLOT`): style only. Changing them would change deployed bytecode for no security gain.

## Re-run
```
cd contracts
pipx install slither-analyzer==0.11.6
slither . --filter-paths "lib/|script/|test/"
```
