# DNA website

The public site for DNA (genomedna.xyz), built with Next.js 16 (App Router) and React 19.

Pages (one folder each in `app/`): the home journey, how-it-works, docs, rules, constitution, autonomy, modules,
evolution, lab, mind, memory, journal, live, proof, treasury, play (jackpot draws and their in-browser check),
proposals (idea market), bounties, xp, security and announcements. `app/api/` serves read-only JSON (`/api/<name>`),
`/api/health` and the SSE live feed (`/api/stream`).

## Run

Node 24.

```bash
npm ci
npm run dev                      # http://localhost:3000, sample data
npm test                         # unit tests (node:test)
npm run build                    # pre-launch build: sample data, no database
NEXT_PUBLIC_LIVE=1 npm run build # live build: pages read Postgres
```

## Environment

| name | meaning |
| --- | --- |
| `NEXT_PUBLIC_LIVE` | `1` switches every page from sample data to live data. Build time. |
| `NEXT_PUBLIC_SITE_URL` | Canonical site URL for metadata (default `https://genomedna.xyz`). Build time. |
| `NEXT_PUBLIC_RPC_URL` | Ethereum RPC the browser uses for the proof and draw checks and the /trade quotes, allowances and receipts (default a public endpoint). Build time, so it ships in the page: the LIVE build uses our own provider here, a key restricted to the site's origin, never a server key. |
| `DATABASE_URL` | Postgres connection string for the live build (a read-only role is enough). |
| `SSE_GLOBAL_MAX` | Max open `/api/stream` connections per instance (default 6000). |
| `SSE_PER_IP_MAX` | Max open `/api/stream` connections per client IP (default 20). |
| `SSE_IP_HEADER` | CDN client-IP header to trust (for example `cf-connecting-ip`), honoured only from Cloudflare's ranges. |
| `SITE_MAINTENANCE` | `1` serves a static 503 "back shortly" page for every request except `/token.png` and `/api/log/*` (security.ts `staysUp`); `/api/health` answers 200 `{"ok":true}`; `/icon.png`, `/apple-icon.png` and `/_next/static` never reach the proxy. Run time: change it and restart, no rebuild. |

## Data

With `NEXT_PUBLIC_LIVE` unset, pages render the sample data in `app/_data/mock.ts`. In the live build, `app/_data/live.ts`
reads the Postgres database the engine writes (the indexer's chain events and the engine's hash-chained log), and
`/api/stream` pushes new feed rows to browsers over Server-Sent Events from one Postgres `LISTEN` per instance.
`app/_data/source.ts` is the single switch between the two.

## Changelog

`app/_data/changes.json` is the site's public changelog, newest first, served at `/api/changes` (open CORS, cached
60 s); the engine posts about each new entry. **Every site PR adds an entry**:
`{ "id": "<YYYY-MM-DD>-<slug>", "at": "<ISO time>", "title": "<≤ 60 chars>", "summary": "<≤ 200 chars, plain present tense>", "url": "/<page most affected>" }`.
`test/changes.test.mjs` checks the shape.

Load-test scripts and their method: `scripts/loadtest/` and `../docs/CAPACITY.md`.
