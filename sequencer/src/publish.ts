// The workflow's last job: turn the build's patch into exactly one commit by the Sequencer's GitHub App, on the order's
// branch, and open the pull request. Nothing from the patch runs here: it is applied to a checkout of the order's base
// as data, checked again (paths: G1; PR text and key-shaped strings: G12), then sent through the REST API, which is
// how GitHub signs an App's commit (verified). The engine closes the previous round's pull request (next()).
//   node sequencer/src/publish.ts --order <order.json> --patch <patch.diff> --body <pr.md> --title <title> [--root <checkout>]
// Env: GITHUB_REPOSITORY (owner/name), SEQ_APP_ID, SEQ_APP_KEY (the App's private key, PEM or base64 of the PEM).
import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Change, parseRaw, pathGate, roots, textGate } from "../../engine/src/seq-gates.ts";
import { kindOf, Order } from "../../engine/src/seq-order.ts";
import { firstAttemptOnly, loopbackOr, TITLE } from "./ci.ts";

const API = loopbackOr(process.env.SEQ_GITHUB_API, "https://api.github.com");
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A 9-minute App JWT (RS256). */
export function appJwt(appId: string, pem: string, nowS = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: nowS - 60, exp: nowS + 540, iss: appId }));
  // the key as PEM, or that PEM base64'd (a secret pasted as one line)
  const key = pem.includes("-----BEGIN") ? pem : Buffer.from(pem.trim(), "base64").toString("utf8");
  if (!key.includes("-----BEGIN")) throw new Error("SEQ_APP_KEY is neither a PEM nor base64 of one");
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key);
  return `${head}.${body}.${b64url(sig)}`;
}

export async function gh<T = Record<string, unknown>>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`GitHub ${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** The patch applied to the base checkout, as the gates see it: changes and file texts. */
export function applied(root: string, patch: string) {
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { maxBuffer: 64 * 1024 ** 2, input: a[0] === "apply" ? patch : undefined });
  git("apply", "--index", "--whitespace=nowarn", "-");
  const changes = parseRaw(git("diff", "--raw", "-z", "--no-abbrev", "-M", "--cached", "HEAD").toString("utf8"));
  const files: Record<string, string> = {};
  for (const c of changes) {
    if (c.status === "D" || c.mode === "160000") continue;
    const blob = git("cat-file", "blob", c.sha);
    c.size = blob.length;
    c.binary = blob.includes(0);
    if (!c.binary) files[c.path] = blob.toString("utf8");
  }
  return { changes, files };
}

export type Published = { pr: number; sha: string; branch: string };
export async function publish(o: Order, patch: string, body: string, title: string, root: string, repo: string, token: string): Promise<Published> {
  const { changes, files } = applied(root, patch);
  const kind = kindOf(o);
  const baseHas = (kind === "game" || kind === "module") && roots(o.slug, kind).some((r) => { try { execFileSync("git", ["-C", root, "cat-file", "-e", `${o.baseSha}:${r.slice(0, -1)}`]); return true; } catch { return false; } });
  const issues = [...pathGate(changes as Change[], o.slug, baseHas, kind, { paths: kind === "site" ? execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", o.baseSha]).toString().split("\n").filter(Boolean) : [] }).issues, ...textGate(body, files).issues, ...(TITLE.test(title) ? textGate(title, {}).issues : ["the title is not one plain line"]).map((i) => `title: ${i}`)];
  if (issues.length) throw new Error(`refused before publishing:\n${issues.join("\n")}`);
  const base = await gh<{ tree: { sha: string } }>(token, "GET", `/repos/${repo}/git/commits/${o.baseSha}`);
  const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const [path, text] of Object.entries(files).sort()) {
    const blob = await gh<{ sha: string }>(token, "POST", `/repos/${repo}/git/blobs`, { content: Buffer.from(text).toString("base64"), encoding: "base64" });
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const t = await gh<{ sha: string }>(token, "POST", `/repos/${repo}/git/trees`, { base_tree: base.tree.sha, tree });
  // no author or committer: GitHub signs a commit an App makes through the API
  const c = await gh<{ sha: string }>(token, "POST", `/repos/${repo}/git/commits`, { message: `Sequencer: ${title}\n\nOrder ${o.id}, round ${o.round}.`, tree: t.sha, parents: [o.baseSha] });
  const branch = `seq/${o.id}-r${o.round}`;
  await gh(token, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: c.sha });
  const pr = await gh<{ number: number }>(token, "POST", `/repos/${repo}/pulls`, { title: `Sequencer: ${title}`.slice(0, 120), head: branch, base: "main", body, maintainer_can_modify: false });
  return { pr: pr.number, sha: c.sha, branch };
}

/** An installation token for this repo only, with contents and pull requests write. */
export async function appToken(repo: string, appId: string, pem: string) {
  const jwt = appJwt(appId, pem);
  const inst = await gh<{ id: number }>(jwt, "GET", `/repos/${repo}/installation`);
  const name = repo.split("/")[1];
  return (await gh<{ token: string }>(jwt, "POST", `/app/installations/${inst.id}/access_tokens`, { repositories: [name], permissions: { contents: "write", pull_requests: "write" } })).token;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { values: a } = parseArgs({ options: { order: { type: "string" }, patch: { type: "string" }, body: { type: "string" }, title: { type: "string" }, root: { type: "string" } } });
  if (!a.order || !a.patch || !a.body || !a.title) throw new Error("usage: publish.ts --order --patch --body --title [--root]");
  firstAttemptOnly();
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !process.env.SEQ_APP_ID || !process.env.SEQ_APP_KEY) throw new Error("GITHUB_REPOSITORY, SEQ_APP_ID and SEQ_APP_KEY are required");
  const o = Order.parse(JSON.parse(readFileSync(a.order, "utf8")));
  const token = await appToken(repo, process.env.SEQ_APP_ID, process.env.SEQ_APP_KEY);
  const p = await publish(o, readFileSync(a.patch, "utf8"), readFileSync(a.body, "utf8").trim(), a.title, a.root ?? process.cwd(), repo, token);
  console.log(`opened #${p.pr} on ${p.branch} (${p.sha})`);
}
