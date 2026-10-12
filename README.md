# DNA

DNA is an ERC-20 on Ethereum with one Uniswap v4 pool. The pool's hook charges a dynamic fee. An AI agent runs inside
an Intel TDX enclave, proposes fee and split modules for that hook, and tests them on live trades. The contracts set the
limits it works in. A 2-of-3 Safe can veto or stop it. Every action is a signed record, and the log heads are anchored
on-chain.

Site: [genomedna.xyz](https://genomedna.xyz). Updates: [x.com/contractdna](https://x.com/contractdna).

> **Status: unaudited.** To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Architecture

```
          ideas, X mentions             models: OpenRouter (Anthropic, xAI); web/X search: xAI
                 │                                │
                 ▼                                ▼
   ┌──────────────────────────── engine (Phala CVM, Intel TDX) ─────────────────────────────┐
   │  indexer → observe → hypothesis → simulate (fork replay) → red team → decide → act     │
   │  keys derived in the TEE: agent (queues ops), anchor (log heads), log (signs records)  │
   └───────┬───────────────────────────────┬───────────────────────────────┬────────────────┘
           │ queue(op) / anchor(head)      │ signed records                │ posts
           ▼                               ▼                               ▼
   ┌──────────────── Ethereum ────────────────┐   Postgres (transport)   X account
   │ ModuleRegistry ── 1 h queue ── Safe veto │          │
   │ DNAHook ─ fee module (Shadow→Canary→Active)          ▼
   │ FeeVault ─ split → BuybackBurn,          │   web (Next.js): /proof, /api/log, live feed
   │   LiquidityVault, treasury, GamePot      │
   └──────────────────────────────────────────┘
```

- **Contracts** hold the rules: a 5% cap on the project fee, a public 1 h queue on every registry op, a canary band, a
  breaker that falls back to the baseline fee, autonomy levels that only the Safe can raise, no mint, and burned launch
  liquidity.
- **Engine** runs the agent loop, the keepers and the indexer. In the enclave build its keys never leave the TEE, and an
  on-chain allow-list of compose hashes pins the code it runs.
- **Web** is the public site: the live feed, the rules, and proof pages anyone can re-check.

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [contracts/SPEC.md](contracts/SPEC.md).

## Verify

You don't have to trust the site. Each check below runs on your own machine against public data and an RPC node you
pick. [docs/VERIFY.md](docs/VERIFY.md) has every step.

`deploy/release.json` is the release record the checks pin. Its digests, compose hash and measurements are filled in
when the enclave release is cut, so the enclave checks work from that release on.

1. **The attested engine.** From `engine/` (after `npm ci`):

   ```bash
   node scripts/verify.ts --attestation <attestationUrl from deploy/release.json> --rpc <your node> --log https://genomedna.xyz
   ```

   It checks the TDX quote against Intel's collateral, compares the measurements with `deploy/release.json`, and
   checks that the attested keys are the ones `registry.agent()` and `anchorKey()` return.
2. **The compose hash.** The enclave's event log must replay to the compose hash in `deploy/release.json`, and that
   compose must pin the released image digest. On-chain, the DstackApp must allow that hash, behind a timelock
   of at least 1 h. You can also rebuild the images yourself and compare digests (VERIFY.md, step 2).
3. **The signed records.** Each log record is hash-chained and signed by the enclave's log key. The last anchored heads
   must be signed by that key, and each queued op's calldata must match its record. `scripts/verify-draw.ts` rebuilds a
   jackpot draw from chain data.

## Repository layout

| Path | What |
|---|---|
| `contracts/` | Solidity 0.8.26 (Foundry): token, hook, registry, vaults, games, modules; tests, fork rehearsals, launch scripts |
| `engine/` | Node 24 TypeScript: agent loop, indexer, keepers, enclave build, verifiers (`scripts/verify*.ts`) |
| `sequencer/` | The Sequencer, which builds new games as pull requests ([docs/sequencer.md](docs/sequencer.md)) |
| `pagecheck/` | Opens game pages in headless Chromium before they ship |
| `deploy/` | Phala CVM compose templates and the release record (`release.json`) |
| `web/` | Next.js site |
| `docs/` | Architecture, verification, security model, operations, capacity |
| `.github/` | CI, the reproducible image build, the Sequencer workflows |

## Build and test

Requirements: [Foundry](https://getfoundry.sh) 1.8+, Node 24 (`.nvmrc`), and Postgres 16 for the database tests only.

```bash
git clone --recursive https://github.com/contractdna/dna && cd dna   # or: git submodule update --init --recursive

# contracts
cd contracts && forge build && forge test            # fork tests skip unless MAINNET_RPC_URL is set

# engine (npm test first fetches and verifies the pinned media, engine/scripts/fetch-media.sh; database tests
# skip unless TEST_DATABASE_URL points at a Postgres you can create databases on)
cd engine && npm ci && npm run check && npm test

# web
cd web && npm ci && npm test && npm run build        # NEXT_PUBLIC_LIVE=1 for the live build
```

CI (`.github/workflows/ci.yml`) runs all of the above, plus the database and end-to-end tests against Postgres and
anvil, and the enclave tests against the dstack simulator. On a pull request each job runs only when its inputs change
(its `changes` job says which); everything runs nightly and on a manual run. `image.yml` builds the engine image twice
and fails unless the digests match.

**Before you push.** Contributors run the tests of each package they changed locally first, batch fixes into one push
(every push to a pull request starts a new run and cancels the old one), and open the pull request as a draft until it
is ready: e2e and pagecheck skip drafts and run once it is marked ready for review.

## Security model

The contracts bound what any key can do. The Safe can cancel any queued op within its hour, pause the agent and lower
its level. The agent key lives only in attested hardware running allow-listed code. You still trust Intel TDX, the
Phala platform and the Safe signers. Details, and what is *not* claimed: [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

## License

[MIT](LICENSE). Vendored code keeps its own license (`contracts/script/programmable/`, git submodules under `contracts/lib/`).
