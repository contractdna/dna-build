# Models

DNA uses a handful of AI models, each for one job. Which model does which job, what it costs and how a model gets replaced are all public and checked by code. Nothing that moves money depends on a model: trading, fees, payouts and the keepers run without one.

## Who does what

The list lives in [`engine/models.json`](../engine/models.json). Each role has a model, a backup and a route (below). The backup is the model a swap falls back to; there is no automatic failover yet, so if a model is down its calls wait or are skipped.

| role | job | model | backup |
| --- | --- | --- | --- |
| brain | the judgement calls: build a game or not, ship a build or not, retire a game, propose a model swap | claude-fable-5-1 | claude-opus-5-5 |
| main | the fee loop's hypotheses and go/no-go calls | grok-4.7 | grok-4.3 |
| research | searches the web and X for fee research (its findings are untrusted) | grok-4.7 | grok-4.3 |
| intake | reads ideas from X and sorts them (fee, build, impossible, joke, shill, spam) | grok-4.7 | grok-4.3 |
| x-voice | writes DNA's posts | grok-4.7 | grok-4.3 |
| x-scout | reads recent posts of a fixed list of accounts for tone (X search) | grok-4.7 | grok-4.3 |
| x-audit | once a week, reads DNA's own posts for stale patterns the writer must stop using; also ranks each post's candidates that already passed every filter (it never decides what is safe) | claude-sonnet-5-5 | claude-opus-5-5 |
| redteam | attacks each fee experiment before it goes further | claude-opus-5-5 | claude-fable-5-1 |
| gate | the harder red team before a canary or a promotion | claude-fable-5-1 | claude-opus-5-5 |
| narrate | short notes, lessons and the journal | grok-4.3 | grok-4.7 |
| vision | checks post images | claude-opus-5-5 | claude-sonnet-5-5 |
| dev-lead, dev-worker, dev-tester, dev-fixer, dev-review | the Sequencer's build team (being built) | Opus 5.5, Haiku 5.5, Sonnet 5.5, Sonnet 5.5, Opus 5.5 | see the file |

The file also lists each model's price per million tokens. The engine uses those prices to count spend. A model that is not in the list is charged the highest listed price, so a surprise model can only make the count stricter. Haiku 5.5 has two rates, one for prompts up to 100,000 tokens and a higher one above that (the Grok models likewise above 200,000); the file lists both and each call is charged by its own prompt length.

## How calls reach the models

Claude calls go through [OpenRouter](https://openrouter.ai); Grok calls go to xAI's own API, with OpenRouter as their fallback:

- **OpenRouter** (`via: "openrouter"`): each request names the model's own provider and turns fallbacks off (`provider: {order: ["anthropic"], allow_fallbacks: false}` for Claude, `["xai"]` for Grok), so a call is served by Anthropic or xAI or not at all. Every Claude call takes this route, and a Grok call takes it only as a fallback (below). The engine checks every reply: the provider it reports must be the model's own and the model must be the one asked for (its id, or the same id with a release date). Any other reply is refused, still counted against the spend limits, and raises an alert. Each call's record (`llm_call` row and signed `llm` record) carries the route and the provider OpenRouter reported. Claude calls use OpenRouter's Anthropic-compatible endpoint (`https://openrouter.ai/api/v1/messages`), so prompt caching works as with Anthropic; Grok calls use its chat endpoint.
- **xAI direct** (`via: "xai"`): every Grok call goes to xAI's own API (the Responses API, `store: false`) under the same model id, and the engine refuses a reply that names another model. Server-side search (web search, X search) exists only there: the `research` (web and X) and `x-scout` (X) calls. Grok calls without search (the writer, the mention reader, the narrator, the main role) also go here, because OpenRouter limits a new account to 20 requests a minute per model. Each call's record carries the route. Its cost is xAI's own figure (`usage.cost_in_usd_ticks`), or the tokens priced with `engine/models.json` when xAI gives none, and it counts against the same daily and monthly limits as every other call.
- **Fallback**: a provider's rate limit (429), an overload or outage (5xx) or a dropped connection never drops the work. The call waits and is tried again, honoring the provider's `Retry-After`, or else 30 seconds doubling up to 15 minutes. After 3 failures in a row on xAI, Grok calls without search go through OpenRouter (pinned to xAI, the same model id) for 10 minutes, then xAI is tried again. They also go through OpenRouter if the xAI key is unset. Search calls have no fallback; they wait. An outage of 5 failed calls in a row, or 30 minutes, alerts the signers. Each role's `via` in `engine/models.json` declares where its search runs and is checked at boot (an xAI role must run Grok, an OpenRouter role's models need an OpenRouter id, which a Grok role keeps for the fallback).

OpenRouter's model ids are mapped from ours in one place, the `openrouter` table in `engine/models.json` (checked against OpenRouter's public model list on 2026-10-09):

| our id | OpenRouter id |
| --- | --- |
| claude-fable-5-1 | anthropic/claude-fable-5.1 |
| claude-opus-5-5 | anthropic/claude-opus-5.5 |
| claude-sonnet-5-5 | anthropic/claude-sonnet-5.5 |
| claude-haiku-5-5 | anthropic/claude-haiku-5.5 |
| grok-4.7 | x-ai/grok-4.7 |
| grok-4.3 | x-ai/grok-4.3 |

The registry refuses an OpenRouter role whose model or backup has no OpenRouter id, and an X-search role that is not a Grok model. A swap to a model with no OpenRouter id fails its tryout until the id is added.

Post images are made outside the enclave by the studio with OpenAI's image model, called directly by default. OpenRouter lists the same pinned model, so the studio can switch to it (`STUDIO_VIA=openrouter`, pinned to OpenAI); the image check (moderation) stays on OpenAI either way, because OpenRouter has no moderation endpoint.

## The brain

The brain makes one decision per call. It gets the same fixed briefing every time: [`engine/brain/context.md`](../engine/brain/context.md), generated from the contracts' constants, the engine's limits and the rules for builds and swaps. A test fails if that file is out of date. The briefing is cached, so it costs little after the first call.

Every decision is saved as a signed record with the model that made it, the hash of the briefing, the hash of the model list, the hash of the input and the answer. Ideas, specs, test output and pull-request text reach the brain as data to judge, never as instructions. The brain only chooses inside limits that code enforces anyway. The Sequencer and idea loops that will send their decisions to it are being built.

## Swapping a model

1. **Tryout.** The current model and the candidate both answer the role's test set in [`engine/tryout/`](../engine/tryout/): questions with known answers, prompt-injection attempts, and for the brain, builds with a planted bug it must reject. The candidate has to pass every case. With API keys and a database, anyone can rerun it: `node engine/scripts/tryout.ts <role> <model>`.
2. **Public record.** The swap is published as a signed `model-change` record. It takes effect one hour later.
3. **Veto.** During that hour, and after it, two Safe owners can veto the swap by signing it. Pausing the agent on-chain also stops it.
4. **Cost.** If the candidate costs more than 20% above the current model on the test set, the swap also needs two Safe-owner approvals.
5. **Brain.** A brain swap always needs two Safe-owner approvals, on top of the tryout and the hour.
6. **Backup.** The replaced model becomes the role's backup.

Each swap is costed against the model the role runs now, not the one first listed in the file, so a chain of small swaps can't add up to a big unapproved cost rise.

Owners approve or veto by signing (EIP-191) a 32-byte hash of: the action ("dna/approve/v1" or "dna/veto/v1"), the chain id, the Safe's address, the enclave's log-key address, the record's kind and ref, and the hash of the record's exact stored text. A signature can't be reused on another record, chain, Safe or enclave (such as a test copy run against the same Safe), and an approval can't be turned into a veto. The engine checks each signer against the Safe's current owner list on-chain, counts each owner once by the address it recovers from the signature (never by what a stored row claims), and stores at most one signature per owner per record. Signing typed data (EIP-712), so wallets show owners what they sign, is planned with the screens owners will use.

## Spending limits

- Up to $300 a day (the AI dev team builds several things a day: up to 3 at once, 5 a day).
- Up to $3,000 a month.
- Per-job daily limits: research $20, red team $40, everything else $40.

### Daily budget partition

Each day's limit is split in two, so the Sequencer (the AI dev team) and the rest of the engine can't starve each other:

| Day's limit | Sequencer (65%) | Everything else (35%) | One Sequencer order at most |
|---|---|---|---|
| $300 | $195 | $105 | $12 |
| $40 (treasury-scaled) | $26 | $14 | $6.50 |

- A Sequencer order may cost at most $12, and never more than a quarter of the Sequencer's part, so a whole build (the first try and up to three reworks) always fits the day it starts. At a lower limit builds keep running with smaller budgets.
- When a build starts, its whole budget (4 orders, $48) is reserved from the Sequencer's part; what it did not spend is released when it ships, is dropped or is skipped. Four reservations fit the $195 part, so three builds run at once with room for the day's real charges. The 70% alerts are per part and count real charges only, so a reservation alone never alerts.
- Inside the shared part, research stops at 80% of it and everything else at 100%. The per-budget limits (research $20, red team $40, the rest $40) add up to $100, just under the shared $105, so they are what binds.
- A build's reservation, each round's charge and the release are rows of the day the build started: a build still running at midnight never takes from the next day's part. While a build runs its day counts the reservation and the rounds charged so far; once it ends it counts exactly what its rounds cost.
- The monthly limit bounds the total. As the month's spend nears it, work stops in a fixed order: the Sequencer first (at 60% of the month's limit, once the month's total spend reaches $1,800), then research (at 80%, $2,400), then everything else (at 100%, $3,000). A month of full $300 days would be far above it, so the monthly limit is the real ceiling; expected spend is well under it (docs/CAPACITY.md). Keepers never call a model.
- A build round is charged what its run reports (`report.json`, written by the workflow's own code from the model calls; the dev team can't touch it), never more than the order's ceiling, and the whole ceiling when the report is missing. A forged report could only lower a charge, and forging one takes a GitHub compromise. The real backstop for the Sequencer's spend is the hard limit on its own OpenRouter key.
- The engine has a rule to hold the daily limit to a share of what the treasury earns (never above the limits above); it is not switched on yet.
- Each call is checked against these limits before it is made, assuming its most expensive outcome. The provider accounts have their own hard limits as well.
- A call's cost is what its provider reports for it (OpenRouter's `usage.cost`, xAI's `usage.cost_in_usd_ticks`); when it reports none, the engine prices the tokens with `engine/models.json`. OpenRouter charges the providers' own prices with no markup; its fee (5.5% on card purchases, $0.80 minimum; 5% in crypto) is paid when credits are bought, so it is not part of any call's cost.

## The Sequencer's models

The Sequencer (the dev team that builds games in GitHub Actions) runs on the Claude Agent SDK, pointed at OpenRouter's Anthropic-compatible endpoint with its own OpenRouter key (`OPENROUTER_API_KEY_SEQUENCER`, a secret of the build environment only). The SDK reads these variables:

```bash
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY_SEQUENCER"   # sent as Authorization: Bearer
ANTHROPIC_API_KEY=""                                     # must be empty, or the SDK goes to Anthropic directly
```

Its model names are the OpenRouter ids of the `dev-*` roles (for example `anthropic/claude-opus-5.5`). The SDK cannot add OpenRouter's `provider` field to its requests, so the pin is set on OpenRouter's side instead: a guardrail on that key allows Anthropic as the only provider and the `dev-*` models only, with its own spending limit.
