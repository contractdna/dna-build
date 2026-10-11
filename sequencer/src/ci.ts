// What the workflow's scripts share.

/** The offline simulation points the model and GitHub endpoints at local fakes. Only a loopback address is accepted
 *  (the workflow never sets one), so a key can never be sent to another host this way. */
export function loopbackOr(url: string | undefined, real: string) {
  if (url === undefined || url === "") return real;
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url)) throw new Error(`not a loopback endpoint: ${url}`);
  return url;
}

/** A game's title (the lead's plan, the commit and PR title): one plain line, no links, handles or dashes. */
export const TITLE = /^[A-Za-z0-9][A-Za-z0-9 ,.'!?&:()-]{1,59}$/;

/** An order runs once: every job refuses a re-run (GitHub can re-run a failed job alone, so each job checks). */
export function firstAttemptOnly(env: Record<string, string | undefined> = process.env) {
  if (env.GITHUB_RUN_ATTEMPT === "1") return;
  console.error(`refused: run attempt ${env.GITHUB_RUN_ATTEMPT} (an order runs once; re-runs are refused here and by the enclave)`);
  process.exit(1);
}

/** An order runs once across runs too: refused (the reason) when any other run of this workflow, in any status, carries
 *  its ref in its title (run-name `seq order:<id>`). A dispatch sent again inside the order's window starts a new run
 *  on its first attempt, which only this catches. The workflow-wide concurrency group holds a run, verify included,
 *  until the run before it has finished, so of two dispatches of one order the later one always sees the earlier one.
 *  An earlier one still pending is cancelled by the concurrency group, or, if its verify is already running, sees the
 *  later one and is refused. The list is read with the job's token (actions: read);
 *  anything GitHub can't answer refuses. Every page is read: the list's order is not relied on. */
export async function firstRunOnly(ref: string, env: Record<string, string | undefined> = process.env, f: typeof fetch = fetch): Promise<string | null> {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: self, GITHUB_TOKEN: token } = env;
  if (!repo || !self || !token) return "GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_TOKEN are needed to look for another run of the order";
  const api = loopbackOr(env.SEQ_GITHUB_API, "https://api.github.com");
  const title = `seq ${ref}`;
  for (let page = 1; ; page++) {
    let runs: unknown;
    try {
      const r = await f(`${api}/repos/${repo}/actions/workflows/sequencer.yml/runs?per_page=100&page=${page}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) return `the workflow's runs could not be listed: ${r.status}`;
      runs = ((await r.json()) as { workflow_runs?: unknown }).workflow_runs;
    } catch (e) {
      return `the workflow's runs could not be listed: ${(e as Error).message}`;
    }
    if (!Array.isArray(runs)) return "the workflow's runs could not be listed: no workflow_runs in the answer";
    const other = (runs as { id?: unknown; display_title?: unknown; status?: unknown }[]).find((x) => x?.display_title === title && String(x.id) !== self);
    if (other) return `${ref} already has run ${String(other.id)} (${String(other.status)}): an order runs once`;
    if (runs.length < 100) return null;
  }
}
