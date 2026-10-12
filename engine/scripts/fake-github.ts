// A local fake of the GitHub REST endpoints the Sequencer uses (src/github.ts): blobs, trees and commits (an in-memory
// object store: blob ids are real git blob ids, so the client's sha1 check runs for real), refs (fast-forward only
// unless force), repository_dispatch, workflow runs with their artifacts (zips), pull requests (commits, squash merge
// pinned to a head sha), commit statuses and comments. Tests drive it through the helpers (commitFiles, openPull,
// addRun) and the knobs (tamper a blob, fail a path, token expiry header). Every request is recorded in `calls`.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32 } from "node:zlib";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type File = { mode: string; sha: string };
type CommitObj = { tree: string; parents: string[]; author: string; committer: string; verified: boolean };
export type FakePull = { number: number; state: "open" | "closed"; author: string; branch: string; headRepo: string; base: string; baseSha: string; body: string; merged: boolean; merge_commit_sha: string | null };
export type FakeRun = { id: number; display_title: string; status: string; conclusion: string | null; run_attempt: number; created_at: string; event: string; workflow: string; head_sha: string; artifacts: Record<string, Record<string, Buffer>> };

const sha1 = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");
export const gitBlobSha = (b: Buffer) => sha1(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));

/** A zip of stored (uncompressed) entries, as an Actions artifact download. */
export function zip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const dir: Buffer[] = [];
  let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, n, data);
    dir.push(c, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(dir);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

export async function startFakeGitHub(o: { repo?: string; bot?: string } = {}) {
  const repo = o.repo ?? "dna/game-lab";
  const bot = o.bot ?? "dna-sequencer[bot]";
  const calls: { method: string; path: string; body: Json }[] = [];
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Record<string, File>>();
  const commits = new Map<string, CommitObj>();
  const refs = new Map<string, string>();
  const pulls: FakePull[] = [];
  const runs: FakeRun[] = [];
  const dispatches: Json[] = [];
  const statuses: { sha: string; state: string; context: string; description: string }[] = [];
  const comments: { n: number; body: string }[] = [];
  const knobs = {
    tokenExpiry: null as string | null, // header github-authentication-token-expiration
    tamper: new Set<string>(), // blob ids answered with other bytes
    fail: null as { status: number; path: RegExp } | null, // answer matching paths with this status
    mergeEdits: null as Record<string, string> | null, // a squash merge that changes these files (a planted mismatch)
    treeEdits: null as Record<string, string> | null, // a created tree that also holds these files (a planted mismatch)
  };

  const putTree = (files: Record<string, File>) => {
    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
    const id = sha1(`tree ${JSON.stringify(sorted)}`);
    trees.set(id, sorted);
    return id;
  };
  const putBlob = (text: string | Buffer) => {
    const b = Buffer.isBuffer(text) ? text : Buffer.from(text);
    const id = gitBlobSha(b);
    blobs.set(id, b);
    return id;
  };
  const putCommit = (c: CommitObj) => {
    const id = sha1(`commit ${JSON.stringify(c)} ${commits.size}`);
    commits.set(id, c);
    return id;
  };
  const filesOf = (commit: string) => trees.get(commits.get(commit)!.tree)!;
  const ancestors = (sha: string) => {
    const out = new Set<string>();
    const todo = [sha];
    while (todo.length) { const s = todo.pop()!; if (out.has(s)) continue; out.add(s); todo.push(...(commits.get(s)?.parents ?? [])); }
    return out;
  };

  /** What GitHub records for a commit an App makes through the API: authored by the App, committed by GitHub, signed. */
  const byBot = { author: bot, committer: "web-flow", verified: true };
  /** A commit on top of `parent` (or a root) setting these files (a string = a regular file; null = delete). */
  function commitFiles(parent: string | null, files: Record<string, string | { text: string; mode: string } | null>, who = { author: "maintainer", committer: "maintainer", verified: true }) {
    const base = parent ? { ...filesOf(parent) } : {};
    for (const [p, v] of Object.entries(files)) {
      if (v === null) delete base[p];
      else base[p] = typeof v === "string" ? { mode: "100644", sha: putBlob(v) } : { mode: v.mode, sha: putBlob(v.text) };
    }
    return putCommit({ tree: putTree(base), parents: parent ? [parent] : [], ...who });
  }
  /** The bot's pull request from `branch` (head `head`) into main at `baseSha`. */
  function openPull(branch: string, head: string, baseSha: string, p: Partial<FakePull> = {}) {
    refs.set(branch, head);
    const pr: FakePull = { number: 100 + pulls.length, state: "open", author: bot, branch, headRepo: repo, base: "main", baseSha, body: "A small game.", merged: false, merge_commit_sha: null, ...p };
    pulls.push(pr);
    return pr;
  }
  function addRun(title: string, r: Partial<FakeRun> = {}) {
    const run: FakeRun = { id: 9000 + runs.length, display_title: title, status: "completed", conclusion: "success", run_attempt: 1, created_at: new Date().toISOString(), event: "repository_dispatch", workflow: "sequencer.yml", head_sha: "", artifacts: {}, ...r };
    runs.push(run);
    return run;
  }

  const pullJson = (p: FakePull) => ({
    number: p.number, state: p.state, user: { login: p.author }, body: p.body, merged: p.merged, merge_commit_sha: p.merge_commit_sha,
    head: { ref: p.branch, sha: refs.get(p.branch), repo: { full_name: p.headRepo } }, base: { ref: p.base, repo: { full_name: repo } },
  });
  const commitJson = (sha: string) => {
    const c = commits.get(sha)!;
    return { sha, parents: c.parents.map((s) => ({ sha: s })), author: { login: c.author }, committer: { login: c.committer }, commit: { tree: { sha: c.tree }, verification: { verified: c.verified } } };
  };

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Json = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    const method = req.method ?? "GET";
    calls.push({ method, path: `${path}${url.search}`, body });
    const headers: Record<string, string> = { "content-type": "application/json", ...(knobs.tokenExpiry ? { "github-authentication-token-expiration": knobs.tokenExpiry } : {}) };
    const send = (status: number, j?: Json) => res.writeHead(status, headers).end(j === undefined ? "" : JSON.stringify(j));
    if (knobs.fail && knobs.fail.path.test(path)) return send(knobs.fail.status, { message: "fake failure" });
    if (req.headers.authorization !== "Bearer fake-token") return send(401, { message: "Bad credentials" });
    const zipm = path.match(/^\/zip\/(\d+)\/([\w.-]+)$/);
    if (zipm) {
      const run = runs.find((r) => r.id === Number(zipm[1]));
      const files = run?.artifacts[zipm[2]];
      if (!files) return send(404, { message: "Not Found" });
      return res.writeHead(200, { "content-type": "application/zip" }).end(zip(files));
    }
    const pre = `/repos/${repo}`;
    if (!path.startsWith(pre)) return send(404, { message: "Not Found" });
    const p = path.slice(pre.length);
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/git\/blobs\/([0-9a-f]{40})$/))) {
      const b = blobs.get(m[1]);
      if (!b) return send(404, { message: "Not Found" });
      return send(200, { sha: m[1], encoding: "base64", content: (knobs.tamper.has(m[1]) ? Buffer.concat([b, Buffer.from(" ")]) : b).toString("base64") });
    }
    if ((m = p.match(/^\/commits\/([0-9a-f]{40})$/))) return commits.has(m[1]) ? send(200, commitJson(m[1])) : send(404, { message: "Not Found" });
    if ((m = p.match(/^\/git\/trees\/([0-9a-f]{40})$/))) {
      const t = trees.get(m[1]);
      if (!t) return send(404, { message: "Not Found" });
      return send(200, { sha: m[1], truncated: false, tree: Object.entries(t).map(([path, f]) => ({ path, mode: f.mode, type: f.mode === "160000" ? "commit" : "blob", sha: f.sha, size: blobs.get(f.sha)?.length ?? 0 })) });
    }
    if ((m = p.match(/^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/))) {
      const skip = ancestors(m[1]);
      const list = [...ancestors(m[2])].filter((s) => !skip.has(s));
      const status = m[1] === m[2] ? "identical" : ancestors(m[2]).has(m[1]) ? "ahead" : skip.has(m[2]) ? "behind" : "diverged";
      return send(200, { status, total_commits: list.length, commits: list.map((sha) => ({ sha })) });
    }
    if ((m = p.match(/^\/git\/ref\/heads\/(.+)$/))) return refs.has(m[1]) ? send(200, { ref: `refs/heads/${m[1]}`, object: { sha: refs.get(m[1]), type: "commit" } }) : send(404, { message: "Not Found" });
    if ((m = p.match(/^\/git\/refs\/heads\/(.+)$/)) && method === "PATCH") {
      const cur = refs.get(m[1]);
      if (!commits.has(body.sha)) return send(422, { message: "Object does not exist" });
      if (cur && !body.force && !ancestors(body.sha).has(cur)) return send(422, { message: "Update is not a fast forward" });
      refs.set(m[1], body.sha);
      return send(200, { ref: `refs/heads/${m[1]}`, object: { sha: body.sha } });
    }
    // writing objects and refs (the enclave's page revert): a tree from a base with entries set or deleted (sha null), a
    // commit, a new branch, a pull request
    if (p === "/git/trees" && method === "POST") {
      const files = body.base_tree ? { ...(trees.get(body.base_tree) ?? {}) } : {};
      for (const e of body.tree ?? []) {
        if (e.sha === null) delete files[e.path];
        else files[e.path] = { mode: e.mode, sha: e.sha ?? putBlob(String(e.content ?? "")) };
      }
      for (const [k, v] of Object.entries(knobs.treeEdits ?? {})) files[k] = { mode: "100644", sha: putBlob(v) };
      return send(201, { sha: putTree(files) });
    }
    if (p === "/git/commits" && method === "POST") {
      if (!trees.has(body.tree) || !(body.parents ?? []).every((x: string) => commits.has(x))) return send(422, { message: "Tree or parent does not exist" });
      return send(201, { sha: putCommit({ tree: body.tree, parents: body.parents, ...byBot }) });
    }
    if (p === "/git/refs" && method === "POST") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (refs.has(name)) return send(422, { message: "Reference already exists" });
      if (!commits.has(body.sha)) return send(422, { message: "Object does not exist" });
      refs.set(name, body.sha);
      return send(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (p === "/pulls" && method === "POST") {
      const head = refs.get(body.head);
      if (!head) return send(422, { message: "head does not exist" });
      const onBase = ancestors(refs.get(body.base)!);
      let baseSha = head;
      for (const todo = [head]; todo.length;) { const x = todo.shift()!; if (onBase.has(x)) { baseSha = x; break; } todo.push(...(commits.get(x)?.parents ?? [])); }
      const pr: FakePull = { number: 100 + pulls.length, state: "open", author: "enclave", branch: body.head, headRepo: repo, base: body.base, baseSha, body: body.body ?? "", merged: false, merge_commit_sha: null };
      pulls.push(pr);
      return send(201, pullJson(pr));
    }
    if (p === "/dispatches" && method === "POST") { dispatches.push(body); return send(204); }
    if ((m = p.match(/^\/actions\/workflows\/([\w.-]+)\/runs$/))) {
      const sha = url.searchParams.get("head_sha");
      const list = runs.filter((r) => r.workflow === m![1] && (!sha || r.head_sha === sha)).map(({ artifacts: _, ...r }) => r).reverse();
      return send(200, { total_count: list.length, workflow_runs: list });
    }
    if ((m = p.match(/^\/actions\/runs\/(\d+)$/))) {
      const r = runs.find((x) => x.id === Number(m![1]));
      if (!r) return send(404, { message: "Not Found" });
      const { artifacts: _, ...run } = r;
      return send(200, run);
    }
    if ((m = p.match(/^\/actions\/runs\/(\d+)\/artifacts$/))) {
      const r = runs.find((x) => x.id === Number(m![1]));
      return send(200, { artifacts: Object.keys(r?.artifacts ?? {}).map((name) => ({ name, expired: false, archive_download_url: `http://${req.headers.host}/zip/${r!.id}/${name}` })) });
    }
    if (p === "/pulls" && method === "GET") {
      const head = url.searchParams.get("head") ?? "";
      const branch = head.slice(head.indexOf(":") + 1);
      return send(200, pulls.filter((x) => x.branch === branch).map(pullJson));
    }
    if ((m = p.match(/^\/pulls\/(\d+)$/))) {
      const pr = pulls.find((x) => x.number === Number(m![1]));
      if (!pr) return send(404, { message: "Not Found" });
      if (method === "PATCH") pr.state = body.state ?? pr.state;
      return send(200, pullJson(pr));
    }
    if ((m = p.match(/^\/pulls\/(\d+)\/commits$/))) {
      const pr = pulls.find((x) => x.number === Number(m![1]))!;
      const stop = ancestors(pr.baseSha);
      const out: string[] = [];
      for (let s = refs.get(pr.branch); s && !stop.has(s); s = commits.get(s)?.parents[0]) out.unshift(s);
      return send(200, out.map(commitJson));
    }
    if ((m = p.match(/^\/pulls\/(\d+)\/merge$/)) && method === "PUT") {
      const pr = pulls.find((x) => x.number === Number(m![1]));
      if (!pr || pr.state !== "open" || pr.merged) return send(405, { message: "Pull Request is not mergeable" });
      const head = refs.get(pr.branch)!;
      if (body.sha !== head) return send(409, { message: "Head branch was modified. Review and try the merge again." });
      // squash: main's files + what the PR changed against its base
      const main = refs.get("main")!;
      const files = { ...filesOf(main) };
      const before = filesOf(pr.baseSha), after = filesOf(head);
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!after[k]) delete files[k];
        else if (before[k]?.sha !== after[k].sha || before[k]?.mode !== after[k].mode) files[k] = after[k];
      }
      for (const [k, v] of Object.entries(knobs.mergeEdits ?? {})) files[k] = { mode: "100644", sha: putBlob(v) };
      // squash: one parent; merge: the PR's head as a second parent
      const sha = putCommit({ tree: putTree(files), parents: body.merge_method === "merge" ? [main, head] : [main], ...byBot });
      refs.set("main", sha);
      Object.assign(pr, { merged: true, state: "closed", merge_commit_sha: sha });
      return send(200, { sha, merged: true, message: "Pull Request successfully merged" });
    }
    if ((m = p.match(/^\/statuses\/([0-9a-f]{40})$/)) && method === "POST") { statuses.push({ sha: m[1], ...body }); return send(201, { id: statuses.length }); }
    if ((m = p.match(/^\/issues\/(\d+)\/comments$/)) && method === "POST") { comments.push({ n: Number(m[1]), body: body.body }); return send(201, { id: comments.length }); }
    send(404, { message: `fake: no route ${method} ${p}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, repo, bot, byBot, token: "fake-token", calls, blobs, commits, refs, pulls, runs, dispatches, statuses, comments, knobs,
    commitFiles, openPull, addRun, filesOf,
    close: () => new Promise((r) => server.close(r)),
  };
}
