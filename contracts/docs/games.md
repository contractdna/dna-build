# Sequencer games: what a game can and can't do

The Sequencer (the AI dev team) builds new games as standalone contracts. Every game inherits `GameKit`
(`src/games/GameKit.sol`) and is deployed by the `GameFactory` (`src/games/GameFactory.sol`). Nothing else on-chain
trusts a game except GameFunder, which only pays games the factory lists. Status: built and tested. **Nothing is
deployed.**

## The rules, and what enforces each

| Rule | Enforced by |
|---|---|
| A game is paid only by the current GameFunder, never by players | `GameKit.fund()` is the only payable entry point and checks `msg.sender == factory.funder()`. There is no `receive` or `fallback`. The Sequencer's gates refuse any other payable function |
| No user deposits at this ladder level | as above: players can't send ETH to a game. A later ladder level that takes deposits needs a new kit |
| Winners are paid by pull claims, never more than the game holds | `_credit` refuses more than `freeBalance()` (balance minus what is already owed); `claim()` clears the debt before paying (a claimant that re-enters gets nothing more: tested) |
| A Safe pause stops every new payout | `_credit` refuses while paused; the reference game also settles rounds only while live. What is already owed stays claimable |
| Claims stay payable forever | `claim()` works while paused and after retiring |
| Only the Safe can pause a game | `pause(bool)` checks `msg.sender == safe` (the factory's Safe, fixed at construction) |
| No plays while paused or retired | `_played` refuses them itself, so no game code can count a play then |
| A play is always counted for the person who made it | `_played` emits `Played(msg.sender, valueWei)`; a game can't name someone else |
| At most 3 games live | `GameFactory.MAX_LIVE = 3`: `deploy` reverts at 3; retiring frees a slot, even if the game's own `retire()` reverts (`GameRetired(game, gameRetired)` records whether it went through) |
| No delegatecall, selfdestruct, contract creation or upgrade path | `GameFactory.deploy` scans the runtime code and refuses CREATE, CALLCODE, DELEGATECALL, CREATE2 and SELFDESTRUCT. The Sequencer's gates also refuse them (and any external call) in the source |
| Only the agent (unpaused, autonomy level 5 or more) or the Safe deploys and retires games | `GameFactory._auth` |
| Retiring returns the game's money to the treasury, claims stay | `retire` stops plays; then anyone calls `sweep()`, which sends `balance - owedTotal` to the Safe once no round is open, or 7 days after retiring (the backstop: from then on the game's own code is not even asked, so a game that misreports or reverts can't hold the money) |
| A fund that arrives after retiring can't jam the funding queue | `fund()` on a retired game forwards the ETH to the Safe instead of reverting (the Safe's Delay queue is first-in, first-out: a reverting fund would block every later one) |
| A new ladder level can fund existing games | games read the funder from the factory; only the Safe changes it (`setFunder`) |

## The opcode scan and its one false positive

The scan walks the runtime code byte by byte and skips the data of PUSH instructions. The compiler also appends
some data to the runtime code (long string or byte constants, read with CODECOPY), and the scan reads that data as
code. A banned byte inside such data (for example a 40-byte constant full of `0xf4`) refuses the deploy although the
game could never execute it. This only errs on the safe side: the build is sent back for rework, never deployed with
a banned opcode. Games should use custom errors and short constants. The worst-case cost of the scan is about 3.2 M
gas for a full 24 KB contract, once per game.

## Building and testing a game

```
cd contracts
forge test --root games      # the games profile: games/foundry.toml (no ffi, no file access, no metadata tail)
```

A game lives in `src/games/<slug>/`, its tests in `test/games/<slug>/`. Its test contract inherits
`GameKitConformance` (`test/games/GameKitConformance.sol`), which runs the rules above against the real factory:
funding only by the funder, no other way to send value, plays counted for their sender, Safe-only pause that stops
new payouts, solvency across rounds, claims after pause and retire, a re-entering claimant, sweep (and its backstop)
and forwarding after retire. `src/games/example/` is the reference
game (never deployed); `test/games/example/Example.t.sol` is the test file to copy, and it passes every gate.

A game's tests import only forge-std, `GameKitConformance.sol` and the game's own files (the gates refuse anything
else, `GameFactory.sol` included). The suite's `setUp` already deploys the game through the real factory and funds it
through the real GameFunder, so a test never builds a factory itself. An invariant test inherits the game's test
contract and adds its handler after `super.setUp()`:

```solidity
contract ExampleInvariantTest is ExampleTest {
    ExampleHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new ExampleHandler(Example(address(game)));
        targetContract(address(handler));
    }
}
```

`vm.etch`, `vm.deployCode` and forge-std's `deployCode` helpers are refused too: they would put code in place that
the imports rule keeps out. The games profile turns forge's dynamic test linking off, so the gates read each test
exactly as written (with it on, forge rewrites `new <game contract>(...)` in a test into a cheatcode call).

## Templates

Tested games the dev team starts from instead of writing a game from scratch: `daily-checkin` and `last-buyer`.
`raffle` is kept and tested but held, not offered to the team (`HELD_TEMPLATES` in `sequencer/src/roles.ts`): a script
with a few addresses that reveals last picks the winner; held until entries carry a stake. Every template's folder
name is reserved: no build may take it. Each is a contract in
`src/games/<template>/`, its tests in `test/games/<template>/` (the conformance suite, unit tests, a fuzz test and an
invariant; every planted bug the mutation gate can make in it is caught) and a page in `web/app/g/_template-<template>/`
(an unrouted folder). Each passes every gate when copied into a new game's folders (`sequencer/test/templates.test.ts`).

| Template | The game | Its values (bounds) |
|---|---|---|
| `daily-checkin` | each address checks in once per UTC day; once a day is over, `settle(day)` sets aside a share of the free balance split evenly among that day's check-ins; each collects its own share (`collect(day)`, then `claim`), no loop over players; what is not collected in time goes back (`release(day)`) | `SHARE_BPS` 10 to 500; `COLLECT_DAYS` 1 to 6 |
| `last-buyer` | each play restarts a countdown; when the round ends, `settle` owes the last player a share of the free balance | `COUNTDOWN` 10 minutes to 1 day; `MIN_ROUND` COUNTDOWN to 7 days; `PRIZE_BPS` 100 to 2000 |
| `raffle` (held) | entries during a window, each with `hashOf(secret)`; then each entrant reveals its secret; `settle` draws one revealed entrant, owed a share of the free balance | `ENTRY_WINDOW` 1 hour to 3 days; `REVEAL_WINDOW` 1 hour to 2 days; `PRIZE_BPS` 100 to 2000 |

How a build uses them: the lead picks the closest template (a spec may name one) and says so in the plan's
`template` (or `none`, and only then is the game written from scratch). The workers copy its files into the game's
folders, point the test's import of the contract at the game's folder, and change only what the spec needs: the
rules, the constants (inside the bounds above, which each template's `test_params_inBounds` checks), the names and the
page's words. The template's tests stay, with tests added for every rule that changes. Values are constants, not
constructor arguments: a game's code hash must be known before it is deployed (no immutables but the kit's).

What each template can and can't promise:

- **No game pays faster than its values allow, however many addresses play.** A day's share is fixed and only split
  more ways; a last-player round lasts at least `MIN_ROUND`; a raffle pays one prize per round.
- **last-buyer has no fixed end to race for.** A round ends at the later of its start plus `MIN_ROUND` and its last
  play plus `COUNTDOWN`, so a play in the last second still gives everyone a full `COUNTDOWN` to answer. It is still
  bot-dominated: plays cost only gas, so a script that answers every countdown, day and night, wins every round a
  person can't stay awake for. What the template bounds is the cost: at most one prize per `MIN_ROUND`. Two scripts
  answering each other keep the round open and nobody is paid (retiring then waits for the sweep's backstop).
- **raffle (held) draws from its entrants, not from the chain.** The kit gives a game no randomness, a game makes no external
  call (so not the VRF the core contracts use), and `blockhash` and `prevrandao` are refused. So it is commit-reveal:
  each reveal mixes `keccak256(secret, entrant)` into the seed (a copied commitment adds a contribution, it never
  cancels one), and only entrants who reveal can win. The last entrants to reveal see the outcome and choose whether
  to reveal: k addresses choose among 2^k outcomes, and with free entry they can all be one script's. So a script with
  a few addresses that reveals last picks the winner; held until entries carry a stake. The page draws the secret,
  hashes it locally and shows it once; the player keeps it to reveal (a page has no storage).
- **daily-checkin** pays nothing until a day is over and settled, and a pause stops settling and collecting. After
  retiring, a day not settled stays open, so the sweep waits for the backstop.

## Test helpers

No function in a game's files (a test helper, or one in the game's source, an interface's included) may reuse a refused cheatcode's name (`exists`, `sleep`, `env…`, `readFile…`, `ffi`, `prompt…` and
the rest of the gates' list): the gates refuse any function so named, since a call to it reads like the cheatcode.

## Funding

Games are funded through the Safe's funding path (`docs/funding.md`): the agent queues `GameFunder.fund(game,
amount)` through Zodiac Roles, it waits an hour in Delay (the Safe can veto), then GameFunder pays the game from its
own balance inside the public ladder (2 ETH a rolling week, 0.1 ETH per game; the first GameFunder had 0.2 ETH a
week). The weekly budget is a ceiling: what games get is bounded by what the Safe tops GameFunder up with. The
funding batch (`script/FundingSetup.s.sol`) deploys the GameFactory too when `GAME_FACTORY` is unset (`REGISTRY` = the
ModuleRegistry whose agent may deploy games), and points the factory at its GameFunder.
