# The Sequencer

The Sequencer builds new games (a contract and a page) in public. This document says what
keeps a game's code and its page from hurting anyone. The game contracts' rules are in `contracts/docs/games.md`.

## Who holds what

| Part | Holds | Can |
|---|---|---|
| The engine's enclave (attested) | the keys that deploy games and queue their funding; its log key; a GitHub token | sign build orders, merge a build that passed its own gates, deploy it, queue its funding, move the site's `release` branch |
| The `verify` job (`.github/workflows/sequencer.yml`) | no secret; the job's read-only token (contents, actions) | refuse an order that isn't the enclave's, isn't fresh, or already has another run |
| The `build` job | the sequencer's model key only (environment `seq-build`) | read the checkout and write the game's own folders; no push rights |
| The `publish` job | the bot App's key only (environment `seq-publish`) | one commit on `seq/*`, a pull request |
| Pull request checks (`sequencer-gates.yml`, `ci.yml`) | nothing | advise; the enclave runs every gate again and decides |

The model key and the bot key are never in the same job, and no pull request job sees either. No wallet key is on
GitHub. The repository's administrators can change GitHub settings and push branches: the enclave's records and the
watchdog make that visible, but GitHub itself is not part of the attested system.

## How the sequencer builds

One order is one round of one build, signed by the enclave's log key and refused unless it is fresh and run once
(every job refuses a re-run). The same signed order dispatched again inside its 20-minute window is refused too: the
`verify` job lists the workflow's runs with its read-only token (`actions: read`) and refuses an order whose id
(`seq order:<id>`, the run's title) any other run carries, in any status, or when GitHub can't answer. The workflow's
concurrency group (one per order: its signed ref) holds each run, `verify` included, until the one of the same order
before it has finished, so of two dispatches of one order the later one always sees the earlier one; orders of
different builds run side by side. An earlier one still pending is cancelled by the concurrency group,
or, if its verify is already running, sees the later one and is refused. Order ids end in a random suffix the engine
draws when it plans the round, so no one can start a run under a coming order's id ahead of it. A run deleted from
GitHub's history (that takes `actions: write`) is not seen: like the repository's other settings, that is outside the
attested system.

A lead plans, up to four workers write the contract, its tests and its page in parallel, a tester tries to break it
and a fixer repairs it (at most three rounds; the game's whole suite must also pass when the build runs it itself, and so must the enclave's
static gates and its G9 conformance run on a fresh anvil, run early as a self-check; the enclave's own run decides), and
a reviewer writes the pull request. A game starts from the closest of the tested templates (a daily check-in, last
player wins: `contracts/docs/games.md`, "Templates"): the lead names it in the plan, or none when none fits,
and the workers copy it and change only what the spec needs. Every role:

- sees the brain-approved spec only, never an idea's original text, and treats the spec, the plan and any findings
  as data;
- loads no settings or memory files from the repository or the runner: its instructions are its role prompt;
- has a fixed tool list: reading and writing files, and running forge on the game. No shell, no web, no sub-agents;
- passes a path guard on every call: it reads the kit, the rules and its game, and writes only its own files;
- runs with a budget: at most $12 an order (less when the day's limit is lower, see `docs/MODELS.md`), split per
  role, with a margin for the last turn's overshoot. What every call cost goes back to the engine.

The build writes two files itself: `SPEC.json` (the spec, the interface, the files) and `game.json` (the address the
game factory will deploy the compiled contract to, and the hash of the code the chain will hold). The interface is
read from the build's own compile, after the suite passed: every public function beyond the kit's. The lead's plan names
an interface to guide the team, and a function it missed or named differently costs nothing. What G5 forbids still
fails: a payable function other than the kit's `fund()`, `receive` or `fallback`, a function named like selfdestruct, a
kit function missing. The enclave's G5 checks the interface against its own compile both ways. Then main's code
checks the patch again as data and the bot publishes it as a single commit.

### Pace

Several builds run at once: up to 3 (`SEQ_MAX_INFLIGHT`), and new ones start until 5 (`SEQ_DAILY_TARGET`) builds
shipped or are on their way that UTC day. Both are code defaults (`engine/src/config.ts` `SEQ_PACE`): the enclave
allows neither env, so changing them is a new image. A slot frees as soon as a build ends, and the next queued idea starts within the minute. A build
skipped for an outage holds the next start for 30 minutes. Each build reserves its whole budget (4 orders at the
day's ceiling) when it starts, so the day's dev part is what bounds how many run at once (`docs/MODELS.md`). The
database refuses two active builds of the same idea. A build's own waits (a deploy retried in 15 minutes, code not
yet visible) hold only that build.

At most 3 games are live (GameFactory's `MAX_LIVE`, a constant). A new game takes the slot of a live one: of the games
live 8 hours or more, the one with the fewest distinct players in 48 hours, then the oldest, and never one another
ship already takes. The brain must agree (a signed, delayed `retire` record, one public hour, Safe veto); the slot is
freed on-chain before the new game deploys, and a game merges only once a slot is free to deploy into (other games
merged and not deployed yet count). With several builds at once main may move under a build: one whose files main
changed after it was gated is skipped before its merge (its idea goes back to the queue) and never merged. An evicted game's retirement is announced as making room for a new game. The page
check stages a new game on a fork even when the factory is full (it clears the fork's live count; the real deploy
still waits for its slot).

### Spec amendments

A spec can be impossible as written: paying every finisher at settle is a loop over all players, past the 200k gas
limit. The lead may then propose one amendment in its plan: the reason, and the smallest change that makes it buildable
("pay by claim instead of at settle", "cap players at 50"). The team builds to it, and the build's report carries it to
the enclave. It is reviewed only when that round reaches a verdict (a round that stops without a pull request tells the
next round it was not reviewed), and only while a round is left to build it. The enclave checks the amended spec as it
checks any spec (plain text, at most 4,000 characters in all), then runs a best-effort text screen on the change (a verb
that loosens a rule, a cap, a limit or a gate; value in, calls out, low-level code); the screen is not the rule, the
gates are. What passes, the brain reviews, once a build. Approved, the round is not shipped: it was built to the old
spec, so the next round rebuilds it to the amended spec (the spec, then the change and its reason), which every later
order and verdict carry, so the SPEC.json that ships holds the amended spec. Its signed brain record, the build row and
the ship record name it. Refused, the next round is told to build the spec as written. An amendment changes what is
built, never a gate: every gate runs the same either way.

The whole workflow can be run offline: `sequencer/test/sim.test.ts` runs its three jobs' scripts against local
stand-ins for the model API and GitHub, with the real Agent SDK in between.

## Changes to the site

Besides new games, the brain can order a change to DNA's own website: a new page (`web/app/`). The order says which
kind it is, and the enclave signs it like any other. The website deploys from the build repository's `release` branch
(`SEQ.siteLive`, a code constant; off, the brain's pick of a site change is a no-build with an alert to the owners).

- **What it may touch.** New files only: a page, components, CSS modules and plain `.ts` modules in a route folder that
  is new at the base, under `web/app/`. Nothing that exists is changed, renamed or removed (the home page and the trade
  page included), no file goes beside an existing page or in a folder the site already has, and a new page never takes
  a URL an existing page serves (no route group, which could take `/`, and no static page under a dynamic one, which
  would win over it). Never the site's data layer, its shared shell and scene, the game pages, the API routes, the
  proof, security, Sequencer and play pages, any layout, route or middleware file, the wallet guard and helper, the
  server and content-policy settings, packages, or the docs (nothing on the site renders `docs/`).
- **Its gates.** The paths (G1, against the base's tree; no dynamic, private or grouped folder, so every page a change
  adds can be opened as it is), the
  imports (G2, an allowlist: react, next/link, next/image, types from next, the shared UI, the shell and its icons, the
  data layer's public read side `_data/source`, `types`, `flags`, `chain`, the fee constants `launchFee`,
  and files in the page's own folder), the code
  (G11: the same reach rules as a game page, and a site page is server-rendered HTML only: no `"use client"`, no `on…`
  handler attribute, no spread attribute or `<style>`, no namespaced attribute or `as`, every tag an intrinsic or a
  name the file binds as an import, a function or a const arrow, metadata one const holding only a title and a
  description, every `href` and `src`
  a path on the site written out, and its words and strings pass the same screen as a public post: no handles, no
  cashtags, no other site's name or link; it never sees `process`, the network or a server action), the text (G12),
  and the page check (G15): the main site is built with the change and every page
  it touches (or, under a page, its nearest page) is opened in the same headless browser. A site page has no wallet at
  all: any wallet request, any call off the site, a link off the site other than the shell's own (as the browser
  resolves it, so an encoded or assembled address is caught too), a frame or a popup stops it.
- **Then the same path as a game.** The brain's verdict, one public hour in which the Safe can veto, the page check
  again during that hour, then the merge (exactly the files the ship record names) and the `release` branch. There is
  nothing to deploy or fund.
- **Live means served.** A site change is announced as live, and its idea's author told so, only once the site serves
  it: the site's `/api/health` names the deployed commit (`RAILWAY_GIT_COMMIT_SHA`), which must be the merge or a later
  commit on top of it, and each new page answers 200. Until then the engine checks again every minute (a page that
  answers 500 or nothing is waited on like a deploy still building); after 30 minutes without it (counted from when
  the release could first deploy), the owners get one alert and nothing is announced. A veto once the release branch
  holds the change takes nothing back: the owners get one alert to revert it on main.
- **What the check can't see.** The page check runs a change's pages over a simulated day at most (24 hours in the
  public hour). A page written to render differently after that, or on a date or a condition the check does not
  reach, would pass, and nothing checks the site's released pages again each day, as it does game pages. Code review
  (the brain's, and anyone reading the public pull request) is the control for that.

## New fee and split modules

The brain can also order a new fee module (the hook asks it for the fee) or split module (FeeVault asks it how to split
the fees). The Sequencer only builds it and proposes it: whether it is ever used is the Safe's decision, through the
module registry's own flow.

- **What it may touch.** Two new folders, `contracts/src/modules/<name>/` and `contracts/test/modules/<name>/`: Solidity
  files and the build's `SPEC.json`. Nothing else, not even the existing modules.
- **Its gates.** The paths (G1); the imports (G2: the policy interfaces only; tests also forge-std and the module
  conformance suite); the code (G3: no storage, no immutables, no calls, no assembly); the structure (G5: one contract
  implementing exactly one of `IFeePolicy` and `ISplitPolicy`, that one function as its whole ABI, pure, no
  constructor input); the bytecode (G4: no write, log, call or create opcode, and nothing read of the block, the
  caller, balances or gas); the tests (G6: the module conformance suite, which asks the module as the hook or FeeVault
  does, with the 40,000 gas cap, for any input, and checks that inside its bounds a fee is at most the 5% cap and a
  split is one FeeVault accepts; the code it ran on must be the module's own compile, and the bounds it ran with the
  bounds in `SPEC.json`); gas (G8: under 40,000); planted bugs (G7). The caps live in the hook and FeeVault; the
  suite's copies are pinned to them by tests. The tests may not mock the module's answers or rewrite its code or
  storage (mockCall, mockFunction, etch, store), and no test contract may inherit the module. What the suite can't see:
  a module can key a zero fee or a revert to the inputs the hook gives it (the block number, the price, the tick), on
  values no test happens to try. The Safe's review of the code is the control for that, and should read for it.
- **Then.** The brain's verdict, one public hour in which the Safe can veto, the merge. The ship record carries the code
  hash of the enclave's own compile, the address the CREATE2 deployer will put it at, its bounds, and the three calls
  for the Safe: deploy it (anyone may), `ApproveCodehash` for exactly that code hash and those bounds, `Register` at its
  start params. The engine sends none of them. Once registered, the registry's levels decide what may happen next.
- **The image first.** The module kit ships in the engine image. An image without it builds no module: the brain's pick
  of a module is a no-build with an alert to the owners. So the image with the kit goes out before any module is built.

## Changes to the engine

The brain can also order a change to the engine's own code. The Sequencer never merges one: an owner reviews it and
merges it, or not. After a merge it runs only once the new image is built and its compose hash has passed the one-hour
public timelock on chain, like any other change to the engine.

- **What it may touch.** `engine/src/<name>.ts`, `engine/test/<name>.test.ts` and test fixtures. Never what no order
  reaches (below), never the tests of those parts, never the engine's packages, scripts, image or migrations.
- **Its gates.** The paths (G1), with a test added or changed in `engine/test/` for any change to `engine/src/`, and no
  test removed while its code stays. That rule is advisory: it shows a test file changed, not that the test checks
  the change; CI runs the tests and the owner judges them. The imports and code (G2: the engine's own files, node's
  builtins but those that run other code or reach the process (`node:process`), the packages in the image; no
  `eval`, `Function`, `globalThis`, `Reflect` or `.constructor`; no node internals (`process.binding`,
  `getBuiltinModule` and the like); `process` only as `process.<name>` and the environment only as
  `process.env.NAME`; no `import.meta` but its url; a test that imports what no order reaches counts as that part's
  test and is refused). The text (G12). Its reach (G16, against the base): no environment name a file did not read
  before, no network sink (fetch, sockets, `node:http(s)`, `net`, `dns`, `tls`, `dgram`, a database client, an RPC
  transport, the dstack SDK) in a file that had none, no URL host a file did not name before. The enclave never runs
  the change's code: CI runs its tests on the pull request, as advice for the brain and for the owner who reviews it.
- **Then.** The brain's verdict, with a touch report per file: lines added and removed, every watched module it uses
  (keys, config, the senders, GitHub, the owners' channel, posts, the models, the enclave, approvals, the log) and how
  its calls into them changed, new environment names, new `node:fs` or `node:os`, `eval` or `Function`, new URLs and
  host-like text, strings built for a network call. It is a pointer, not a guarantee: the reviewer reads the full
  diff. A signed ship record names the pull request, its commit, its files and that report; the owners are told, with
  the report and the open risk it answers. The build ends handed over. The pull request stays open; no step of the
  Sequencer merges it (see the `main` settings below for what enforces that).
- **Where the ideas come from.** People's ideas only: every build answers a queued idea with a person on record (an
  X author, or an IdeaMarket submitter that is not the engine); an empty queue waits and says so. Off by default
  (`SEQ.ownIdeas`, a code constant): when no idea waits in the queue, the brain may pick one of the open risks in its
  self-file (the newest one the enclave signed, else the file) and order a fix (a site change, a module or an engine
  change), at most once a day. The self-file quotes what others wrote, so the brain reads it as data. The build keeps
  the risk it answers. Public text says a thing was fixed only once it shipped.

## What no order ever reaches

Whatever its kind, no order may touch: the hook, the token or any other core contract, the game kit and the
interfaces; `.github/` (workflows and repository settings); the measured compose and its pins; the private
personality file; the enclave's lockdown,
configuration and mode switch; keys; owner approvals and signatures; the signed log; the transaction guards (with the
agent key's queue and its op table); what the engine posts and its owners' channel, the chain reads it judges, its
GitHub client and the brain; the Sequencer's own gates, its workflow code and the page check; the
spend caps, money paths and what may be published; the site's security layer; dependency files; and the tests that
hold all of these in place. The gates refuse each of these on their own, behind each kind's own reach, and each has a
planted test.

## Game pages

A game's page is code an AI wrote. It lives in `web/app/g/<game>/` and is served only from a separate address,
`play.<site>`. Six layers stand between that code and your wallet:

1. **Its own address.** Game pages never run on the main site. They can't read the main site's storage or script its
   pages. The main site sets only host-only cookies (`__Host-`), which are never sent to `play.<site>`. Both send HSTS
   with subdomains.
2. **One door to your wallet.** Before any page code runs, a guard (`web/app/_ui/guard.ts`) takes your wallet's
   provider and puts a checked one in its place. It does the same for other names wallets use, and for anything else
   on the page that looks like a wallet. The checked provider lets the page read, and it sends a transaction only to
   this game's own contract, with no value, calling one of the game's functions, after checking the chain, that the
   game is listed by the game factory, and that the game wasn't pulled. It refuses every kind of signature and
   approval. If your wallet won't let the guard take its place, the guard refuses everything and says so.
3. **A check in a real browser.** Before a game ships, the engine opens its page in a headless browser with a test
   wallet and a test chain. It clicks everything, moves time forward by days, and varies randomness. Any request
   other than the allowed ones, any target other than the game, any network call off the page's own address, any
   frame or popup stops the game from shipping. The same check runs every day on the page as it is served.
4. **A strict content policy.** The browser runs only scripts the server marked for that one page view. No remote
   scripts, no `eval`, no frames, no workers, and no network except the page's own address.
5. **Review and an hour in public.** A second model reviews the code, the brain decides, and every new game waits one
   public hour during which the project's Safe can veto it.
6. **A kill switch.** A pulled game's page stops at once for new visitors. Pages already open check every minute and
   before every transaction, and stop too. If the check itself can't be reached, the page stops as well.

### Until the play address is up

The play address is not running yet. Until it is, a game is played on the main site's `/play` page through a panel
the site's own code draws, never the game's page: the game's state, a form per read, a button per call. Its list is
the games the GameFactory deployed, named by their signed ship records. Each game's ABI is the `game.json` its ship
record pins: taken only if its bytes are the file the record lists and it names the same address and code hash. A
call goes only to that game, with no value, never one of the kit's admin calls (a retired game: only `claim`), and only
after the code at the address hashes to the ship record's and the call was simulated. No approval or signature is ever
asked.

### Writing a page

The gates read a page's code as written. Indexing with anything but a number (`arr[i]`, `obj[key]`) is refused,
because a computed key can reach anything; use `arr.at(i)`, `arr.map(...)` or a named property. Only lowercase tags
are HTML elements: `<Link>` from `next/link` and the page's own components are fine.

### Notes on the layers

- The nonce: a game page is rendered with a fresh nonce, and the CDN keeps that HTML for up to 5 seconds, so visitors
  in that window share one nonce. The nonce stops code injected into the page later; it is not a secret from the
  page's own code.
- The policy blocks remote scripts and any network call off the page's address. A page's own (nonced) script could
  still try to leak something through what the policy allows; that is what the browser check (layer 3) watches for,
  not the policy. Violations are reported to `/api/csp` on the play address and logged.
- The checks that need a real browser (the guard running before any page code, the kill reaching an open page, the
  policy blocking what it should) run in the engine's page check, against the real built pages.
- A game page's code never runs on the server: the server renders only the game's title and state, and the game is
  mounted in the browser after the guard has taken the wallet's place.
- The page check (`pagecheck/`) runs in its own container next to the engine: no secrets, no access to the enclave's
  keys, no network beyond the engine. It builds the play address with the game's page, serves it under the real
  address, and loads its own copy of the chain (the game deployed through the real factory and funded, as the engine
  staged it). The test wallet sits in every frame and window; decoys sit under the other names wallets use. Every
  wallet request is checked with the code that made it: it must come through the guard. Anything the guard refuses
  counts against the page too (the guard writes each refusal to the browser console). The clock runs 48 hours at the
  gate and 7 days during the public hour, the chain's clock in step; randomness is fixed at 0, 0.5 and almost 1;
  phone, desktop and tablet profiles with no automation flag. The check's chain carries on from the real chain's head (its
  block number, time, base fee and block producer), the test wallet is a new address each check, and every response
  carries the simulated date, so neither the chain nor the server's clock gives the check away. WebRTC counts as
  network. A page that keeps the browser busy past a run's limit, or crashes it, fails too. Any violation kills the
  build (or pulls the live page).
- Each kind of attack the layers must stop has a planted page in `pagecheck/test/fixtures/`, and a test that shows
  which layers catch it. One thing they show: the content policy does not stop a page from adding a frame with inline
  content (`srcdoc`); the static check and the browser check do.
- Pulling a page: a signed `page-kill` record stops it at once. Then the enclave puts a commit on top of the released
  code that removes only that game's page folder and moves `release` to it right away (removing code needs no public
  hour; a signed `release` record names it), and merges the same commit into `main` with a merge commit, so later
  releases keep moving forward from it.
- The play service runs with `SITE_ROLE=play`, `NEXT_PUBLIC_LIVE=1`, a `DATABASE_URL` whose role can only read the
  `log` table (the kill list), a `PLAY_RPC_URL` with a read-only key, and `GAME_FACTORY`; no other secret, no previews.

## What can still go wrong

A game page is code written by an AI. We check it six ways. Even so, a page could behave well under every check and
badly for a real visitor: it could notice it is being checked, wait for conditions the check doesn't reproduce, or
meet a wallet the guard can't wrap. If that happens, it could ask your wallet to approve a transaction or a
signature, and it could learn your wallet address and try to send it somewhere.

Your wallet shows you what you are asked to sign before you confirm. DNA games never take deposits, and never need a
token approval or a signed message. Never approve, sign or send value on a game page. If a page asks, reject it. The
page can be pulled in seconds.

## Where ideas come from: rounds or live

`IDEA_MODE`, a literal in the compose (param `ideaMode`), picks how ideas reach the build queue:

- `rounds` (the default): IdeaMarket's on-chain rounds. A closed round is researched and its outcome proposed after
  the public hour, then finalized after the Safe's 24 h. Only then do its accepted fee and build ideas queue. The
  engine submits X ideas on-chain (the top 16 of a round).
- `live`: every idea is judged as it comes in. A site submit is judged within a minute of being indexed; an X mention
  past the gate and the screen is judged in the same intake run. Each judgment runs the reader, the brain's signed
  outcome, and the red team on an acceptance. An accepted build or fee idea queues at once. The Sequencer picks the
  best queued idea whenever a build slot is free (the pace below).
  - Switching on: X ideas the rounds mode took in but never judged (candidates, picks, and submits whose round has
    no report) are judged the same way. Site submits are judged from the switch on; ideas already in a round keep
    that round's outcome, or the all-void refund. Quotes of our posts from the last 2 days are fetched hourly, so an
    idea posted as a quote meets the same gate and screen as one posted as a mention.
  - The gate in live mode: no author bar beyond a profile (no badge, account age or follower count), one idea per
    author per UTC day, no links, and no near-duplicate or same title of an idea from the last 7 days. Switching on,
    every stored mention (the table starts at launch) that an earlier gate or screen turned away (bindings aside) is
    gated and screened again from its stored text and author, once, with nothing taken from the old verdict.
  - Holder staking has no say. Every closed round gets an all-void report, so every stake is refunded (the 1,000 DNA
    submit fee is burned as always).
  - X ideas stay off-chain. They are numbered from 1,000,001, and their reward goes to the author's bound wallet as
    before.
  - Every verdict is a public `idea` record and an announcement. A site idea's verdict also goes to X; an X idea gets
    its reply.
  - X carries every build step: the pick and why (`seq_started`), a pull request with its link (`seq_pr`), each
    verdict (`seq_verdict`), a no-build (`seq_declined`), the ship or the kill.
  - When `TELEGRAM_PUBLIC_CHAT` is set (param `telegramPublicChat`: a channel's @name or chat id, with the bot an
    admin there), those posts go there too.

## Settings the operator sets

The repository's settings decide part of this. They are set by hand once the public repository exists, and checked
then (a step-by-step with a check per item comes with the rehearsal):

- `main`, on the public repository: a ruleset with pull requests required, required approvals 0, require review
  from Code Owners on (`.github/CODEOWNERS`), dismiss stale approvals on push, require approval of the most recent
  reviewable push, the enclave's gate status and CI required, no force pushes or deletion. Neither the Sequencer's App
  nor the enclave's token is in its bypass list. The code owners own everything but what the sequencer may change (a
  game's or a module's own folders, the site's pages and components, the public docs). The enclave merges games, site
  changes and modules through pull requests. The required gate status stops other collaborators, not the holder of the
  enclave's token.
- What keeps an engine change an owner's to merge: the engine's token belongs to the owner account, so GitHub can't
  tell the engine's approval from an owner's. Owner-merge for engine changes is enforced by the attested engine code
  (it never calls the review API, and its ship path refuses to merge an engine change), and that code itself can only
  change through an owner merge and the one-hour timelock. Hardening after launch: a GitHub App of its own for the
  enclave in place of the token, so a code owner's approval is the owners' alone.
- `release` (the branch the site deploys): updated only by the enclave's account, no force pushes or deletion.
- `seq/**`: created and updated only by the bot App.
- Actions: the default token read-only, Actions can't approve pull requests, outside contributors' runs need
  approval, only pinned actions.
- The `publish` job's `GITHUB_TOKEN` has `contents: read` only, for the checkout; every write goes through the
  App token.
- Environments `seq-build` (the model key, and `SEQ_PROMPTS`: the team's wording, base64 of `# Prompt seq.<id>`
  sections; unset, the neutral defaults in `sequencer/src/roles.ts` apply) and `seq-publish` (the App id and key): `main` only. No repository-level
  secrets.
- The bot App: contents and pull requests, read and write, this repository only. No workflow or admin rights.
- The enclave's token: contents, pull requests and commit statuses (read and write), actions (read), this repository
  only, at most a year (the watchdog warns two weeks ahead).
- The model key: its own account with a hard spending limit.
- Secret scanning and push protection on.
