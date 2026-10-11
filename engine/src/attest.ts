// GET /attestation?nonce=<hex, ≤ 32 bytes> (enclave build only; read-only, CORS-open): a fresh TDX quote whose
// report_data = sha256(nonce ‖ logHead ‖ agent ‖ anchor ‖ logSigner ‖ funder), the event log, the app's info (compose
// hash, app_compose, tcb_info) and those four addresses. The verifier (web /proof, scripts/verify.ts) checks the quote with
// Intel's collateral, the measurements against the pinned launch values, the compose hash against the DstackApp
// allow-list, the agent against registry.agent(), and log records against the attested log signer. logHead = the
// enclave's own head (boot-verified, advanced by its appends), never the DB's newest row.
import { zeroAddress } from "viem";
import { RPC_URLS } from "./config.ts";
import { dstack, hostsOf } from "./enclave.ts";
import { enclaveHead } from "./log.ts";
import { reportDataOf } from "./proof.ts";
import { signerAddress } from "./signed.ts";
import { addressOf } from "./tx.ts";

export const nonceOk = (n: string | null): n is string => !!n && /^(0x)?([0-9a-f]{2}){1,32}$/i.test(n);

export async function attestation(nonce: string) {
  const h = enclaveHead();
  const logHead = h?.ehash ?? "00".repeat(32);
  const keys = { agent: addressOf("agent") ?? zeroAddress, anchor: addressOf("anchor") ?? zeroAddress, logSigner: signerAddress(), funder: addressOf("funder") ?? zeroAddress };
  const reportData = reportDataOf(nonce, logHead, keys);
  const d = await dstack();
  const [q, info] = await Promise.all([d.getQuote(Buffer.from(reportData, "hex")), d.info()]);
  return {
    nonce: nonce.replace(/^0x/, "").toLowerCase(), logHead, logSeq: h?.seq ?? null, reportData,
    quote: q.quote, eventLog: JSON.parse(q.event_log || "[]"),
    info: {
      appId: info.app_id, instanceId: info.instance_id, composeHash: info.compose_hash, osImageHash: info.tcb_info.os_image_hash ?? null,
      appCompose: info.tcb_info.app_compose ?? null,
      tcb: { mrtd: info.tcb_info.mrtd, rtmr0: info.tcb_info.rtmr0, rtmr1: info.tcb_info.rtmr1, rtmr2: info.tcb_info.rtmr2, rtmr3: info.tcb_info.rtmr3 },
    },
    ...keys, rpcHosts: hostsOf(RPC_URLS),
  };
}
