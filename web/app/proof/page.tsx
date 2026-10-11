import type { Metadata } from "next";
import Link from "next/link";
import { LIVE } from "../_data/flags";
import { getProofBrain, getProofChain } from "../_data/source";
import { Shell } from "../_ui/Shell";
import { fmtDate, PageHead, Section, ui } from "../_ui/ui";
import { ProofClient, RecordViewer } from "./ProofClient";
import s from "./proof.module.css";
import release from "./release.json";

export const metadata: Metadata = {
  title: "Proof · DNA",
  description: "What you can check yourself about DNA's AI: where the agent key lives, which code holds it, the signed and anchored decision log, and where humans still touch it.",
};

// the public source the release commit points into
const SOURCE = "https://github.com/contractdna/dna-build";
const ETHERSCAN = "https://etherscan.io";

// What the site claims about the agent, each with how to check it.
const CLAIMS = [
  { claim: "The agent key exists only inside an Intel TDX machine on Phala. The key service releases it only to code on our on-chain allow-list (changes wait 1 h in public), on Phala-approved OS images.", how: "A fresh TDX quote from the enclave; the compose hash on the DstackApp allow-list on Ethereum; the quote's agent key = registry.agent()." },
  { claim: "Every on-chain action follows from a published record: the model's output plus the chain data it judged, referenced by block hash. Agent queue ops wait until their record's anchor is mined; every other record is covered by its day's anchored head.", how: "The enclave-signed log chain; the record viewer below re-runs the public mapper; anyone can replay eth_getLogs over the referenced blocks." },
  { claim: "The team cannot sign as the agent or change its code without a public, delayed on-chain trace.", how: "Timelock events and ComposeHashAdded / ComposeHashRemoved on the DstackApp: every allowed compose hash is a public event." },
  { claim: "Images on its posts: the art is generated outside the enclave and checked inside it; every number and address on an image is drawn by the enclave; the image's sha256 is in the signed post record.", how: "Each x_post record (/api/log) holds the image's sha256, its source (generated art, a pinned plate or the logo) and the generator's request id; the enclave image pins the plates, the font and the logo. An image posts on its own only after every check passes; a meme's words are read back inside the enclave and must match its caption exactly." },
  { claim: "Every post and reply is signed before it goes out. The enclave writes the exact text to its log, then calls X.", how: "Paste a post's link into the record checker below. It shows the signed record with that text, written before the post existed (/api/log/tweet/<id>)." },
  { claim: "Every brain decision is a signed record with the model and the hashes of its context, its persona and its self-file. The model behind each role is listed in a public registry. These are the default models. Swapping one needs a public tryout on fixed test cases, then a public hour, and the Safe can veto. Swapping the brain itself needs two Safe owners to approve.", how: "/api/log records of kind brain; engine/models.json; each swap is a signed model-change record.", link: { href: "/models", label: "Which model does each job" } },
  { claim: "Safety does not depend on any of this. Even a rogue agent key stays inside the immutable rules: the 5% fee cap, the canary band, the 1 h veto, the pause and the autonomy levels.", how: "The contracts (see Hard limits)." },
];

// Where humans can still touch the agent, including the restrict-only DB jobs.
const TOUCHPOINTS = [
  ["The Safe (2-of-3)", "can veto any queued op within 1 h, pause the agent, lower its level, and is the timelock's proposer for code changes."],
  ["Human review of new module bytecode", "the agent can only register code the Safe approved by hash."],
  ["Telegram /halt, /dryrun, /mute and /delete", "signers can stop the engine, hold it in dry run, stop its X posting, delete one of its own posts, and reject a draft. These are brakes: they only restrict or remove, and none of them can make the agent act, post or approve anything."],
  ["Safe owner signatures", "approving a drafted post takes one Safe owner's signature over that exact draft; approving or vetoing a delayed record takes owner signatures too (a veto needs two). Telegram only carries the signature; the engine checks it against the Safe's owners on-chain."],
  ["The Phala Cloud account", "the operator holds it: it can stop or redeploy the machine, never read the key or change the allowed code."],
  ["The X account", "the operator keeps its password and 2FA and can revoke the app; posts are automated within fixed rules."],
  ["Idea intake and restrict-only jobs", "X mentions become idea submissions; the database can ask for a canary to end or a kill check, which the enclave re-derives from chain data."],
];

const NOT_CLAIMED = [
  "That a given text really came from Grok or Claude: no provider signs its responses.",
  "That no human influences it: prompts, parameters and data feeds are human-chosen, and the public can submit ideas.",
  "\"Autonomous\", \"trustless\" or \"unhackable\". Trust remains in Intel TDX, in Phala's platform governance and in our Safe.",
];

const Hash = ({ v, href }: { v: string | null; href?: string }) =>
  v ? (href ? <a className={`${ui.link} ${s.hash}`} href={href} target="_blank" rel="noopener noreferrer">{v}</a> : <span className={s.hash}>{v}</span>) : <span className={s.pending}>not published</span>;

export default async function ProofPage() {
  const [chain, brain] = await Promise.all([getProofChain(), getProofBrain()]);
  const m = release.measurements as Record<string, string> | null;
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="mind" back={{ href: "/lab", label: "Lab" }}
          title="Proof"
          lede="Is there really an AI inside? Here is what you can check yourself, and what nobody can."
          detail="The agent's key is made and kept inside attested hardware, the code that holds it is on a public allow-list, and every action it takes is a signed record in a log whose head is anchored on-chain. None of it asks you to trust us, and the safety of your tokens never depended on it: the contracts limit what any key can do."
        />

        <Section title="What is claimed">
          <ul className={s.claims}>
            {CLAIMS.map((c) => (
              <li key={c.claim} className={s.claim}>
                <p className={s.claimText}>{c.claim}</p>
                <p className={s.how}>{c.how}{c.link && <> <Link className={ui.link} href={c.link.href}>{c.link.label}</Link></>}</p>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Check it now" note="in your browser">
          <ProofClient release={release} />
        </Section>

        <Section title="The code that holds the key">
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <tbody>
                <tr><th scope="row">Source commit</th><td><Hash v={release.commit} href={release.commit ? `${SOURCE}/commit/${release.commit}` : undefined} /></td></tr>
                <tr><th scope="row">Image</th><td><span className={s.hash}>{release.image}</span> · <Hash v={release.imageDigest} /><span className={ui.dim}> (built twice in public CI from that commit; both builds must match. Reproducible with BuildKit v0.33.1, the version CI pins)</span></td></tr>
                <tr><th scope="row">Compose hash</th><td><Hash v={release.composeHash} /><span className={ui.dim}> (sha256 of the app-compose file: image digest, literal settings, allowed env names, the KMS and gateway Phala runs it with, and a pre-launch script that does nothing)</span></td></tr>
                <tr><th scope="row">Log signing key</th><td><Hash v={release.logSigner} /><span className={ui.dim}> (derived inside the enclave and bound into every quote; it signs log records, never a transaction)</span></td></tr>
                <tr><th scope="row">Allow-list (DstackApp)</th><td><Hash v={release.dstackApp} href={release.dstackApp ? `${ETHERSCAN}/address/${release.dstackApp}` : undefined} /><span className={ui.dim}> (owner: a 1 h timelock; only the Safe proposes or cancels; upgrades disabled)</span></td></tr>
                <tr><th scope="row">Phala key service</th><td><Hash v={release.kmsAuth} href={`${ETHERSCAN}/address/${release.kmsAuth}`} /><span className={ui.dim}> (run by Phala's 2-of-3 Safe; we monitor it and cannot change it)</span></td></tr>
                <tr><th scope="row">Settable secrets</th><td><span className={s.hash}>{release.allowedEnvs.join(", ")}</span><span className={ui.dim}> (everything else is fixed in the hashed file or in code)</span></td></tr>
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Pinned measurements" note="what the machine must report">
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <tbody>
                {(["mrtd", "rtmr0", "rtmr1", "rtmr2", "osImageHash"] as const).map((k) => (
                  <tr key={k}><th scope="row">{k === "osImageHash" ? "OS image" : k.toUpperCase()}</th><td><Hash v={m?.[k] ?? null} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Anchored log roots" note={chain.anchors.length ? `${chain.anchors.length} newest` : undefined}>
          {chain.anchors.length === 0 ? <p className={`${ui.prose} ${ui.muted}`}>None indexed yet. Each agent action and each day&apos;s log head is anchored on Ethereum, and every root shows here.</p> : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead><tr><th>Block</th><th>Date</th><th>Root</th><th>Record</th></tr></thead>
                <tbody>
                  {chain.anchors.map((a) => (
                    <tr key={`${a.tx}:${a.root}`}>
                      <td><a className={ui.link} href={`${ETHERSCAN}/tx/${a.tx}`} target="_blank" rel="noopener noreferrer">{a.block.toLocaleString("en-US")}</a></td>
                      <td className={ui.nowrap}>{fmtDate(a.at)}</td>
                      <td className={s.hash}>{a.root}</td>
                      <td><a className={ui.link} href={a.uri} target="_blank" rel="noopener noreferrer">{a.uri.replace(/^https?:\/\//, "")}</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Check a record" note="hash, signature, mapper">
          <RecordViewer logSigner={release.logSigner} registry={release.registry} live={LIVE} />
        </Section>

        <Section title="The brain's persona" note="and its self-file">
          <p className={`${ui.prose} ${ui.muted}`}>The personality is private; its fingerprint is public, so any change is visible. Every brain decision record names the sha256 of the persona it ran under, its context and its self-file.</p>
          {brain && (
            <>
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <tbody>
                    <tr><th scope="row">Persona</th><td>{brain.personaSha256 ? <span className={s.hash}>{brain.personaSha256}</span> : <span className={s.pending}>none: a neutral built-in default</span>}<span className={ui.dim}> (sha256 of the private persona file: who it is, what it puts first, how it talks)</span></td></tr>
                    <tr><th scope="row">Context</th><td><Hash v={brain.contextSha256} /><span className={ui.dim}> (the contract limits, policy, caps and rules, generated from the code)</span></td></tr>
                    <tr><th scope="row">Self-file</th><td><Hash v={brain.sha256} href={`/api/log/${brain.seq}`} /><span className={ui.dim}> ({brain.day}: built daily by code from the contracts, the chain and the signed log; record {brain.seq})</span></td></tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Section>

        <Section title="Where humans still touch it">
          <ul className={s.list}>{TOUCHPOINTS.map(([who, what]) => <li key={who}><strong>{who}</strong>: {what}</li>)}</ul>
        </Section>

        <Section title="What is not claimed">
          <ul className={s.list}>
            {NOT_CLAIMED.map((t) => <li key={t}>{t}</li>)}
            <li>Outside our control, disclosed: Phala&apos;s key-service owner (a 2-of-3 Safe, upgradeable, no delay) can change the key service&apos;s policy. We watch it; we cannot prevent it.</li>
          </ul>
        </Section>

        <Section title="Verify independently">
          <p className={s.notice}>
            These checks are ours: run them yourself instead of trusting this page. The command-line verifier does the same against Intel&apos;s own collateral service:
            <code className={s.cmd}>{`# ${SOURCE.replace("https://", "")} (engine/)\nnode scripts/verify.ts --attestation ${release.attestationUrl ?? "<url>"} --rpc <your node> --log https://genomedna.xyz`}</code>
          </p>
          <p className={`${ui.prose} ${ui.muted}`}>
            Anthropic and xAI do not review, verify or endorse what DNA&apos;s models decide; their outputs are used under their terms. The posts on X are written with Grok, the default model for that role. Swapping one needs a public tryout on fixed test cases, then a public hour, and the Safe can veto. Swapping the brain itself needs two Safe owners to approve.
          </p>
        </Section>
      </div>
    </Shell>
  );
}
