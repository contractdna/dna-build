# Module library

Fee and split modules are small contracts the hook and FeeVault ask for numbers. They hold no funds, keep no state,
and can't call anything. The hook asks a fee module with a gas-capped STATICCALL (40,000 gas) and clamps the answer to
the 5% constitution cap; FeeVault asks the split module the same way (40,000 gas) and uses the answer only if it passes
its own bounds. If a module reverts, runs out of gas or answers garbage, the hook charges the baseline fee and FeeVault
uses its baseline split.

Each module is deployed once per "plate" (a CREATE2 address) and registered in `ModuleRegistry` by the Safe, with
lower and upper bounds for each of its four params. Params can only be changed inside those bounds.

## The modules

| Module | Kind | What it does |
|---|---|---|
| AdaptiveFee | fee | Base fee plus a volatility term, capped. The launch module. |
| DirectionalFee | fee | Like AdaptiveFee, but buys and sells have separate base fees. |
| SizeTierFee | fee | Fee steps up with the trade's size in ETH (three tiers). |
| BaselineSplit | split | Fixed 35% buyback / 30% LP / 25% treasury / 10% games. |
| ParamSplit | split | The split is whatever its params say, inside FeeVault's bounds. |

### DirectionalFee

`fee = min(base + multiplier × volatility / 10,000, cap)`, where `base` is the buy base for buys (ETH → DNA) and the
sell base for sells. Volatility is the hook's running average of how far the price moves per swap.

Params: `[buy base, multiplier ×1e4, cap, sell base]`, fees in pips (10,000 pips = 1%). The first three mean the same as
in AdaptiveFee; with equal buy and sell bases it charges exactly what AdaptiveFee charges.

### SizeTierFee

`fee = min(base + step × tiers crossed, cap)`, with tiers at T, 4T and 16T of ETH. Example with the start params
(2%, +0.5%, cap 3.5%, T = 1 ETH): under 1 ETH pays 2%, 1–4 ETH 2.5%, 4–16 ETH 3%, 16 ETH and up 3.5%.

Params: `[base, step, cap, T in wei of ETH]`.

Size is always measured in ETH. When the trader fixes the ETH amount (exact-in buy, exact-out sell) that amount is the
size. When the trader fixes the DNA amount (exact-out buy, exact-in sell) the size is that DNA's value at the pool price
before the swap. That value ignores price impact, so a large exact-out buy pays a little more ETH than its measured
size and a large exact-in sell receives a little less. A trader can avoid the tiers by splitting a trade into smaller
swaps; each swap still pays the base fee.

### ParamSplit

Params: `[buyback, LP, treasury, games]` in basis points. If every share is inside FeeVault's bounds (buyback 20–50%,
LP 20–50%, treasury 10–40%, games 0–20%) and they add up to exactly 100%, those are the shares. Otherwise it returns
BaselineSplit's 35/30/25/10, so a bad set of params never turns the games off.

Two different fallbacks exist, on purpose:

- **ParamSplit / BaselineSplit**: 35% buyback / 30% LP / 25% treasury / 10% games. This is what runs while a split
  module is active, including when ParamSplit's params don't add up.
- **FeeVault's own baseline**: 35% buyback / 35% LP / 30% treasury / 0% games. FeeVault uses it when no split module
  is active (never registered, or rolled back) or the module fails. Rolling a split module back turns the games off.

## Plate bounds

All fee plates keep the same envelope as the AdaptiveFee plates: any params inside the bounds give a fee between 1% and
3.5%.

| Plate | Param | Start | Lower | Upper |
|---|---|---|---|---|
| directional-fee-v1 | buy base | 2.0% | 1.0% | 3.5% |
| | multiplier | 1.0× | 0.1× | 1.8× |
| | cap | 3.5% | 1.0% | 3.5% |
| | sell base | 2.0% | 1.0% | 3.5% |
| size-tier-fee-v1 | base | 2.0% | 1.0% | 3.5% |
| | step per tier | 0.5% | 0 | 0.5% |
| | cap | 3.5% | 1.0% | 3.5% |
| | T | 1 ETH | 0.1 ETH | 10 ETH |
| param-split-v1 | buyback | 35% | 20% | 50% |
| | LP | 30% | 20% | 50% |
| | treasury | 25% | 10% | 40% |
| | games | 10% | 0% | 20% |

DirectionalFee starts identical to AdaptiveFee plate B (2%, 1.0×), so promoting it changes nothing until its params
are tuned. On a thin pool the volatility term is large, so with a 1.0× multiplier the fee sits at its cap; a low
multiplier keeps the buy/sell difference visible.

The registry checks each param on its own. It does not check that ParamSplit's four shares add up to 100%; the module
does, and falls back to 35/30/25/10 when they don't.

## Gas

Measured in `test/ModuleLibrary.t.sol` (worst case over the inputs tried, module's own execution):

| Module | Module gas | Whole cold call | Cap |
|---|---|---|---|
| ParamSplit | 978 | 3,722 | 40,000 |
| DirectionalFee | 793 (same for every input) | 3,472 | 40,000 |
| SizeTierFee | 2,172 | 4,860 | 40,000 |

"Whole cold call" includes the first-touch account access the hook or FeeVault pays. None of the modules loops;
DirectionalFee has no branches at all. The tests fail if any module uses more than a tenth of its cap.

## Who can change what

Every change goes through the registry's one-hour queue, and the Safe can cancel anything in it.

- **Register a plate**: the Safe. (At autonomy level 10 the agent may register bytecode the Safe pre-approved.)
- **Put a fee plate in shadow**: the agent from level 4, or the Safe.
- **Canary, and params of a fee plate that isn't active**: the agent from level 5, or the Safe.
- **Params of the active fee plate**: the agent from level 6, or the Safe.
- **Promote a fee plate to active**: the Safe until level 8; the agent from level 8.
- **Anything on a split plate (including ParamSplit's params)**: the Safe, or the agent from level 9.
- **Rollback**: the Safe at any time; the agent from level 5 (rate-limited); anyone, for the fee route, when the
  hook's failure breaker trips.

At launch the engine only tunes AdaptiveFee. These plates are registered by the Safe and moved by the Safe until the
engine learns them.

## Registering the plates

`REGISTRY=0x… forge script script/RegisterModules.s.sol` prints the plate addresses and the calldata for three CREATE2
deploys (through the standard `0x4e59…956C` factory; anyone can send them) and three `queue(Register, …)` calls for the
Safe. It never broadcasts. One hour after the queue, anyone can call `registry.execute(id)`.

Each Register carries the plate's spec hash: keccak256 of its engine manifest's bytes
(`engine/modules/<plate>.json`), the same key the indexer uses to show the manifest on the site. The registry stores it
once, at Register, so a manifest edit after registration orphans the module's page: freeze the files before mainnet.
