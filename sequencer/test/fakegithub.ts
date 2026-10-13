// A loopback fake of the GitHub REST calls the publish job makes (App installation token, git data, refs, the pull
// request) and the verify job's list of the workflow's runs (`runs`), for repo "o/r". Every call is kept for the test
// to inspect; anything else is a 404. `fails`: answers given first, one per call, before any of those (`on`: only to
// that call, "METHOD /path"). `refs` and `pulls`: what the creates made (a test may plant one).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Call = { method: string; path: string; body: Record<string, unknown> | null; auth: string };

export async function fakeGitHub(runs: { id: number; display_title: string; status: string }[] = []) {
  const calls: Call[] = [];
  const fails: { status: number; retryAfter?: string; message?: string; on?: string }[] = [];
  const refs = new Map<string, string>();
  const pulls: { number: number; head: { ref: string; sha: string }; base: { ref: string } }[] = [];
  let blobs = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const path = req.url ?? "";
      const method = req.method ?? "";
      calls.push({ method, path, body, auth: String(req.headers.authorization ?? "") });
      const send = (x: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(x));
      const i = fails.findIndex((x) => !x.on || x.on === `${method} ${path}`);
      const f = i < 0 ? undefined : fails.splice(i, 1)[0];
      if (f) return res.writeHead(f.status, { "content-type": "application/json", ...(f.retryAfter ? { "retry-after": f.retryAfter } : {}) }).end(JSON.stringify({ message: f.message ?? "try later" }));
      if (method === "GET" && path === "/repos/o/r/installation") return send({ id: 7 });
      if (method === "POST" && path === "/app/installations/7/access_tokens") return send({ token: "inst-token" }, 201);
      if (method === "GET" && path.startsWith("/repos/o/r/git/commits/")) return send({ tree: { sha: "t0" } });
      if (path === "/repos/o/r/git/blobs") return send({ sha: `b${++blobs}` }, 201);
      if (path === "/repos/o/r/git/trees") return send({ sha: "t1" }, 201);
      if (path === "/repos/o/r/git/commits") return send({ sha: "c1" }, 201);
      if (path === "/repos/o/r/git/refs") { refs.set(String(body.ref), String(body.sha)); return send({}, 201); }
      if (method === "GET" && path.startsWith("/repos/o/r/git/ref/heads/")) {
        const sha = refs.get(`refs/heads/${path.slice("/repos/o/r/git/ref/heads/".length)}`);
        return sha ? send({ object: { sha } }) : send({ message: "Not Found" }, 404);
      }
      if (method === "POST" && path === "/repos/o/r/pulls") {
        pulls.push({ number: 12, head: { ref: String(body.head), sha: refs.get(`refs/heads/${body.head}`) ?? "" }, base: { ref: String(body.base) } });
        return send({ number: 12 }, 201);
      }
      if (method === "GET" && path.startsWith("/repos/o/r/pulls?")) {
        const q = new URLSearchParams(path.split("?")[1]);
        return send(pulls.filter((p) => `o:${p.head.ref}` === q.get("head") && p.base.ref === q.get("base")));
      }
      if (method === "GET" && path.startsWith("/repos/o/r/actions/workflows/sequencer.yml/runs?")) return send({ total_count: runs.length, workflow_runs: runs });
      return send({ message: "Not Found" }, 404);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, fails, refs, pulls, close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}
