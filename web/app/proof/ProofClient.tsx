"use client";
// The /proof checks run in the visitor's browser: a fresh nonce → the enclave's /attestation → the TDX quote verified
// with @phala/dcap-qvl (collateral from Phala's PCCS: disclosed) → measurements, event log, compose binding, the
// on-chain allow-list and registry.agent() over a public RPC. The record viewer recomputes a log record's enclave hash,
// recovers its signer (the released log key) and re-runs the mapper. Nothing here is trusted from our server except the bytes it returns.
import { useState } from "react";
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { ui } from "../_ui/ui";
import s from "./proof.module.css";
import { checkCompose, COMPOSE_CLAIM, checkKeyProvider, checkEventLog, checkIdentity, checkRecord, type Event, mapperOk, PROVIDER_FIELDS, reportDataOf, sameHex, toHex, tweetIdOf } from "./verify";

export type Release = {
  registry: { address: string; startBlock: number } | null; kmsAuth: string; commit: string | null; image: string; imageDigest: string | null; pagecheckImage: string; pagecheckDigest: string | null; allowedEnvs: string[] | null; composeHash: string | null; dstackApp: string | null;
  kmsKeyProvider?: string | null; attestationUrl: string | null; measurements: { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; osImageHash: string } | null; logSigner: string | null; funder?: string | null;
};
type Step = { label: string; status: "pass" | "fail" | "skip"; detail?: string };
type Att = { nonce: string; logHead: string; logSeq: string | null; quote: string; eventLog: Event[]; agent: string; anchor: string; logSigner: string; funder: string; info: { composeHash: string; appCompose: string | null; appId?: string | null; osImageHash?: string | null } };

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
const rpcHost = new URL(RPC).host;
const client = () => createPublicClient({ transport: http(RPC) });
const norm = (h: string) => h.replace(/^0x/, "").toLowerCase();

async function readAgent(registry: string) {
  return client().readContract({ address: registry as `0x${string}`, abi: parseAbi(["function agent() view returns (address)"]), functionName: "agent" });
}

async function run(release: Release): Promise<Step[]> {
  const out: Step[] = [];
  const push = (label: string, ok: boolean | null, detail?: string) => out.push({ label, status: ok === null ? "skip" : ok ? "pass" : "fail", detail });
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const att = await (await fetch(`${release.attestationUrl}?nonce=${nonce}`)).json() as Att;
  push("The quote is fresh: it answers our random nonce", norm(att.nonce) === nonce);

  const qvl = await import("@phala/dcap-qvl");
  const quote = Uint8Array.from((norm(att.quote).match(/../g) ?? []).map((b) => parseInt(b, 16)));
  try {
    const r = qvl.verify(quote, await qvl.getCollateral(qvl.PHALA_PCCS_URL, quote), Date.now() / 1000);
    push("Intel TDX quote verifies (collateral from Phala's PCCS)", ["UpToDate", "SWHardeningNeeded"].includes(r.status), `TCB status ${r.status}`);
  } catch (e) {
    push("Intel TDX quote verifies (collateral from Phala's PCCS)", false, (e as Error).message);
  }
  const rep = qvl.Quote.parse(quote).report;
  const td = rep.asTd10() ?? rep.asTd15()?.base;
  if (!td) { push("The quote is a TDX quote", false); return out; }
  push("Report data = sha256(nonce ‖ log head ‖ agent ‖ anchor ‖ log signer ‖ funder): the quote names the log and keys it attests", toHex(td.reportData).startsWith(await reportDataOf(nonce, att.logHead, att)), `log head ${att.logHead.slice(0, 12)}…, record ${att.logSeq ?? "—"}`);
  push("The attested log signing key = the released one", release.logSigner ? sameHex(att.logSigner, release.logSigner) : null, release.logSigner ? att.logSigner : "not in the release record");
  push("The attested funder = the released one (it may only queue game funds)", release.funder ? sameHex(att.funder, release.funder) : null, release.funder ? att.funder : "not in the release record");
  const m = release.measurements;
  if (m) for (const [k, v] of [["MRTD", td.mrTd], ["RTMR0", td.rtMr0], ["RTMR1", td.rtMr1], ["RTMR2", td.rtMr2]] as const) push(`${k} = the pinned launch value`, toHex(v) === norm(m[k.toLowerCase() as "mrtd"]));
  else push("Measurements = the pinned launch values", null, "not in the release record");
  const ev = await checkEventLog(att.eventLog, toHex(td.rtMr3));
  push("The event log replays to RTMR3; every event's digest matches its payload", !ev.issues.length, ev.issues.join("; "));
  push("The quote's compose-hash event = the app's compose hash", sameHex(ev.composeHash, att.info.composeHash));
  const idIssues = checkIdentity(ev, att.info, { dstackApp: release.dstackApp, osImageHash: m?.osImageHash ?? null });
  push("The quote's app-id = the released DstackApp; its OS image = the pinned one", release.dstackApp || m ? !idIssues.length : null, idIssues.join("; ") || (release.dstackApp ? undefined : "not in the release record"));
  const kpIssues = checkKeyProvider(ev.keyProvider, release.kmsKeyProvider);
  push("The quote's key-provider event names the released KMS (its CA public key)", release.kmsKeyProvider ? !kpIssues.length : null, kpIssues.join("; ") || undefined);
  const composeIssues = await checkCompose(att.info.appCompose, att.info.composeHash, release);
  push(COMPOSE_CLAIM, !composeIssues.length, composeIssues.join("; ") || `Fields Phala Cloud adds, inside the hash: ${PROVIDER_FIELDS}`);
  if (release.composeHash) push("Compose hash = the released one", sameHex(att.info.composeHash, release.composeHash));
  if (release.dstackApp) {
    const ok = await client().readContract({ address: release.dstackApp as `0x${string}`, abi: parseAbi(["function allowedComposeHashes(bytes32) view returns (bool)"]), functionName: "allowedComposeHashes", args: [`0x${norm(att.info.composeHash)}`] });
    push("The DstackApp on Ethereum allows this compose hash", ok, `read via ${rpcHost}`);
  } else push("The DstackApp on Ethereum allows this compose hash", null, "no DstackApp in the release record");
  if (att.info.osImageHash) {
    const ok = await client().readContract({ address: release.kmsAuth as `0x${string}`, abi: parseAbi(["function allowedOsImages(bytes32) view returns (bool)"]), functionName: "allowedOsImages", args: [`0x${norm(att.info.osImageHash)}`] });
    push("Phala's KmsAuth on Ethereum allows this OS image", ok, `read via ${rpcHost}`);
  } else push("Phala's KmsAuth on Ethereum allows this OS image", false, "the app does not name its OS image");
  const registry = release.registry?.address;
  if (registry) {
    const agent = await readAgent(registry);
    push("registry.agent() = the attested agent key", agent.toLowerCase() === att.agent.toLowerCase(), `${agent}, read via ${rpcHost}`);
  } else push("registry.agent() = the attested agent key", null, "no registry in the release record");
  return out;
}

export function ProofClient({ release }: { release: Release }) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!release.attestationUrl) {
    return <p className={`${ui.prose} ${ui.muted}`}>The enclave&apos;s attestation address is not in this release record, so there is nothing to check against.</p>;
  }
  const go = async () => {
    setBusy(true); setError(null); setSteps(null);
    try { setSteps(await run(release)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={s.run}>
      <button className={ui.button} type="button" onClick={go} disabled={busy}>{busy ? "Checking…" : "Verify now"}</button>
      {error && <p role="alert" className={s.fail}>Could not finish: {error}. The command-line verifier runs the same checks against Intel directly.</p>}
      {steps && (
        <ol className={s.steps} aria-live="polite">
          {steps.map((st) => (
            <li key={st.label} className={s.step} data-status={st.status}>
              <span className={s.mark}>{st.status === "pass" ? "Pass" : st.status === "fail" ? "Fail" : "Not yet"}</span>
              <span>{st.label}{st.detail && <span className={s.detail}>{st.detail}</span>}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

type Rec = { seq: string; kind: string; ref: string | null; body: string; eprev: string | null; ehash: string | null; esig: string | null };
/** The block where `root` was anchored on the registry (finalized history, public RPC), or null. */
async function anchoredAt(registry: Release["registry"], root: string) {
  if (!registry) return null;
  const logs = await client().getLogs({ address: registry.address as `0x${string}`, event: parseAbiItem("event Anchored(bytes32 indexed root, string uri)"), args: { root: `0x${norm(root)}` }, fromBlock: BigInt(registry.startBlock) });
  return logs[0] ? Number(logs[0].blockNumber) : null;
}

export function RecordViewer({ logSigner, registry, live }: { logSigner: string | null; registry: Release["registry"]; live: boolean }) {
  const [seq, setSeq] = useState("");
  const [res, setRes] = useState<{ rec: Rec; ehashOk: boolean; signer: string | null; mapper: boolean | null; block: number | null | "unread" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!live) return <p className={`${ui.prose} ${ui.muted}`}>The log viewer reads the live log, which this build does not serve.</p>;
  const load = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setRes(null);
    try {
      // a post link: the record holding the post's exact text, signed before it was sent
      const tweet = tweetIdOf(seq);
      const r = await fetch(tweet ? `/api/log/tweet/${tweet}` : `/api/log/${encodeURIComponent(seq.trim())}`);
      if (!r.ok) throw new Error(r.status === 404 ? (tweet ? "no post of DNA's with this id" : "no such record") : `HTTP ${r.status}`);
      const rec = (tweet ? (await r.json() as { attempt: Rec | null }).attempt : await r.json()) as Rec | null;
      if (!rec) throw new Error("no signed text before this post");
      const c = await checkRecord(rec);
      const doc = JSON.parse(rec.body) as { kind?: string; op?: string; args?: unknown[]; calldata?: string };
      const mapper = rec.kind === "anchor" && doc.kind === "intent" && doc.op ? mapperOk({ op: doc.op ?? "", args: doc.args ?? [], calldata: doc.calldata ?? "" }) : null;
      setRes({ rec, ...c, mapper, block: rec.ehash ? await anchoredAt(registry, rec.ehash).catch(() => "unread" as const) : null });
    } catch (err) { setError((err as Error).message); }
  };
  const signedByLog = res && sameHex(res.signer, logSigner);
  return (
    <div className={s.run}>
      <form className={s.form} onSubmit={load}>
        <label className={ui.label} htmlFor="seq">Record number or post link</label>
        <div className={s.row}>
          <input id="seq" className={ui.input} required value={seq} onChange={(e) => setSeq(e.target.value)} placeholder="a record number, or a link to one of DNA's posts" />
          <button className={ui.button} type="submit">Check</button>
        </div>
      </form>
      {error && <p role="alert" className={s.fail}>{error}</p>}
      {res && (
        <div className={s.record}>
          <ul className={s.steps}>
            <li className={s.step} data-status={res.ehashOk ? "pass" : "fail"}><span className={s.mark}>{res.ehashOk ? "Pass" : "Fail"}</span><span>Enclave hash = sha256(previous ‖ sha256(body)){!res.rec.ehash && <span className={s.detail}>not an enclave record</span>}</span></li>
            <li className={s.step} data-status={!res.signer ? "fail" : logSigner ? (signedByLog ? "pass" : "fail") : "skip"}><span className={s.mark}>{!res.signer ? "Fail" : logSigner ? (signedByLog ? "Pass" : "Fail") : "Not yet"}</span><span>Signed by the enclave's log key<span className={s.detail}>signer {res.signer ?? "none"}{logSigner ? `, log key ${logSigner}` : ", no log key in the release record"}</span></span></li>
            {res.block === "unread"
              ? <li className={s.step} data-status="skip"><span className={s.mark}>Unread</span><span>Anchor not checked: {rpcHost} refused the log search<span className={s.detail}>root 0x{norm(res.rec.ehash ?? "")}; the command-line verifier checks it with your own node</span></span></li>
              : <li className={s.step} data-status={res.block !== null ? "pass" : "skip"}><span className={s.mark}>{res.block !== null ? "Pass" : "Not yet"}</span><span>{res.block !== null ? `Anchored on Ethereum at block ${res.block.toLocaleString("en-US")}` : "Not anchored on its own yet"}<span className={s.detail}>{res.rec.ehash ? `root 0x${norm(res.rec.ehash)}` : ""}{res.block === null ? " (decision records are anchored before their op; others are covered by their day's anchored head)" : ""}</span></span></li>}
            {res.mapper !== null && <li className={s.step} data-status={res.mapper ? "pass" : "fail"}><span className={s.mark}>{res.mapper ? "Pass" : "Fail"}</span><span>Mapper re-run: its calldata is exactly registry.queue(op, args)</span></li>}
          </ul>
          <pre className={s.body}>{JSON.stringify(JSON.parse(res.rec.body), null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
