// A loopback fake of the GitHub REST calls the publish job makes (App installation token, git data, refs, the pull
// request) and the verify job's list of the workflow's runs (`runs`), for repo "o/r". Every call is kept for the test
// to inspect; anything else is a 404.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Call = { method: string; path: string; body: Record<string, unknown> | null; auth: string };

export async function fakeGitHub(runs: { id: number; display_title: string; status: string }[] = []) {
  const calls: Call[] = [];
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
      if (method === "GET" && path === "/repos/o/r/installation") return send({ id: 7 });
      if (method === "POST" && path === "/app/installations/7/access_tokens") return send({ token: "inst-token" }, 201);
      if (method === "GET" && path.startsWith("/repos/o/r/git/commits/")) return send({ tree: { sha: "t0" } });
      if (path === "/repos/o/r/git/blobs") return send({ sha: `b${++blobs}` }, 201);
      if (path === "/repos/o/r/git/trees") return send({ sha: "t1" }, 201);
      if (path === "/repos/o/r/git/commits") return send({ sha: "c1" }, 201);
      if (path === "/repos/o/r/git/refs") return send({}, 201);
      if (method === "POST" && path === "/repos/o/r/pulls") return send({ number: 12 }, 201);
      if (method === "GET" && path.startsWith("/repos/o/r/actions/workflows/sequencer.yml/runs?")) return send({ total_count: runs.length, workflow_runs: runs });
      return send({ message: "Not Found" }, 404);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}
