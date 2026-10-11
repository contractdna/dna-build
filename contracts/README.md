# DNA contracts

Solidity contracts for DNA, a fixed-supply ERC-20 traded in one Uniswap v4 pool on Ethereum. The pool's hook is
immutable and enforces a fee constitution (a 5% cap on the project fee, a fixed platform fee, a ±1 point canary bound),
while an AI agent proposes the fee and split policies that run inside those bounds. Every agent change goes through a
1-hour queue that a 2-of-3 Safe can veto, and the agent's powers grow only as the Safe raises its autonomy level. The
project fee is split between buyback-and-burn, permanent liquidity, the treasury and the games pot (70% a VRF holder
jackpot, 30% rewards for the people whose ideas the AI builds); holders can lock DNA for vote weight and stake on
ideas.

The full design, constants and invariants are in [SPEC.md](SPEC.md).

## Contracts

| Contract | What it does |
|---|---|
| `DNAToken` | Fixed 1B supply ERC-20 (burnable); no owner, mint, pause or tax; `tokenURI()` is a pure literal. |
| `DNAHook` | The pool's immutable v4 hook: takes fees in ETH, asks registered fee modules (gas-capped staticcall) what to charge inside the constitution. |
| `Bootstrap` | One-shot launch initializer: opens the pool, locks the whole supply in a position owned by 0xdEaD, buys with part of the launch ETH and locks the rest with the bought DNA as a full-range position, also owned by 0xdEaD (the excess DNA is burned). |
| `PlatformRevenue` | Holds the platform-fee claims and pays them as ETH to one immutable recipient. |
| `ModuleRegistry` | Queue, roles, autonomy ladder and anchors: every fee/split module change passes its 1 h queue and pushes the route to the hook. |
| `FeeVault` | Splits the project fee four ways (buyback, LP, treasury, games) by the registry's split module, or a fixed baseline. |
| `BuybackBurn` | Spends its claims buying DNA on the pool (≤ 1 ETH per hour, ≤ 0.5% price move) and burns it. |
| `LiquidityVault` | Turns its claims into permanent ETH-only liquidity just above the current price; no withdraw path. |
| `GamePot` | Runs the holder jackpot (Merkle ticket list + Chainlink VRF v2.5, 10 winners) and pays idea rewards (queued 1 h, Safe can cancel, capped per reward and per day) from the game share. |
| `ConvictionVault` | Locks DNA in positions whose weight (×2–×4) feeds MutationBoard votes and the jackpot tickets. |
| `MutationBoard` | Holder ballots and sealed mysteries that pick what the agent tests next; holds nothing. |
| `IdeaMarket` | Stake DNA on ideas per 24 h round; stakes on rejected ideas pay the stakers of accepted ones. |
| `BountyBoard` | Safe-escrowed ETH bounties; the agent proposes and, from level 7, spends a Safe-funded allowance. |
| `PoolBound` | Shared base for vaults bound once to the hook at a precomputed address. |
| `modules/AdaptiveFee` | Launch fee policy: `min(base + multiplier·volatility, cap)`, input-independent gas. |
| `modules/BaselineSplit` | Launch split policy: 35% buyback / 30% LP / 25% treasury / 10% games. |
| `libraries/FeeMath` | Fee math on the gross ETH leg (exact-in and exact-out). |

## Layout

```
src/                  core contracts
src/modules/          fee and split policy modules the registry routes to
src/interfaces/       shared types and interfaces (route structs, policy interfaces, Chainlink VRF v2.5 subset)
src/libraries/        FeeMath
test/                 unit and fuzz tests, one suite per contract
test/fork/            mainnet-fork tests (Universal Router swaps, live VRF coordinator, full launch rehearsal)
test/invariant/       system invariant suite over the real launch pipeline
script/               Launch.s.sol (launch planner, local and mainnet launch) and DevActions.s.sol (local only)
script/programmable/  vendored Programmable sources (MIT), kept byte-identical
audit/                static analysis triage
```

## Build and test

Dependencies are pinned git submodules (forge-std, OpenZeppelin contracts, OpenZeppelin uniswap-hooks, Uniswap v4-core
and v4-periphery; exact revisions in `foundry.lock`). From the repository root:

```shell
git submodule update --init --recursive
cd contracts
forge build
forge test
```

The fork tests in `test/fork/` skip unless `MAINNET_RPC_URL` is set:

```shell
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --mc Rehearsal -vv
```

The invariant suite runs at CI depth by default (`foundry.toml`). For a deeper run:

```shell
FOUNDRY_INVARIANT_RUNS=1000 FOUNDRY_INVARIANT_DEPTH=256 forge test --mc SystemInvariantTest
```

`foundry.toml` settings (solc 0.8.26, cancun, optimizer 800 runs, `bytecode_hash = "none"`) are part of the launch
addresses: changing any of them changes every deployed address (the `[lint]` section is not a compiler setting).

## Lint

`forge lint` runs on `src/` only (tests and scripts are not deployed); CI runs `forge lint --deny notes`, so any finding
fails the build, and a new exclusion needs a row here. These lints are excluded in `foundry.toml`
after review; the Slither triage covers the same patterns line by line:

| Lint | Why it is accepted |
|---|---|
| `unsafe-typecast` | Every narrowing cast is bounded first: timestamps and block numbers, amounts capped by the supply or a constant, inputs range-checked |
| `block-timestamp` | Delays, windows and cooldowns are hours to days; a validator's few seconds of skew changes nothing |
| `reentrancy-events`, `reentrancy-no-eth` | The calls go only to fixed contracts (PoolManager, the DNA token, the VRF coordinator, the bound vaults), and the entry points that make them are `nonReentrant` where state follows the call |
| `unused-return` | `PoolManager.unlock` / `settle` / `take` results are not needed: balances come from the callback deltas |
| `require-revert-in-loop` | One bad entry must revert the whole batch |
| `missing-zero-check` | Constructor addresses are precomputed by the launch scripts and checked by the launch tests |
| `uninitialized-local` | Zero-initialised locals are intended |
| `calls-loop` | Loops are bounded (10 winners, a voter's own positions) and a failing call must revert |
| `erc20-unchecked-transfer` | The only token is DNA (OpenZeppelin ERC20), which reverts on failure |
| `incorrect-strict-equality` | Comparisons are against zero or enums, not balances an attacker can nudge |
| `missing-events-access-control` | The flagged writes emit their domain event (`BallotProposed`, `Sealed`) naming the caller |
| `boolean-cst` | The constant is the "baseline used" flag in a return tuple |
| `arbitrary-send-eth` | `BountyBoard` pays the winner the Safe or the agent chose: that is its purpose |
| `weak-prng` | `count % SHADOW_EVERY` sets the shadow sampling cadence; it is not randomness |
| `divide-before-multiply` | `GamePot`: share = prize / 10, paid = share × winners; the remainder stays in the pot by design |

## Docs

- [SPEC.md](SPEC.md): design specification (contract set, constants, roles, invariants).
- [audit/slither.md](audit/slither.md): Slither results and triage.

## Security

Unaudited. Reviewed internally and with AI review. See [../SECURITY.md](../SECURITY.md).
