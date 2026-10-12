import type { Metadata } from "next";
import { LIVE } from "../_data/flags";
import { getPool } from "../_data/source";
import { Shell } from "../_ui/Shell";
import { PoisonNote, WalletBar, WalletProvider } from "../_ui/Wallet";
import { PageHead, Section, ui } from "../_ui/ui";
import { DEPOSIT, fmtEth, MAX_LIVE, OPENSEA_URL, VAULTS } from "./vaults";
import { VaultsPanel } from "./VaultsPanel";
import s from "./vaults.module.css";

export const metadata: Metadata = {
  title: "Genome Vaults · DNA",
  description: "Fifty vaults. Lock 200,000 DNA to mint one, burn it anytime to get your DNA back. Vaults share whatever ETH the Safe sends to fund(), split equally across eligible vaults. Nothing is promised.",
};

const RULES = [
  ["Mint", `Approve exactly ${fmtEth(DEPOSIT, 0)} DNA, then mint. The DNA is locked in the vaults contract and nowhere else. ${MAX_LIVE} slots, first come, first served.`],
  ["Burn", "The owner burns a vault at any time and gets the 200,000 DNA back with the vault's unclaimed ETH in the same transaction. A burned slot goes to the next mint."],
  ["Rewards", "Vaults share whatever ETH the Safe sends to fund(), split equally across eligible vaults, and each owner claims. A new vault joins at the next fund and earns from every fund after that. Nothing is promised."],
  ["Transfer", "A standard ERC-721: it can be sold or sent. Unclaimed ETH travels with the vault, so a buyer gets it."],
  ["Admin", "No owner mint, no upgrade, nobody can take deposited DNA except the vault's owner by burning. The Safe can pause new mints only; it can never block a burn or a claim."],
  ["Art", "Each slot has its own image; the metadata is on-chain, with a strand that grows with the ETH the vault has earned and its age. All 50 vaults are equal."],
];

export default async function VaultsPage() {
  const pool = await getPool();
  const token = pool?.token ?? null;
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="treasury" back={{ href: "/play", label: "Play" }} sample={false}
          title="Genome Vaults"
          lede="Lock 200,000 DNA to mint. Burn anytime to get your DNA back."
          detail="Vaults share whatever ETH the Safe sends to fund(), split equally across eligible vaults. A new vault joins at the next fund and earns from every fund after that. Nothing is promised."
        />

        <Section title="The 50 slots" note={LIVE ? <a className={ui.link} href={OPENSEA_URL} target="_blank" rel="noopener noreferrer">collection on OpenSea</a> : "pre-launch"}>
          <WalletProvider>
            <WalletBar token={token} />
            <VaultsPanel token={token} />
          </WalletProvider>
          <p className={`${ui.prose} ${ui.muted}`}>
            Every button here sends a transaction with no ETH, to the vaults contract or the exact 200,000 DNA approval it needs. No signature, no open approval.{" "}
            <a className={ui.link} href={`https://etherscan.io/address/${VAULTS}`} target="_blank" rel="noopener noreferrer">The contract on Etherscan</a>.
          </p>
          <PoisonNote />
        </Section>

        <Section title="How it works">
          <dl className={s.rules}>
            {RULES.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        </Section>
      </div>
    </Shell>
  );
}
