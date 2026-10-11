# Security model

## What protects holders

The contracts, not the agent. These hold whatever any key does:

- Project fee ≤ 5% on every swap; a canary fee within ±1 point of the active fee; any module failure falls back to the
  baseline fee in the same swap; 3 failures in 300 blocks let anyone roll the route back.
- Every registry op waits ≥ 1 h in a public queue. The agent can only use ops its autonomy level allows; levels go up
  only through the Safe (queued, and not within 5 days of a rollback) and down instantly.
- New module bytecode can be registered only if the Safe approved its code hash.
- No mint function; launch liquidity is owned by `0xdEaD`; `LiquidityVault` cannot withdraw; fee splits stay inside
  fixed bounds.

## Roles

| Role | Can | Cannot |
|---|---|---|
| Safe (2-of-3) | cancel any queued op within its hour, pause the agent, lower its level, approve code hashes, veto a posted jackpot list, propose compose-hash changes to the timelock | change any constant, mint, move user funds |
| Agent key (TEE only) | queue ops allowed at its level, post jackpot lists | skip the queue, exceed any bound, raise its own level |
| Anchor key (TEE only) | emit `Anchored(head, uri)` | anything with funds or modules |
| Keeper key | execute due ops, call permissionless maintenance | propose anything |
| Safe owner (one signature) | approve a draft: a post's exact text (it gates a post, not a fund move) | approve a different draft with the same signature |
| Operator channel (Telegram) | the brakes: halt the engine, hold it in dry run, mute posting, delete one of the account's own posts, reject a draft | make the agent act, post anything, delete anyone else's post, or approve anything: drafts and delayed records need Safe owner signatures |
| Anyone | execute due ops, roll back a tripped breaker, run every verifier | — |

## The enclave

The agent, anchor, log and funder keys are derived inside an Intel TDX CVM on Phala and released only to code whose
compose hash is on the on-chain DstackApp allow-list (the first hash is set when the app is created; changes wait 1 h
in public). The funder key may only queue a game's funding through Roles into the Delay; its address is bound in every
attestation like the others'. The image is reproducible and pinned by digest in that compose. The env lockdown refuses
unknown variables, so behaviour cannot be changed through configuration. The database is untrusted transport: the enclave keeps its own signed chain and refuses a database that rolled its head back.

The persona (the brain's values and the writer's voice) is the one private input that shapes what the agent says and
prefers. It arrives as `DNA_PERSONA`, an allowed env encrypted to the CVM, and the enclave refuses to start without
it. Its text is not published; its sha256 is in every brain decision record, every self-file record and on /proof,
so a changed persona is visible in public. It never widens what the agent can do: every limit is in code and contracts.

## Untrusted input

X mentions, ideas and web content are read by a quarantined model call whose output is schema-checked data; they never
reach a prompt as instructions. Facts on generated images are drawn by the enclave, not the image model.

## What is not claimed

- That a given text came from a particular model: providers do not sign responses.
- That no human influences the agent: prompts, parameters and data feeds are human-chosen; the public submits ideas.
- "Trustless": trust remains in Intel TDX, in Phala's platform governance and in the Safe signers.

## Status

Unaudited. Reviewed internally and with AI review; static analysis triage in `contracts/audit/slither.md`.
Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).
