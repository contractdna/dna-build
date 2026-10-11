# Funding Sequencer games from the Safe

How the AI pays a new game without being able to touch the rest of the treasury. Status: built and rehearsed on a
mainnet fork. **Nothing is enabled on the real Safe yet.** Turning it on is a Safe transaction that changes what the
Safe allows, so it needs an explicit signer decision.

## The chain

```
agent key ──► Roles v2 ──► Delay ──► Safe ──► GameFunder.fund(game, amount) ──► game.fund{value: amount}()
            (one call,    (waits 1 h,        (pays from its own balance,
             amount cap)   Safe can veto)     inside the ladder)
```

1. **Roles** (Zodiac Roles v2.1.1). The agent key holds one role. That role allows exactly one call: `fund(game, amount)`
   on the current GameFunder, with `amount <= perGameCap`, no ETH attached, no delegatecall. Anything else reverts
   before it is queued.
2. **Delay** (Zodiac Delay 1.1.1). Roles doesn't call the Safe; it puts the call in Delay's queue. A queued call can run
   1 hour after it was queued (`txCooldown`) and must run within the next 24 hours (`txExpiration`). Anyone can run it
   (`executeNextTx` is permissionless, so a keeper bot does it).
3. **Safe** (v1.5.0, 2-of-3). Delay is the only module this path adds. When the call runs, the Safe is `msg.sender` at
   GameFunder.
4. **GameFunder** (`src/games/GameFunder.sol`). Checks the caller is the Safe, the game came from the GameFactory
   (`isGame`), the game's lifetime cap and the rolling 7-day budget, then sends ETH **from its own balance** to
   `game.fund()`.

**For games (`GameKit`, `docs/games.md`):** because GameFunder pays from its own balance, `msg.sender` at
`game.fund()` is the GameFunder, not the Safe. `GameKit.fund()` accepts calls only from the factory's current funder,
read live, so after a ladder change the new GameFunder funds existing games once the Safe calls
`GameFactory.setFunder`. A fund that arrives after a game is retired is forwarded to the Safe, never reverted.

### Why GameFunder holds its own ETH

The other option was for GameFunder to pull from the Safe. That makes GameFunder a Safe module (or an allowance
holder), a second contract with power over the whole treasury. With its own balance:

- the agent's path ends at one function that can only send GameFunder's ETH to listed games;
- the most a stolen agent key can move is what the Safe put in GameFunder, and still only at the ladder's pace, an hour
  later, in public;
- the Safe's own ETH and tokens are out of reach: the Roles scope has no other target and forbids sending value.

The Safe tops GameFunder up with a plain ETH transfer (anyone can send it ETH).

## Who can do what

| Who | Can | Can't |
|---|---|---|
| Agent key | queue `fund(game, amount ≤ perGameCap)` | call anything else, send ETH, delegatecall, call the Safe, Delay or Roles admin functions, add modules or owners, skip the hour |
| Anyone (keeper) | run the next queued call after its hour; `skipExpired()` | change what's queued |
| GameFunder | pay a listed game from its own balance, inside the ladder | pay a non-game, exceed a cap, touch the Safe |
| Safe (2 of 3 owners) | veto queued calls, change Roles and Delay, sweep GameFunder, disable Delay | (owners decide everything) |

The fork test `test/fork/Funding.t.sol` checks every row of this table against the real deployed contracts.

## The ladder

GameFunder enforces two numbers, fixed when it is deployed:

- **weekly budget**: total sent in any rolling 7 days (default **0.2 ETH**);
- **per-game cap**: total a single game can ever receive (default **0.1 ETH**).

Roles also caps one call's `amount` at the per-game cap.

**Raising (or lowering) the ladder** means deploying a new GameFunder with the new numbers and re-pointing Roles, in one
Safe batch (rehearsed in `test_fork_ladderChangeRepointsRoles`):

0. `Delay.setTxNonce(queueNonce())` if the queue isn't empty (or wait for it to drain). Funds still queued for the
   old GameFunder would revert once it is swept and jam the queue. The number is fixed when signed: check
   `queueNonce()` right before executing and re-sign if it moved;
1. deploy the new GameFunder (same Safe, same GameFactory, new numbers);
2. `Roles.revokeTarget(role, oldFunder)`;
3. `Roles.scopeTarget(role, newFunder)` and `Roles.scopeFunction(role, newFunder, fund, amount ≤ new cap, no ETH)`;
4. `oldFunder.sweep()` (all its ETH back to the Safe);
5. `GameFactory.setFunder(newFunder)`;
6. send the new GameFunder its budget.

There is no owner and no upgrade path in GameFunder, so its numbers can't be changed in place. Lifetime per-game totals
start from zero in a new GameFunder; the old one's `fundedTotal` stays readable.

## Vetoing (the stop button)

Every call waits an hour in Delay's queue. To cancel, the Safe signs `Delay.setTxNonce(n)`: everything queued before
index `n` is dropped. `setTxNonce(queueNonce())` drops the whole queue.

**Delay is strict first-in, first-out.** Only the oldest call can run. If it reverts at execution (not a game anymore,
over a cap, GameFunder out of ETH), every later call waits behind it until the Safe vetoes it or it expires (1 h + 24 h
after it was queued; then anyone calls `skipExpired()`). So the agent should only queue a fund that will pass,
counting what is already in the queue (`GameFunder.spentInWindow()`, `fundedTotal(game)`, its balance).

**To stop the agent in one transaction:** `Safe.disableModule(prev, Delay)` (`prev` is `0x…01` when Delay is the
first module). Delay can no longer act on the Safe, so every queued item fails when executed and later expires. Before
ever re-enabling Delay, clear its queue with `setTxNonce(queueNonce())`.

**A vetoed fund stops that game's funding.** When a fund the engine queued is passed over (`setTxNonce`) or expires
without a `Funded` for its game, the engine stops queuing funds for that game, alerts once, and never asks again, so a
veto never has to be repeated every hour. To restart a game's funding, the Safe funds it once itself
(`GameFunder.fund(game, amount)`, through Delay or directly): the engine takes a `Funded` for the game after the vetoed
fund as the signal and resumes top-ups.

To cut off only the agent and keep Delay: first `Roles.assignRoles(agent, [role], [false])` (or `revokeTarget`), then,
in a later transaction, `setTxNonce(queueNonce())`. In that order: `setTxNonce` takes a fixed number, so it can't cover
entries the agent queues after it was signed.

## Expiry

A queued call that nobody runs within 24 hours after its hour is up can't run anymore. `skipExpired()` (anyone) moves
the queue past it. This also bounds how long a bad call can block the queue without a veto: 25 hours.

## Setting it up (needs an explicit signer decision)

`script/FundingSetup.s.sol` prints the batch for the Safe Transaction Builder. It never broadcasts.

```
cd contracts
SAFE=<safe> AGENT=<funder key address> (GAME_FACTORY=<existing factory> | REGISTRY=<ModuleRegistry>) \
  [WEEKLY_BUDGET_WEI=200000000000000000] [PER_GAME_CAP_WEI=100000000000000000] [SALT_NONCE=0] [TOPUP_WEI=0] \
  forge script script/FundingSetup.s.sol:FundingSetup --fork-url $MAINNET_RPC_URL
```

With a mainnet `--fork-url` it also checks the pinned contracts' codehashes. Import the printed JSON line in the
Transaction Builder (its checksum is the one the app computes, so it imports without a warning). The batch, in order:

0. only without `GAME_FACTORY`: deploy the GameFactory with CREATE2 (Safe and registry fixed);
1. deploy Delay through the module factory (owner, avatar and target = the Safe; cooldown 1 h; expiration 24 h);
2. deploy Roles through the module factory (owner and avatar = the Safe; target = Delay);
3. deploy GameFunder with CREATE2 (deterministic deployer);
4. Delay: enable Roles as its module;
5. Roles: give the agent the role;
6. Roles: scope GameFunder;
7. Roles: allow only `fund(game, amount ≤ perGameCap)`, no ETH, no delegatecall;
8. GameFactory: `setFunder(GameFunder)` (games read their funder from the factory);
9. Safe: enable Delay as a module (last, so nothing reaches the Safe until everything is in place);
10. optional: send GameFunder its first budget (`TOPUP_WEI`).

Before signing, the batch can be replayed on a fork of the real Safe:
`FUNDING_SAFE=<safe> MAINNET_RPC_URL=… forge test --mc FundingForkTest --mt RealSafe`.

Notes:

- The module factory and the CREATE2 deployer are permissionless. If someone deploys the same module or GameFunder
  first, it is the identical contract (same settings, owned by the Safe) and the batch reverts; rerun the script with
  another `SALT_NONCE`.
- Enabling a module is a standing change to the Safe. It can be undone (`disableModule`), but until then the agent
  can spend what GameFunder holds, at the ladder's pace.
- GameFunder takes the GameFactory's address at construction, so the factory comes first: an existing one
  (`GAME_FACTORY`), or the one the batch deploys in step 0. The fork test
  `test_fork_realGameFactory_fundsAGame_aRetiredGameNeverJamsTheQueue` applies that batch and funds a real game.

## Pinned contracts (Ethereum mainnet)

Codehashes read from mainnet on 2026-10-08 and asserted by the fork test.

| Contract | Version | Address | Codehash |
|---|---|---|---|
| Zodiac ModuleProxyFactory | 1.2.0 | `0x000000000000aDdB49795b0f9bA5BC298cDda236` | `0x01623cbcf010a1c326230f1b2d5f48a66b440232ee49096102bc84967dc5f21e` |
| Zodiac Delay (mastercopy) | 1.1.1 | `0x824175b945838d127C1ca83CbcE11D8e44F6dF01` | `0xdd928eddfff7b68bd8fff28178c29e3388c1d098051d9262f151c4b534c577b8` |
| Zodiac Roles (mastercopy) | 2.1.1 | `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5` | `0x471d8b3b419f1eb955230c0326c8812176df49bf3c7b414a563fda5a3c6c10b6` |
| Safe (singleton) | 1.5.0 | `0xFf51A5898e281Db6DfC7855790607438dF2ca44b` | `0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2` |
| SafeProxyFactory | 1.5.0 | `0x14F2982D601c9458F93bd70B218933A6f8165e7b` | `0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529` |
| MultiSendCallOnly | 1.5.0 | `0xA83c336B20401Af773B6219BA5027174338D1836` | `0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663` |
| CompatibilityFallbackHandler | 1.5.0 | `0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4` | `0x3c6a85bcf7b563daa624b884b4e9a1b9fa5371edde7be945d998071a48f28bbc` |
| Deterministic deployment proxy | n/a | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | `0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989` |

Roles 2.1.1 links two libraries, Integrity `0x6a6Af4b16458Bc39817e4019fB02BD3b26d41049` and Packer
`0x869718C939652084BC491fBC5ce0D3C1d5B309F0` (both deployed).

Sources:

- Zodiac canonical addresses: `gnosisguild/zodiac` `src/contracts.ts` at commit `89352c4f05d4b223b9c555ca963a787fd930da2d`
  (2026-07-14). The same file lists **Roles 2.1.0 (`0x9646…D337`) and Delay 1.1.0 (`0x01F8…339b`) as `FAULTY`**; don't
  use them. Verified sources of the pinned versions: `mastercopies/{factory/1.2.0,delay/1.1.1,roles/2.1.1}` in that
  repo (Delay compiled with solc 0.8.20, Roles with 0.8.21).
- Roles behaviour: `gnosisguild/zodiac-modifier-roles` (`Roles.sol`, `PermissionBuilder.sol`, `PermissionChecker.sol`,
  `Types.sol` of 2.1.1): `assignRoles` also enables the agent as a Roles module; a scoped target only allows functions
  given by `scopeFunction`; `ExecutionOptions.None` forbids value and delegatecall.
- Delay behaviour: `gnosisguild/zodiac-modifier-delay` (`Delay.sol`): FIFO `txNonce`, `setTxNonce` (owner),
  `executeNextTx` (anyone), `skipExpired` (anyone).
- Safe: `safe-global/safe-deployments` `src/assets/v1.5.0/*.json` at commit `7b1fb6d6` (canonical addresses and
  codehashes); `safe-global/safe-smart-account` tag `v1.5.0` `ModuleManager.sol`: `execTransactionFromModule(address,
  uint256,bytes,uint8)` is unchanged from 1.4.1, the only addition is an optional module guard (`setModuleGuard`). None
  is set here; both Zodiac modules work with 1.5.0 as is (fork test).
- Transaction Builder file format and checksum: `safe-global/safe-react-apps` `apps/tx-builder/src/lib/checksum.ts`,
  `src/typings/models.ts` (tx-builder 1.18.3).
