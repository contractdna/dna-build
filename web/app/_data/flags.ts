// NEXT_PUBLIC_LIVE=1 at build time: chain-backed data from Postgres (server) and /api/stream (client).
// Unset (default): the pre-launch site on sample data, exactly as before. Client-safe (no server imports).
export const LIVE = process.env.NEXT_PUBLIC_LIVE === "1";

// The public site origin (canonical URLs, metadata, footer). NEXT_PUBLIC_SITE_URL overrides it (e.g. a staging host).
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://genomedna.xyz";
export const SITE_HOST = new URL(SITE_URL).host;

// ---- PUBLIC SOURCE: the one place the site's source links come from (/docs builds every file link from it) ----
// The deployed contracts' public repo and the commit Etherscan verifies. LIVE only: before launch the pages name each
// file and say the source comes at launch. Only ever the project's own org.
export const SOURCE_REPO = LIVE ? "https://github.com/contractdna/dna-contracts" : null;
export const SOURCE_COMMIT = "bc96d653421bf414e6849e20d4697306269e659a";
// The running engine's public source (engine/, contracts/SPEC.md, docs/) and the commit its enclave image is built from
// (the same commit /proof pins). LIVE only, like SOURCE_REPO.
export const ENGINE_REPO = LIVE ? "https://github.com/contractdna/dna-build" : null;
export const ENGINE_COMMIT = "947a6fed19c115e9bfee7af6c4d8e10415b2ef72";
