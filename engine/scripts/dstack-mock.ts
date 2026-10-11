// A stand-in for the dstack guest agent's HTTP API (the simulator's POST /GetKey, /GetQuote, /Info, /Version), for
// tests when DSTACK_SIMULATOR_ENDPOINT is not set. Same request/response shapes as @phala/dstack-sdk 0.5.8 expects;
// deterministic: key = sha256(path | purpose | algorithm). The "quote" is NOT a TDX quote: it carries the report data
// so the plumbing can be tested. CI's enclave-sim job runs the same tests against the real dstack simulator.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const MOCK_TCB = { mrtd: "aa".repeat(48), rtmr0: "b0".repeat(48), rtmr1: "b1".repeat(48), rtmr2: "b2".repeat(48), rtmr3: "b3".repeat(48), os_image_hash: "0e".repeat(32), compose_hash: "c0".repeat(32), app_compose: "{}", event_log: [] };

export async function startDstackMock() {
  const calls: { path: string; body: Record<string, string> }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url ?? "", body });
    const send = (j: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(j));
    if (req.url === "/GetKey") return send({ key: createHash("sha256").update(`${body.path}|${body.purpose}|${body.algorithm}`).digest("hex"), signature_chain: [] });
    if (req.url === "/GetQuote") return send({ quote: `${"00".repeat(48)}${body.report_data}`, event_log: "[]", report_data: body.report_data });
    if (req.url === "/Info") return send({ app_id: "ab".repeat(20), instance_id: "cd".repeat(20), app_cert: "", tcb_info: JSON.stringify(MOCK_TCB), app_name: "dna", device_id: "de".repeat(32), key_provider_info: "", compose_hash: MOCK_TCB.compose_hash, os_image_hash: MOCK_TCB.os_image_hash });
    if (req.url === "/Version") return send({ version: "0.5.8", rev: "mock" });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise((r) => server.close(r)) };
}
