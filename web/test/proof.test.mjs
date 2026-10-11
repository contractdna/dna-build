// /proof's browser checks against the vectors engine/test/proof.test.ts pins for the CLI (same rules on both sides).
import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { checkCompose, checkEventLog, checkIdentity, checkKeyProvider, checkRecord, eventDigest, logDigestOf, mapperOk, PRE_LAUNCH_SCRIPT, replayRtmr, reportDataOf, tweetIdOf } from "../app/proof/verify.ts";

/** Compose files that are valid YAML yet run something else (a review's probes and more): each must fail. */
const probes = (yaml, img) => {
  const evil = `evil/x@sha256:${"e".repeat(64)}`;
  const into = (svc, line) => yaml.replace(`  ${svc}:\n`, `  ${svc}:\n${line}`);
  return [
    ["a flow-mapping extra service", yaml.replace("services:\n", `services:\n  extra: {image: ${evil}}\n`), /services .*: exactly engine, pagecheck, forge/],
    ["image : (a space before the colon)", yaml.replace(`    image: ${img}\n`, `    image : ${evil}\n`), /service engine: image evil/],
    ['a quoted "image" key', yaml.replace(`    image: ${img}\n`, `    "image": ${evil}\n`), /service engine: image evil/],
    ["{build: .}", yaml.replace("services:\n", "services:\n  extra: {build: .}\n"), /service extra: build/],
    ["build : (a space before the colon)", into("forge", "    build : .\n"), /service forge: build/],
    ["extends: engine", into("forge", "    extends: engine\n"), /service forge: extends/],
    ["a merge key from a top-level anchor", `x-b: &b\n  build: .\n${into("forge", "    <<: *b\n")}`, /service forge: build/],
    ["a top-level key the template does not use", `${yaml}include:\n  - other.yml\n`, /top-level key include/],
    ["a duplicate image key", into("engine", `    image: ${evil}\n`), /not valid YAML/],
    ["not YAML", "services: [", /not valid YAML/],
    ["the engine image swapped while its digest runs elsewhere", yaml.replace(`    image: ${img}\n`, `    image: ghcr.io/other/engine@${img.split("@")[1]}\n`), /service engine: image ghcr\.io\/other\/engine@/],
    ["an extra service on the released image", yaml.replace("services:\n", `services:\n  extra:\n    image: ${img}\n`), /exactly engine, pagecheck, forge/],
  ];
};
// engine/src/proof.ts on the same inputs (engine/test/proof.test.ts asserts the same values)
const V = {
  reportData: "d787c7dbf04a147cb29f8c929b8015e2c49a8ba3f4acc6a8d6db4ba221b9d1e0",
  logDigest: "568fe8a08a11aa47a97d44c5118ffec96997f201718d74d9413157754279343b",
  eventDigest: "bb4ea86a437a0a3caf984ed4ef2b8220cde9d6504efe3fbc1e1e5d0cb805aa98bcd45567b84bf0a550420198d0828968",
  rtmr: "7977ac1dfe253cf1bf4582615c01a87a28d8e36933f09f2dab4e47e99bcadf2396eb3fca00766359aee75ee60ef766e4",
  calldata: "0xac7d0ce500000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a100000000000000000000000000000000000000000000000000000000000004d200000000000000000000000000000000000000000000000000000000000002580000000000000000000000000000000000000000000000000000000000000064",
};
const plate = "0x00000000000000000000000000000000000000a1";

test("report data, event digest, RTMR replay, mapper: the engine's vectors", async () => {
  assert.equal(await reportDataOf("0xab", "cd", { agent: `0x${"11".repeat(20)}`, anchor: `0x${"22".repeat(20)}`, logSigner: `0x${"33".repeat(20)}`, funder: `0x${"55".repeat(20)}` }), V.reportData);
  assert.equal(await logDigestOf("ab".repeat(32), "anchor", "op:SetCanary"), V.logDigest);
  assert.equal(await eventDigest("compose-hash", "cd".repeat(32)), V.eventDigest);
  assert.equal(await replayRtmr([await eventDigest("app-id", "ab".repeat(20)), V.eventDigest]), V.rtmr);
  assert.ok(mapperOk({ op: "SetCanary", args: [plate, "1234", 600, 100], calldata: V.calldata }));
  assert.ok(!mapperOk({ op: "SetCanary", args: [plate, "1234", 600, 101], calldata: V.calldata }));
  assert.ok(!mapperOk({ op: "Nope", args: [], calldata: V.calldata }));
});

test("event log: replay + per-event digests; a swapped compose-hash payload fails", async () => {
  const ev = async (event, payload) => ({ imr: 3, event, event_payload: payload, digest: await eventDigest(event, payload) });
  const log = [await ev("app-id", "ab".repeat(20)), await ev("compose-hash", "cd".repeat(32))];
  assert.deepEqual(await checkEventLog(log, V.rtmr), { issues: [], composeHash: "cd".repeat(32), appId: "ab".repeat(20), osImageHash: null, keyProvider: null });
  const ev2 = { appId: "ab".repeat(20), osImageHash: "0f".repeat(32) };
  assert.deepEqual(checkIdentity(ev2, ev2, { dstackApp: `0x${"ab".repeat(20)}`, osImageHash: "0f".repeat(32) }), []);
  assert.equal(checkIdentity({ appId: "cd".repeat(20), osImageHash: null }, {}, { dstackApp: `0x${"ab".repeat(20)}`, osImageHash: "0f".repeat(32) }).length, 2);
  assert.deepEqual(await checkCompose(null, "00".repeat(32)), ["the app does not publish its app_compose (public_tcbinfo)"]);
  const forged = log.map((e) => (e.event === "compose-hash" ? { ...e, event_payload: "ee".repeat(32) } : e));
  assert.ok((await checkEventLog(forged, V.rtmr)).issues.some((i) => /digest does not match/.test(i)));
});

test("a real Phala quote's event log (engine/test/fixtures): digests left out are computed; it replays; key provider", async () => {
  const f = JSON.parse(readFileSync(new URL("../../engine/test/fixtures/phala-eventlog-2026-10-10.json", import.meta.url), "utf8"));
  const ev = await checkEventLog(f.eventLog, f.rtmr3);
  assert.deepEqual(ev.issues, []);
  assert.equal(ev.composeHash, f.composeHash);
  const release = JSON.parse(readFileSync(new URL("../app/proof/release.json", import.meta.url), "utf8"));
  assert.ok(checkKeyProvider(ev.keyProvider, release.kmsKeyProvider).some((i) => /is not the released KMS/.test(i)), "that boot was on Phala's KMS, not the Ethereum one");
  assert.deepEqual(checkKeyProvider(ev.keyProvider, JSON.parse(Buffer.from(ev.keyProvider, "hex").toString()).id), []);
});

test("compose binding and a signed record", async () => {
  const template = JSON.parse(readFileSync(new URL("../../deploy/app-compose.template.json", import.meta.url), "utf8"));
  assert.equal(PRE_LAUNCH_SCRIPT, template.pre_launch_script, "the measured no-op = the template's literal (and engine/src/proof.ts)");
  const hashOf = async (s) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");
  const rel = { image: "x", imageDigest: `sha256:${"b".repeat(64)}`, pagecheckImage: "p", pagecheckDigest: `sha256:${"d".repeat(64)}`, allowedEnvs: template.allowed_envs };
  const check = async (o, r = rel) => { const s = JSON.stringify(o); return checkCompose(s, await hashOf(s), r); };
  const yaml = "services:\n  engine:\n    image: x@sha256:" + "b".repeat(64) + "\n  pagecheck:\n    image: p@sha256:" + "d".repeat(64) + "\n  forge:\n    image: x@sha256:" + "b".repeat(64) + "\nvolumes:\n  v:\n";
  const base = { ...template, docker_compose_file: yaml };
  assert.deepEqual(await check(base), []);
  assert.ok((await check(base, { ...rel, imageDigest: `sha256:${"c".repeat(64)}` })).some((i) => /service engine: image .* is not the released digest/.test(i)));
  for (const [what, y, re] of probes(yaml, `x@sha256:${"b".repeat(64)}`)) {
    assert.notEqual(y, yaml, what);
    const issues = await check({ ...base, docker_compose_file: y });
    assert.ok(issues.some((i) => re.test(i)), `${what}: ${issues.join("; ")}`);
  }
  assert.ok((await check({ ...base, allowed_envs: [...template.allowed_envs, "EXTRA"] })).some((i) => /allowed_envs/.test(i)));
  assert.ok((await check({ ...base, pre_launch_script: undefined })).some((i) => /no pre-launch script/.test(i)));
  const escaped = JSON.stringify(base).replace(/}$/, ',"zz":"s\\u0073hd"}');
  assert.ok(!/sshd/.test(escaped) && (await checkCompose(escaped, await hashOf(escaped), rel)).some((i) => /SSH/.test(i)), "a JSON-escaped sshd");
  const phalaDefault = "#!/bin/bash\necho \"Phala Cloud Pre-Launch Script v0.0.21\"\necho \"$KEY\" >> /root/.ssh/authorized_keys\n";
  assert.ok((await check({ ...base, pre_launch_script: phalaDefault })).some((i) => /Phala's default/.test(i)));
  assert.ok((await check({ ...base, pre_launch_script: phalaDefault })).some((i) => /SSH/.test(i)));
  assert.ok((await check({ ...base, pre_launch_script: "true\n" })).some((i) => /not DNA's no-op/.test(i)));
  assert.ok((await check({ ...base, init_script: "echo" })).some((i) => /init_script/.test(i)));
  assert.ok((await check({ ...base, local_key_provider_enabled: true })).some((i) => /KMS/.test(i)));
  const logKey = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
  const body = '{"kind":"intent"}';
  const sha = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  const eprev = "00".repeat(32);
  const ehash = Buffer.from(await sha(new Uint8Array([...Buffer.from(eprev, "hex"), ...(await sha(new TextEncoder().encode(body)))]))).toString("hex");
  const K = { kind: "anchor", ref: "op:SetCanary" };
  const esig = await logKey.signMessage({ message: { raw: `0x${await logDigestOf(ehash, K.kind, K.ref)}` } });
  assert.deepEqual(await checkRecord({ ...K, body, eprev, ehash, esig }), { ehashOk: true, signer: logKey.address });
  assert.notEqual((await checkRecord({ kind: "mode", ref: "override", body, eprev, ehash, esig })).signer, logKey.address, "a relabelled record does not verify");
  assert.equal((await checkRecord({ ...K, body: "{}", eprev, ehash, esig })).ehashOk, false);
});

test("record checker: a post link or a long id is a tweet; a record number is not", () => {
  const id = "1976543210987654321";
  for (const s of [`https://x.com/contractdna/status/${id}`, `https://twitter.com/a/status/${id}?s=20`, ` ${id} `, `x.com/i/status/${id}/photo/1`]) assert.equal(tweetIdOf(s), id, s);
  for (const s of ["12345", "", "https://x.com/contractdna", "status/12", `${id}0000`]) assert.equal(tweetIdOf(s), null, s);
});
