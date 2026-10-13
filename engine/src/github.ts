// The enclave's GitHub client (REST, plain fetch). Everything GitHub says is data: file contents are checked against
// their git object hash, a pull request's head is re-read before acting, merges are pinned to the gated sha and
// `release` only ever moves forward (force: false). The host is a code literal; GITHUB_API_BASE exists for the tests'
// fake only (the enclave's env lockdown refuses any *_API_BASE). The token (GITHUB_TOKEN) is the enclave's
// fine-grained token for one repository (GITHUB_REPO); GitHub reports its expiry on every answer, and the enclave
// alerts 14 days before it.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export const GH = {
  api: process.env.GITHUB_API_BASE ?? "https://api.github.com",
  repo: process.env.GITHUB_REPO ?? "",
  token: () => process.env.GITHUB_TOKEN ?? "",
  /** the Sequencer's workflow file (its runs are named `seq order:<id>`) */
  workflow: "sequencer.yml",
  /** the token's expiry as GitHub last reported it (header github-authentication-token-expiration), ms */
  tokenExpiresAt: undefined as number | undefined,
};

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
/** An outage (network, 5xx, rate limit, a 403 that is GitHub's secondary rate limit): the build is skipped, not killed. */
export const outage = (e: unknown) => e instanceof GitHubError && (e.status === 0 || e.status === 429 || e.status >= 500 || (e.status === 403 && /rate limit/i.test(e.message)));

/** The most a download (an artifact zip) may be: a build's artifacts are a few hundred KB. */
export const MAX_DOWNLOAD = 50 * 1024 ** 2;
/** A response body, refused past `max` bytes (by its Content-Length, and counted while it streams). */
export async function capped(r: Response, max: number): Promise<Buffer> {
  if (Number(r.headers.get("content-length") ?? 0) > max) throw new Error(`download over ${max} bytes: refused`);
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of r.body ?? []) {
    n += (c as Uint8Array).length;
    if (n > max) throw new Error(`download over ${max} bytes: refused`);
    parts.push(Buffer.from(c as Uint8Array));
  }
  return Buffer.concat(parts);
}

/** One REST call. `raw`: return the bytes (archives). Any non-2xx throws GitHubError (0 = network). */
export async function gh<T = unknown>(method: string, path: string, body?: unknown, o: { raw?: boolean } = {}): Promise<T> {
  if (!GH.repo || !GH.token()) throw new GitHubError(0, "GitHub is not configured (GITHUB_REPO, GITHUB_TOKEN)");
  let r: Response;
  try {
    r = await fetch(`${GH.api}${path.replace("{repo}", GH.repo)}`, {
      method, redirect: "follow", signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${GH.token()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new GitHubError(0, `GitHub ${method} ${path}: ${(e as Error).message}`);
  }
  const exp = r.headers.get("github-authentication-token-expiration");
  if (exp) GH.tokenExpiresAt = expiryOf(exp);
  if (!r.ok) throw new GitHubError(r.status, `GitHub ${method} ${path}: ${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`);
  if (o.raw) return (await capped(r, MAX_DOWNLOAD)) as T;
  const t = await r.text();
  return (t ? JSON.parse(t) : {}) as T;
}

/** The expiry header ("2026-12-01 10:00:00 UTC" or "… -0800") in ms; NaN when unreadable. */
export const expiryOf = (h: string) => Date.parse(h.trim().replace(/^(\S+) (\S+) (UTC|[+-]\d{2})(\d{2})?$/, (_, d, t, z, m) => `${d}T${t}${z === "UTC" ? "Z" : `${z}:${m ?? "00"}`}`));
/** Days until the token expires (undefined: GitHub never said; a token without expiry sends no header). */
export const tokenDaysLeft = (now: number) => (GH.tokenExpiresAt === undefined || !Number.isFinite(GH.tokenExpiresAt) ? undefined : (GH.tokenExpiresAt - now) / 86_400_000);

/** git's object id of a blob: sha1("blob <size>\0" + bytes). */
export const blobSha = (b: Buffer) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");

/** A blob's bytes, refused unless they hash to `sha`. */
export async function blob(sha: string): Promise<Buffer> {
  const r = await gh<{ content: string; encoding: string }>("GET", `/repos/{repo}/git/blobs/${sha}`);
  const b = Buffer.from(r.content ?? "", r.encoding === "base64" ? "base64" : "utf8");
  if (blobSha(b) !== sha) throw new Error(`blob ${sha}: the content GitHub returned does not hash to it`);
  return b;
}

/** Start a build: the signed order record as the dispatch payload. */
export const dispatch = (record: unknown) => gh("POST", "/repos/{repo}/dispatches", { event_type: "sequencer-build", client_payload: record });

export type Run = { id: number; display_title: string; status: string; conclusion: string | null; run_attempt: number; created_at: string; event: string };
/** The workflow runs for an order (run-name `seq order:<id>`), oldest first. */
export async function runsFor(orderRef: string): Promise<Run[]> {
  const r = await gh<{ workflow_runs: Run[] }>("GET", `/repos/{repo}/actions/workflows/${GH.workflow}/runs?event=repository_dispatch&per_page=100`);
  return (r.workflow_runs ?? []).filter((x) => x.display_title === `seq ${orderRef}`).sort((a, b) => a.id - b.id);
}
/** A run as GitHub has it now (its attempt counter included). */
export const runOf = (id: number) => gh<Run>("GET", `/repos/{repo}/actions/runs/${id}`);

/** Every file of a run's artifact (a zip). null when there is no such artifact. */
export async function artifactFiles(runId: number, artifact: string): Promise<Record<string, Buffer> | null> {
  const list = await gh<{ artifacts: { name: string; archive_download_url: string; expired: boolean }[] }>("GET", `/repos/{repo}/actions/runs/${runId}/artifacts`);
  const a = list.artifacts?.find((x) => x.name === artifact && !x.expired);
  if (!a) return null;
  return unzip(await gh<Buffer>("GET", new URL(a.archive_download_url).pathname, undefined, { raw: true }));
}
/** A file out of a run's artifact: report.json, plan.json. null when absent. */
export const artifactFile = async (runId: number, artifact: string, file: string) => (await artifactFiles(runId, artifact))?.[file] ?? null;

/** Slither's findings in one report (slither-<contract>.json), short: only those in the build's own folder. Slither reads
 *  the shared kit (contracts/src/games/GameKit.sol) through every game, and the build can't change it. */
export function slitherFindings(report: string): { check: string; impact: string; text: string }[] {
  try {
    const j = JSON.parse(report) as { results?: { detectors?: { check?: string; impact?: string; description?: string; elements?: { source_mapping?: { filename_relative?: string } }[] }[] } };
    const own = (x: { description?: string; elements?: { source_mapping?: { filename_relative?: string } }[] }) =>
      [...(x.elements ?? []).map((e) => e.source_mapping?.filename_relative ?? ""), x.description ?? ""].some((t) => /src\/games\/[^/#()\s]+\/[^/#()\s]+\.sol/.test(t));
    return (j.results?.detectors ?? []).filter(own).map((x) => ({ check: String(x.check ?? "").slice(0, 60), impact: String(x.impact ?? "").slice(0, 20), text: String(x.description ?? "").slice(0, 200) }));
  } catch {
    return []; // not JSON: nothing to pass on
  }
}

/** CI's advisory gate run on a commit (sequencer-gates.yml, the build's own: the repository's general CI is not asked):
 *  its conclusion and Slither's findings in the build's folder, short. DATA for the brain; the enclave's own gates decide
 *  (M3). null when CI has not run. */
export async function ciAdvice(sha: string) {
  const r = await gh<{ workflow_runs: Run[] }>("GET", `/repos/{repo}/actions/workflows/sequencer-gates.yml/runs?head_sha=${sha}&per_page=5`);
  const run = (r.workflow_runs ?? []).sort((a, b) => b.id - a.id)[0];
  if (!run) return null;
  const files = run.status === "completed" ? await artifactFiles(run.id, "sequencer-gates").catch(() => null) : null;
  const findings = Object.entries(files ?? {}).filter(([name]) => /^slither-.*\.json$/.test(name)).flatMap(([, b]) => slitherFindings(b.toString("utf8")));
  return { status: run.status, conclusion: run.conclusion, slither: findings.slice(0, 20) };
}

/** A minimal zip reader (stored and deflated entries; what Actions artifacts use), each entry at most 16 MB. */
export function unzip(z: Buffer): Record<string, Buffer> {
  let eocd = -1;
  for (let i = z.length - 22; i >= Math.max(0, z.length - 65_557); i--) if (z.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip");
  const count = z.readUInt16LE(eocd + 10);
  let p = z.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  for (let n = 0; n < count; n++) {
    if (z.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip directory");
    const method = z.readUInt16LE(p + 10), size = z.readUInt32LE(p + 20), nameLen = z.readUInt16LE(p + 28), extraLen = z.readUInt16LE(p + 30), commentLen = z.readUInt16LE(p + 32), local = z.readUInt32LE(p + 42);
    const name = z.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = local + 30 + z.readUInt16LE(local + 26) + z.readUInt16LE(local + 28);
    const data = z.subarray(start, start + size);
    if (method === 0) out[name] = Buffer.from(data);
    else if (method === 8) out[name] = inflateRawSync(data, { maxOutputLength: 16 * 1024 ** 2 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export type Pull = { number: number; state: string; user: { login: string }; head: { ref: string; sha: string; repo: { full_name: string } | null }; base: { ref: string; repo: { full_name: string } }; body: string | null; merged: boolean; merge_commit_sha: string | null };
/** The pull request (any state) whose head is this branch of this repository, if any. */
export async function pullOn(branch: string): Promise<Pull | null> {
  const owner = GH.repo.split("/")[0];
  const r = await gh<Pull[]>("GET", `/repos/{repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  return r.find((p) => p.head.ref === branch && p.head.repo?.full_name === GH.repo) ?? null;
}
export const pull = (n: number) => gh<Pull>("GET", `/repos/{repo}/pulls/${n}`);
export type Commit = { sha: string; parents: { sha: string }[]; author: { login: string } | null; committer: { login: string } | null; commit: { tree: { sha: string }; verification?: { verified: boolean } } };
export const pullCommits = (n: number) => gh<Commit[]>("GET", `/repos/{repo}/pulls/${n}/commits?per_page=100`);
export const commit = (sha: string) => gh<Commit>("GET", `/repos/{repo}/commits/${sha}`);

export type Entry = { path: string; mode: string; type: string; sha: string; size?: number };
/** Every entry of a commit's tree (recursive), by path. A truncated tree is refused. */
export async function treeOf(commitSha: string): Promise<Map<string, Entry>> {
  const c = await commit(commitSha);
  const t = await gh<{ tree: Entry[]; truncated: boolean }>("GET", `/repos/{repo}/git/trees/${c.commit.tree.sha}?recursive=1`);
  if (t.truncated) throw new Error(`the tree of ${commitSha} is truncated: refused`);
  return new Map(t.tree.filter((e) => e.type !== "tree").map((e) => [e.path, e]));
}

export type Change = { path: string; status: "A" | "M" | "D" | "T"; mode: string; size: number; binary?: boolean };
/** What `head` changed against `base`, from both trees (not GitHub's compare list): each path added, modified (blob or
 *  mode), removed or retyped, and the text of every changed file (blob-verified; binaries and files over 100 KB are
 *  listed without text, so G1 refuses them). */
export async function changedFiles(base: string, head: string) {
  const [a, b] = await Promise.all([treeOf(base), treeOf(head)]);
  const changes: Change[] = [];
  const texts: Record<string, string> = {};
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(path), y = b.get(path);
    if (x && y && x.sha === y.sha && x.mode === y.mode) continue;
    if (!y) { changes.push({ path, status: "D", mode: "000000", size: 0 }); continue; }
    const c: Change = { path, status: !x ? "A" : x.type !== y.type || (x.mode === "120000") !== (y.mode === "120000") ? "T" : "M", mode: y.mode, size: y.size ?? 0 };
    if (y.type === "blob" && y.mode !== "120000" && (y.size ?? 0) <= 100_000) {
      const bytes = await blob(y.sha);
      c.size = bytes.length;
      c.binary = bytes.includes(0);
      if (!c.binary) texts[path] = bytes.toString("utf8");
    }
    changes.push(c);
  }
  return { changes, texts };
}

/** The blob of each path under `prefixes` in a tree (a prefix ending in "/" is a folder, any other one file): what a
 *  game's folders or a site change's files hold (the merge must keep it exactly). */
export const treeHashes = (t: Map<string, Entry>, prefixes: string[]) =>
  Object.fromEntries([...t].filter(([p]) => prefixes.some((x) => (x.endsWith("/") ? p.startsWith(x) : p === x))).map(([p, e]) => [p, `${e.mode}:${e.sha}`]).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Does any path under `prefix` exist in this tree? */
export const hasPrefix = (t: Map<string, Entry>, prefix: string) => [...t.keys()].some((p) => p.startsWith(prefix));

/** The commits `head` has that `base` does not (GitHub's compare lists at most 250: `complete` false past that). */
export async function commitsBetween(base: string, head: string): Promise<{ shas: string[]; complete: boolean }> {
  const c = await gh<{ commits?: { sha: string }[]; total_commits?: number }>("GET", `/repos/{repo}/compare/${base}...${head}`);
  const shas = (c.commits ?? []).map((x) => x.sha);
  return { shas, complete: (c.total_commits ?? 0) <= shas.length };
}
/** Does `head` hold `sha` (the same commit, or one after it)? A commit GitHub does not know holds nothing. */
export async function contains(head: string, sha: string): Promise<boolean> {
  if (head === sha) return true;
  try {
    return ["ahead", "identical"].includes((await gh<{ status?: string }>("GET", `/repos/{repo}/compare/${sha}...${head}`)).status ?? "");
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return false;
    throw e;
  }
}
/** A branch's head sha. */
export const refSha = async (branch: string) => (await gh<{ object: { sha: string } }>("GET", `/repos/{repo}/git/ref/heads/${branch}`)).object.sha;
/** Move `release` forward to `sha`: never a force push (GitHub refuses a non-fast-forward). */
export const fastForward = (branch: string, sha: string) => gh("PATCH", `/repos/{repo}/git/refs/heads/${branch}`, { sha, force: false });
/** Squash-merge a pull request only if its head is still `sha` (GitHub refuses with 409 otherwise). The merge commit. */
export async function merge(n: number, sha: string): Promise<string> {
  const r = await gh<{ sha: string; merged: boolean }>("PUT", `/repos/{repo}/pulls/${n}/merge`, { sha, merge_method: "squash" });
  if (!r.merged || !/^[0-9a-f]{40}$/.test(r.sha ?? "")) throw new Error(`pull ${n}: not merged`);
  return r.sha;
}

export const setStatus = (sha: string, state: "pending" | "success" | "failure", description: string) =>
  gh("POST", `/repos/{repo}/statuses/${sha}`, { state, context: "dna/enclave-gates", description: description.slice(0, 140) });
export const closePull = async (n: number, comment: string) => {
  await gh("POST", `/repos/{repo}/issues/${n}/comments`, { body: comment });
  await gh("PATCH", `/repos/{repo}/pulls/${n}`, { state: "closed" });
};
