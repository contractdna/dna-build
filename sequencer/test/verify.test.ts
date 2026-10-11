// An order runs once across runs: verify refuses an order whose id another run of the workflow already carries, in
// any status, and refuses when GitHub can't say. Against a mocked Actions API.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { firstRunOnly } from "../src/ci.ts";

const ENV = { GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "500", GITHUB_TOKEN: "ro-token" };
const REF = "order:b-1234-r1";
type Run = { id: number; display_title: string; status: string };
const run = (id: number, ref: string, status = "completed"): Run => ({ id, display_title: `seq ${ref}`, status });

/** A fetch that answers the workflow's run list, page by page, and keeps what it was asked. */
function api(pages: Run[][]) {
  const asked: { url: string; auth: string }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    asked.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") ?? "" });
    const page = pages[Number(u.searchParams.get("page") ?? 1) - 1] ?? [];
    return Response.json({ total_count: pages.flat().length, workflow_runs: page });
  }) as typeof fetch;
  return { f, asked };
}

test("the first run of an order passes; the list is this workflow's runs, read with the job's token", async () => {
  const { f, asked } = api([[run(500, REF, "in_progress"), run(499, "order:b-9999-r2"), run(498, "order:b-1234-r10")]]);
  assert.equal(await firstRunOnly(REF, ENV, f), null);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, "https://api.github.com/repos/o/r/actions/workflows/sequencer.yml/runs?per_page=100&page=1");
  assert.equal(asked[0].auth, "Bearer ro-token");
});

for (const status of ["completed", "in_progress", "queued", "pending", "waiting"]) {
  test(`a second run of the same order is refused (the first is ${status})`, async () => {
    const { f } = api([[run(500, REF, "in_progress"), run(450, REF, status)]]);
    assert.match(await firstRunOnly(REF, ENV, f) ?? "", new RegExp(`already has run 450 \\(${status}\\)`));
  });
}

test("a later run of the same order refuses this one too (two dispatches waiting on the concurrency group)", async () => {
  const { f } = api([[run(501, REF, "pending"), run(500, REF, "in_progress")]]);
  assert.match(await firstRunOnly(REF, ENV, f) ?? "", /already has run 501/);
});

test("every page is read: a run of the order on a later page is found", async () => {
  const filler = Array.from({ length: 100 }, (_, i) => run(1000 - i, `order:b-other-r${i}`));
  const { f, asked } = api([filler, [run(10, REF)]]);
  assert.match(await firstRunOnly(REF, ENV, f) ?? "", /already has run 10/);
  assert.equal(asked.length, 2);
  const clean = api([filler, filler.slice(0, 3)]);
  assert.equal(await firstRunOnly(REF, ENV, clean.f), null);
  assert.equal(clean.asked.length, 2);
});

test("refused when GitHub can't say: an error status, a network failure, an unreadable answer, no token", async () => {
  const status = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  assert.match(await firstRunOnly(REF, ENV, status) ?? "", /500/);
  const down = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
  assert.match(await firstRunOnly(REF, ENV, down) ?? "", /ECONNREFUSED/);
  const junk = (async () => new Response("not json")) as typeof fetch;
  assert.ok(await firstRunOnly(REF, ENV, junk));
  const shape = (async () => Response.json({ message: "hi" })) as typeof fetch;
  assert.ok(await firstRunOnly(REF, ENV, shape));
  const { f, asked } = api([[]]);
  for (const k of Object.keys(ENV)) assert.match(await firstRunOnly(REF, { ...ENV, [k]: undefined }, f) ?? "", /GITHUB_/);
  assert.equal(asked.length, 0);
  await assert.rejects(firstRunOnly(REF, { ...ENV, SEQ_GITHUB_API: "https://example.com" }, f), /not a loopback/);
});

test("the workflow names each run after its order and lets verify read the run list, nothing more", () => {
  const yml = readFileSync(new URL("../../.github/workflows/sequencer.yml", import.meta.url), "utf8");
  assert.match(yml, /^run-name: seq \$\{\{ github\.event\.client_payload\.ref \}\}$/m);
  assert.match(yml, /^concurrency:\n {2}group: sequencer\n {2}cancel-in-progress: false$/m, "one workflow-wide lock: verify runs only once the run holds it");
  const verify = yml.slice(yml.indexOf("\n  verify:"), yml.indexOf("\n  build:"));
  assert.match(verify, /permissions:\n {6}contents: read\n {6}actions: read\n/);
  assert.match(verify, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  for (const job of [yml.slice(yml.indexOf("\n  build:"), yml.indexOf("\n  publish:")), yml.slice(yml.indexOf("\n  publish:"))]) {
    assert.ok(job.length > 100 && !job.includes("github.token"), "the build and publish jobs are never handed the job token");
  }
});
