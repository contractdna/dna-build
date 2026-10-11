// Running the gates' untrusted code (forge, and anvil for the fork sim): limited child processes, and, in the enclave,
// the hand-off to the `forge` container (deploy/docker-compose.template.yml: the engine's own image, a network namespace
// with nothing but loopback, no environment, no dstack socket). The engine and that container share one volume
// (/work): the engine writes a job file, the sandbox (src/sandbox.ts) runs it under the same limits and writes the
// result next to it. No imports from the engine: the sandbox loads this file alone.
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

// nproc counts every process and thread of the kernel uid, across containers: the forge container runs as its own uid
// (1001; the engine is 1000, the page check 1002: deploy/docker-compose.template.yml), so 512 is this sandbox's alone.
// threads: forge's and anvil's pools (rayon, tokio) default to one thread per core, and on a host with many cores
// `forge build` outgrows the 4 GB of address space; a fixed pool keeps every run inside it on any host.
export const LIMITS = { asBytes: 4 * 1024 ** 3, nproc: 512, nofile: 1024, fsizeBytes: 100 * 1024 ** 2, outputBytes: 64 * 1024, threads: 4 };
/** The most a job may ask for: the limits, but a JSON report's output (with traces) may reach 256 MB. */
export const MAX_LIMITS = { ...LIMITS, outputBytes: 256 * 1024 ** 2 };
export type Ran = { code: number | null; signal: string | null; out: string; stdout: string; timedOut: boolean; aborted?: boolean };
/** One run. `anvil`: start a fresh loopback anvil first (an empty chain, chain id 1) and put its URL where an argument
 *  is ANVIL_URL; it is stopped with the run. */
export type Job = { cmd: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number; limits?: Partial<typeof LIMITS>; anvil?: boolean; signal?: AbortSignal };
export const ANVIL_URL = "{{anvil}}";
const prlimit = ["/usr/bin/prlimit", "/bin/prlimit"].find((p) => existsSync(p));
/** The env that caps a run's thread pools (forge reads both when no --threads is given; anvil reads tokio's). */
const pools = (n: number) => ({ RAYON_NUM_THREADS: String(n), TOKIO_WORKER_THREADS: String(n) });

/** Run `cmd` with only `env` (plus the thread caps, FFI off), under the limits, in its own process group; the group
 *  is killed on timeout, when `signal` aborts, and once the command exits (nothing it started outlives it). Output
 *  (stdout + stderr) is cut to LIMITS.outputBytes. FOUNDRY_OFFLINE is not pinned here: outside the image (CI, a
 *  laptop) forge may still have to fetch the pinned solc; forgeEnv sets it when the solc is local, and the forge
 *  container has no network anyway. */
export function runLimited(cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number; limits?: Partial<typeof LIMITS>; signal?: AbortSignal }): Promise<Ran> {
  const l = { ...LIMITS, ...o.limits };
  const wrap = prlimit ? [prlimit, `--as=${l.asBytes}`, `--nproc=${l.nproc}`, `--nofile=${l.nofile}`, `--fsize=${l.fsizeBytes}`, "--", "nice", "-n", "10"] : ["nice", "-n", "10"];
  if (o.signal?.aborted) return Promise.resolve({ code: null, signal: null, out: "aborted: not started", stdout: "", timedOut: false, aborted: true });
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(wrap[0], [...wrap.slice(1), cmd, ...args], { cwd: o.cwd, env: { ...o.env, ...pools(l.threads), FOUNDRY_FFI: "false" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, signal: null, out: (e as Error).message, stdout: "", timedOut: false });
      return;
    }
    let out = "";
    let stdout = "";
    let timedOut = false;
    const take = (b: Buffer) => { if (out.length < l.outputBytes) out += b.toString("utf8").slice(0, l.outputBytes - out.length); };
    child.stdout!.on("data", (b: Buffer) => { take(b); if (stdout.length < l.outputBytes) stdout += b.toString("utf8").slice(0, l.outputBytes - stdout.length); });
    child.stderr!.on("data", take);
    const killGroup = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, o.timeoutMs);
    let aborted = false;
    const onAbort = () => { aborted = true; killGroup(); };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => { out += `\n${e.message}`; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      killGroup();
      resolve({ code, signal, out, stdout, timedOut, aborted });
    });
  });
}

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  s.on("error", rej);
});

/** A job, here: with its loopback anvil when it asks for one. */
export async function runJob(j: Job): Promise<Ran> {
  if (!j.anvil) return runLimited(j.cmd, j.args, j);
  const port = await freePort();
  const anvil = spawn("anvil", ["--port", String(port), "--host", "127.0.0.1", "--silent"], { env: { PATH: j.env.PATH ?? "/usr/bin:/bin", ...pools(LIMITS.threads) }, detached: true, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      const up = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((x) => x.ok, () => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return await runLimited(j.cmd, j.args.map((a) => (a === ANVIL_URL ? url : a)), j);
  } finally {
    try { process.kill(-anvil.pid!, "SIGKILL"); } catch { /* gone */ }
  }
}

// ---------------------------------------------------------------- the hand-off through the shared volume

/** The shared volume in the enclave (compose: seq-work), mounted at /work in both containers. */
export const SANDBOX = { dir: "/work", pollMs: 200, graceMs: 60_000 };
const jobs = (dir: string) => join(dir, "jobs");
let n = 0;

/** Why the sandbox refuses a job ([] = it runs): forge only, inside the volume, nothing that reaches the network. */
export function jobIssues(j: Partial<Job>, dir = SANDBOX.dir): string[] {
  const out: string[] = [];
  if (j.cmd !== "forge") out.push("only forge runs here");
  if (typeof j.cwd !== "string" || !resolve(j.cwd).startsWith(`${resolve(dir)}/`)) out.push("cwd outside the work volume");
  if (!Array.isArray(j.args) || !j.args.every((a) => typeof a === "string")) out.push("args: strings");
  const forkTo = (j.args ?? [])[(j.args ?? []).indexOf("--fork-url") + 1];
  if ((j.args ?? []).includes("--fork-url") && forkTo !== ANVIL_URL) out.push("a fork only of the job's own anvil");
  if (!j.env || typeof j.env !== "object" || Object.keys(j.env).some((k) => !/^(PATH|HOME|FOUNDRY_[A-Z_]+)$/.test(k))) out.push("env: PATH, HOME and FOUNDRY_* only");
  // the thread cap is the sandbox's (runLimited), not the job's; file access stays the games profile's (none)
  for (const k of ["FOUNDRY_THREADS", "FOUNDRY_FS_PERMISSIONS"]) if (j.env && typeof j.env === "object" && k in j.env) out.push(`env: no ${k}`);
  // forge's --threads / --jobs / -j (also --threads=8, -j8, or -j inside a cluster of short flags such as -vvj8), --ffi
  if ((j.args ?? []).some((a) => typeof a === "string" && /^(--(threads|jobs|ffi)(=.*)?|-[^-]*j.*)$/.test(a))) out.push("args: no --threads, --jobs, -j or --ffi");
  const lim = (j.limits ?? {}) as Record<string, unknown>;
  if (typeof lim !== "object" || Object.entries(lim).some(([k, v]) => !(k in MAX_LIMITS) || typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_LIMITS[k as keyof typeof MAX_LIMITS])) out.push("limits: at most the sandbox's own");
  if (!Number.isFinite(j.timeoutMs) || (j.timeoutMs as number) <= 0 || (j.timeoutMs as number) > 60 * 60_000) out.push("timeout: up to an hour");
  return out;
}

/** The engine's side: write the job, wait for its result (the job's own timeout plus a grace), clean up. Throws when
 *  the sandbox does not answer (an outage, not a gate result). Giving up never leaves work behind: a job not yet
 *  claimed is taken back (it never runs); a claimed one is told to stop (.cancel) and its claim dropped, so the sandbox
 *  stops it, discards its result and moves on to the next job. */
export async function submit(j: Job, dir = SANDBOX.dir): Promise<Ran> {
  const id = `${process.pid}-${Date.now()}-${++n}`;
  const f = join(jobs(dir), id);
  mkdirSync(jobs(dir), { recursive: true });
  chmodSync(jobs(dir), 0o770); // the sandbox (another uid, this group) claims and answers jobs here
  const { signal, ...job } = j;
  writeFileSync(`${f}.tmp`, JSON.stringify(job));
  renameSync(`${f}.tmp`, `${f}.json`);
  const cancel = () => { try { writeFileSync(`${f}.cancel`, ""); } catch { /* the job is gone */ } };
  signal?.addEventListener("abort", cancel, { once: true });
  const end = Date.now() + j.timeoutMs + SANDBOX.graceMs;
  let answered = false;
  try {
    while (Date.now() < end) {
      if (existsSync(`${f}.out`)) {
        const r = JSON.parse(readFileSync(`${f}.out`, "utf8")) as Ran;
        answered = true;
        return r;
      }
      await new Promise((r) => setTimeout(r, SANDBOX.pollMs));
    }
    throw new Error(`the forge sandbox did not answer within ${Math.round((j.timeoutMs + SANDBOX.graceMs) / 1000)} s`);
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (answered) rmSync(`${f}.out`, { force: true });
    else {
      let unclaimed = false;
      try { renameSync(`${f}.json`, `${f}.gone`); unclaimed = true; } catch { /* already claimed */ }
      if (unclaimed) rmSync(`${f}.gone`, { force: true });
      else {
        cancel(); // the sandbox stops the run, sees the claim gone and discards the result (it removes .cancel)
        rmSync(`${f}.run`, { force: true });
      }
    }
  }
}

/** A .cancel with no job beside it (no .json, no .run) is left from a job that ended on its own: removed. Safe between
 *  jobs: the only job a .cancel can be meant for while it runs is the one this loop is running. */
export function sweepCancels(dir = SANDBOX.dir) {
  if (!existsSync(jobs(dir))) return;
  for (const name of readdirSync(jobs(dir)).filter((x) => x.endsWith(".cancel"))) {
    const f = join(jobs(dir), name.slice(0, -".cancel".length));
    if (!existsSync(`${f}.json`) && !existsSync(`${f}.run`)) rmSync(`${f}.cancel`, { force: true });
  }
}

/** The sandbox's side: claim each new job (a rename), run it, write the result. One at a time. */
export async function serveJobs(dir = SANDBOX.dir, stop = { now: false }) {
  while (!stop.now) {
    let did = false;
    sweepCancels(dir);
    for (const name of existsSync(jobs(dir)) ? readdirSync(jobs(dir)).filter((x) => x.endsWith(".json")).sort() : []) {
      const f = join(jobs(dir), name.slice(0, -".json".length));
      try { renameSync(`${f}.json`, `${f}.run`); } catch { continue; } // gone or taken
      did = true;
      let r: Ran;
      try {
        const j = JSON.parse(readFileSync(`${f}.run`, "utf8")) as Job;
        const bad = jobIssues(j, dir);
        const ac = new AbortController();
        const watch = setInterval(() => { if (existsSync(`${f}.cancel`)) ac.abort(); }, SANDBOX.pollMs);
        try {
          r = bad.length ? { code: null, signal: null, out: `refused by the sandbox: ${bad.join("; ")}`, stdout: "", timedOut: false } : await runJob({ ...j, signal: ac.signal });
        } finally {
          clearInterval(watch);
        }
      } catch (e) {
        r = { code: null, signal: null, out: `the sandbox could not run it: ${(e as Error).message}`, stdout: "", timedOut: false };
      }
      writeFileSync(`${f}.tmp`, JSON.stringify(r));
      renameSync(`${f}.tmp`, `${f}.out`);
      // the engine gave up on it (its claim is gone): nobody reads this result
      if (!existsSync(`${f}.run`)) for (const x of [".out", ".cancel"]) rmSync(`${f}${x}`, { force: true });
      rmSync(`${f}.run`, { force: true });
      rmSync(`${f}.cancel`, { force: true });
    }
    if (!did) await new Promise((r) => setTimeout(r, SANDBOX.pollMs));
  }
}
