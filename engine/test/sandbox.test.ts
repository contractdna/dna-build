// The forge sandbox hand-off (src/limited.ts, src/sandbox.ts): in the enclave the gates' forge runs in a container of
// its own with no network; the engine and it share a volume. Here a temp dir stands in for the volume and the sandbox
// loop runs in-process.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { ANVIL_URL, jobIssues, LIMITS, MAX_LIMITS, runLimited, SANDBOX, serveJobs, submit, sweepCancels } from "../src/limited.ts";
import { workspace } from "../src/seq-forge.ts";

const hasForge = (() => { try { execFileSync("forge", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const dir = mkdtempSync(join(tmpdir(), "seq-work-"));
const ws = join(dir, "seq-ws-1");
mkdirSync(ws);
const stop = { now: false };
let loop: Promise<void>;
before(() => { loop = serveJobs(dir, stop); });
after(async () => { stop.now = true; await loop; rmSync(dir, { recursive: true, force: true }); });

const job = { cmd: "forge", args: ["--version"], cwd: ws, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 30_000 };

test("the sandbox runs forge only, inside the volume, with no secret in its env and no fork but its own anvil", () => {
  assert.deepEqual(jobIssues(job, dir), []);
  assert.deepEqual(jobIssues({ ...job, args: ["test", "--fork-url", ANVIL_URL] }, dir), []);
  for (const [why, j] of [
    ["only forge", { ...job, cmd: "sh" }],
    ["cwd outside", { ...job, cwd: "/etc" }],
    ["cwd outside", { ...job, cwd: `${dir}/../x` }],
    ["a fork only of the job's own anvil", { ...job, args: ["test", "--fork-url", "https://eth-mainnet.g.alchemy.com/v2/key"] }],
    ["env: PATH, HOME and FOUNDRY_* only", { ...job, env: { PATH: "/bin", DATABASE_URL: "postgres://x" } }],
    ["timeout", { ...job, timeoutMs: 2 * 3600_000 }],
  ] as [string, object][]) assert.ok(jobIssues(j, dir).some((i) => i.startsWith(why)), why);
});

test("a job goes through the volume and comes back; the files are cleaned up", { skip: hasForge ? false : "needs forge" }, async () => {
  const r = await submit(job, dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /forge/i);
  assert.deepEqual(readdirSync(join(dir, "jobs")), []);
});

test("every run caps forge's (and anvil's) thread pools, so the address-space limit holds on a host with many cores", async () => {
  const bin = join(dir, "bin-env");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "forge"), "#!/bin/sh\necho \"$RAYON_NUM_THREADS $TOKIO_WORKER_THREADS\"\n");
  chmodSync(join(bin, "forge"), 0o755);
  assert.ok(LIMITS.threads >= 1 && LIMITS.threads <= 8, `a small fixed pool (${LIMITS.threads})`);
  const r = await submit({ ...job, env: { PATH: `${bin}:/usr/bin:/bin` } }, dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout.trim(), `${LIMITS.threads} ${LIMITS.threads}`);
});

test("every run has forge's FFI off, whatever the job's env says", async () => {
  const bin = join(dir, "bin-ffi");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "forge"), "#!/bin/sh\necho \"$FOUNDRY_FFI\"\n");
  chmodSync(join(bin, "forge"), 0o755);
  const r = await runLimited("forge", [], { cwd: ws, env: { PATH: `${bin}:/usr/bin:/bin`, FOUNDRY_FFI: "true" }, timeoutMs: 30_000 });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout.trim(), "false");
});

test("the volume is the group's: the engine (uid 1000) and the sandbox (uid 1001, group 1000) can each remove what the other made", async () => {
  const mode = (p: string) => statSync(p).mode & 0o777;
  // the engine's side: the workspace and forge's root are the group's; its own files keep the process's usual modes
  const kit = mkdtempSync(join(tmpdir(), "seq-kit-"));
  for (const f of ["games/foundry.toml", "src/games/GameKit.sol", "src/games/IGames.sol", "src/games/GameFactory.sol", "src/games/GameFunder.sol", "test/games/GameKitConformance.sol", "lib/forge-std/src/Test.sol"]) {
    mkdirSync(join(kit, f, ".."), { recursive: true });
    writeFileSync(join(kit, f), "");
  }
  writeFileSync(join(kit, "ref"), "");
  const w = workspace(kit, { "contracts/src/games/g/G.sol": "" }, "g");
  try {
    assert.equal(mode(w), 0o770, "the workspace (mkdtemp makes it 0700)");
    assert.equal(mode(join(w, "games")), 0o770, "forge's root, where it writes out/ and cache/");
    assert.equal(mode(join(w, "src/games/g/G.sol")), mode(join(kit, "ref")), "a source file: the usual mode");
  } finally {
    rmSync(w, { recursive: true, force: true });
    rmSync(kit, { recursive: true, force: true });
  }
  // the sandbox's side: the real entry (src/sandbox.ts) on a volume of its own; what forge makes is the group's
  const vol = mkdtempSync(join(tmpdir(), "seq-work-entry-"));
  const bin = join(vol, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "forge"), "#!/bin/sh\nmkdir -p out && echo x > out/a.json\n");
  chmodSync(join(bin, "forge"), 0o755);
  const w2 = join(vol, "seq-ws-1");
  mkdirSync(w2);
  const sandbox = spawn(process.execPath, [fileURLToPath(new URL("../src/sandbox.ts", import.meta.url)), vol], { stdio: "ignore" });
  try {
    const r = await submit({ ...job, cwd: w2, env: { PATH: `${bin}:/usr/bin:/bin` } }, vol);
    assert.equal(r.code, 0, r.out);
    assert.equal(mode(join(vol, "jobs")), 0o770, "the job queue");
    assert.equal(mode(join(w2, "out")) & 0o070, 0o070, "a directory forge made");
    assert.equal(mode(join(w2, "out", "a.json")) & 0o060, 0o060, "a file forge made");
  } finally {
    sandbox.kill();
    await once(sandbox, "exit");
    rmSync(vol, { recursive: true, force: true });
  }
});

test("a job can't raise its own limits or set forge's thread count", () => {
  assert.deepEqual(jobIssues({ ...job, limits: { outputBytes: MAX_LIMITS.outputBytes, asBytes: LIMITS.asBytes / 2 } }, dir), []);
  for (const limits of [{ asBytes: LIMITS.asBytes + 1 }, { nproc: 100_000 }, { threads: 64 }, { outputBytes: MAX_LIMITS.outputBytes + 1 }, { nofile: 0 }, { nproc: "512" }, { other: 1 }]) {
    assert.ok(jobIssues({ ...job, limits } as never, dir).some((i) => i.startsWith("limits")), JSON.stringify(limits));
  }
  assert.ok(jobIssues({ ...job, env: { ...job.env, FOUNDRY_THREADS: "64" } }, dir).includes("env: no FOUNDRY_THREADS"));
  assert.ok(jobIssues({ ...job, env: { ...job.env, FOUNDRY_FS_PERMISSIONS: '[{access="read-write",path="/"}]' } }, dir).includes("env: no FOUNDRY_FS_PERMISSIONS"));
  assert.deepEqual(jobIssues({ ...job, env: { ...job.env, FOUNDRY_FUZZ_RUNS: "64" } }, dir), [], "other FOUNDRY_* still pass");
  for (const a of [["--threads", "64"], ["--threads=64"], ["--jobs", "64"], ["--jobs=64"], ["-j", "64"], ["-j64"], ["-j=64"], ["-vvj64"], ["--ffi"], ["--ffi=true"]]) {
    assert.ok(jobIssues({ ...job, args: ["build", ...a] }, dir).includes("args: no --threads, --jobs, -j or --ffi"), a.join(" "));
  }
  assert.deepEqual(jobIssues({ ...job, args: ["test", "-vvv", "--json", "--match-path", "*/games/jackpot/*"] }, dir), [], "other args still pass");
});

test("a job the sandbox refuses comes back refused, not run", async () => {
  const r = await submit({ ...job, cmd: "sh", args: ["-c", "echo ran"] }, dir);
  assert.equal(r.code, null);
  assert.match(r.out, /refused by the sandbox: only forge/);
  assert.doesNotMatch(r.stdout, /ran/);
});

test("an abort on the engine's side stops the run in the sandbox (the job's whole process group)", async () => {
  // a stand-in forge that would run for 30 s
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "forge"), "#!/bin/sh\nsleep 30\n");
  chmodSync(join(bin, "forge"), 0o755);
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 300);
  const r = await submit({ ...job, args: ["test"], env: { PATH: `${bin}:/usr/bin:/bin` }, signal: ac.signal }, dir);
  assert.equal(r.aborted, true, JSON.stringify(r));
  assert.ok(Date.now() - t0 < 10_000, "stopped well before its 30 s");
});

test("the engine giving up on a claimed job stops it there: no leftover files, and the next job runs at once", async () => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "forge"), "#!/bin/sh\n[ \"$1\" = quick ] && { echo done; exit 0; }\nsleep 30\n");
  chmodSync(join(bin, "forge"), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  const grace = SANDBOX.graceMs;
  SANDBOX.graceMs = -29_400; // the engine waits 0.6 s for a job the sandbox would let run 30 s
  try {
    await assert.rejects(submit({ ...job, args: ["slow"], env, timeoutMs: 30_000 }, dir), /did not answer/);
  } finally {
    SANDBOX.graceMs = grace;
  }
  const t0 = Date.now();
  const r = await submit({ ...job, args: ["quick"], env, timeoutMs: 30_000 }, dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(Date.now() - t0 < 5_000, `the queue was free again (${Date.now() - t0} ms)`);
  for (let i = 0; i < 20 && readdirSync(join(dir, "jobs")).length; i++) await new Promise((x) => setTimeout(x, 100));
  assert.deepEqual(readdirSync(join(dir, "jobs")), [], "no job, claim, cancel or result left behind");
});

test("a stray .cancel (its job gone) is swept; one beside a waiting job stays", () => {
  const d = mkdtempSync(join(tmpdir(), "seq-work-sweep-"));
  try {
    mkdirSync(join(d, "jobs"));
    writeFileSync(join(d, "jobs", "a.cancel"), "");
    writeFileSync(join(d, "jobs", "b.cancel"), "");
    writeFileSync(join(d, "jobs", "b.json"), "{}");
    sweepCancels(d);
    assert.deepEqual(readdirSync(join(d, "jobs")).sort(), ["b.cancel", "b.json"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("no sandbox answering is an error (an outage), not a gate result", async () => {
  const other = mkdtempSync(join(tmpdir(), "seq-work-none-"));
  const grace = SANDBOX.graceMs;
  SANDBOX.graceMs = 300;
  try {
    await assert.rejects(submit({ ...job, cwd: join(other, "x"), timeoutMs: 100 }, other), /did not answer/);
  } finally {
    SANDBOX.graceMs = grace;
    rmSync(other, { recursive: true, force: true });
  }
});
