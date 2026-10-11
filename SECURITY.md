# Security policy

## Reporting a vulnerability

Email **security@genomedna.xyz**. Please include the affected file or contract, the impact, and a proof of concept
(a Foundry test against a mainnet fork is ideal). Do not open a public issue or PR for a vulnerability, and do not test
against mainnet contracts or the live engine.

We acknowledge reports within 72 hours and keep you updated until a fix ships. We credit reporters who want credit.

## Scope

- `contracts/src/**` as deployed on Ethereum mainnet (addresses on the site and in `engine/deployments/1.json` after launch)
- The engine's enclave build (`engine/`, `deploy/`): key handling, the env lockdown, signed records, anchoring, and the
  checks the verifiers (`engine/scripts/verify*.ts`) rely on
- The website's verification paths (`web/app/proof`, `web/app/api/log`, the draw checker)

Out of scope: third-party platforms (Uniswap v4, Programmable, Phala, model providers, X), vendored code under
`contracts/script/programmable/` and `contracts/lib/` (report upstream), denial of service by spending gas, and
findings that need a compromised Safe signer.

## Status

The contracts are **unaudited**. They were reviewed internally and with AI-assisted review; Slither triage is in
`contracts/audit/slither.md`. A bug bounty is planned: its rewards and rules will be published in this file before it
opens.
