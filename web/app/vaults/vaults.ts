// The Genome Vaults' chain side, pure (no React, no network): the pinned contract, the four calls a visitor can send
// and the check every one of them passes before it reaches the wallet, and the 50-slot layout the page draws.
import { type Address, encodeFunctionData, type Hex, parseAbi } from "viem";

/** GenomeVaults on mainnet: the CREATE2 address contracts/script/GenomeVaultsDeploy.s.sol predicts (salt 0, art base
 *  https://genomedna.xyz/vaults/art/) and the runtime code hash it prints. Both change with any change to the
 *  contract or its constructor arguments: rerun the script and pin the new values before the site ships. */
export const VAULTS: Address = "0xA69836A27706ED710811250a4A0E62Fe475b04d9";
export const VAULTS_CODEHASH: Hex = "0x0d87ed9652054cba8730f679b22130b749c21627c10aeaa17927f9f25bb051ca";
export const MAX_LIVE = 50;
export const DEPOSIT = BigInt(200000) * BigInt(10) ** BigInt(18);
export const OPENSEA_URL = `https://opensea.io/assets/ethereum/${VAULTS}`;
/** The slot art the contract's tokenURI names (its constructor's art base): `<ART_BASE><slot>.jpg`. */
export const ART_BASE = "https://genomedna.xyz/vaults/art/";
export const artOf = (slot: number) => `${ART_BASE}${slot}.jpg`;

export const vaultsAbi = parseAbi([
  "function mint() returns (uint256)",
  "function burn(uint256 id)",
  "function claim(uint256 id) returns (uint256)",
  "function withdraw(address payable to)",
  "function liveCount() view returns (uint256)",
  "function nextId() view returns (uint256)",
  "function mintPaused() view returns (bool)",
  "function accPerToken() view returns (uint256)",
  "function tokenOfSlot(uint8 slot) view returns (uint256)",
  "function ownerOf(uint256 id) view returns (address)",
  "function earned(uint256 id) view returns (uint256)",
  "function pending(uint256 id) view returns (uint256)",
  "function owed(address) view returns (uint256)",
  "function isEligible(uint256 id) view returns (bool)",
]);
export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export type Tx = { to: Address; value: bigint; data: Hex };
/** Approve exactly DEPOSIT to the vaults, nothing more. */
export const approveCall = (token: Address): Tx => ({ to: token, value: BigInt(0), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [VAULTS, DEPOSIT] }) });
export const mintCall = (): Tx => ({ to: VAULTS, value: BigInt(0), data: encodeFunctionData({ abi: vaultsAbi, functionName: "mint" }) });
export const claimCall = (id: bigint): Tx => ({ to: VAULTS, value: BigInt(0), data: encodeFunctionData({ abi: vaultsAbi, functionName: "claim", args: [id] }) });
export const burnCall = (id: bigint): Tx => ({ to: VAULTS, value: BigInt(0), data: encodeFunctionData({ abi: vaultsAbi, functionName: "burn", args: [id] }) });
export const withdrawCall = (to: Address): Tx => ({ to: VAULTS, value: BigInt(0), data: encodeFunctionData({ abi: vaultsAbi, functionName: "withdraw", args: [to] }) });

const SEL = { mint: mintCall().data.slice(0, 10), claim: claimCall(BigInt(0)).data.slice(0, 10), burn: burnCall(BigInt(0)).data.slice(0, 10), withdraw: withdrawCall(VAULTS).data.slice(0, 10) };
/** The only transactions this page sends: the exact-amount approval of DNA to the vaults, or mint / claim(id) /
 *  burn(id) / withdraw(to) on the vaults. Never any value, never anywhere else. */
export function checkTx(tx: Tx, token: Address | null): boolean {
  if (tx.value !== BigInt(0)) return false;
  const to = tx.to.toLowerCase(), data = tx.data.toLowerCase();
  if (token && to === token.toLowerCase()) return data === approveCall(token).data.toLowerCase();
  if (to !== VAULTS.toLowerCase()) return false;
  const sel = data.slice(0, 10);
  if (sel === SEL.mint) return data.length === 10;
  if (sel === SEL.claim || sel === SEL.burn || sel === SEL.withdraw) return data.length === 10 + 64;
  return false;
}

export type Token = { id: bigint; slot: number; owner: Address; earned: bigint; pending: bigint; eligible: boolean };
export type Slot = { n: number; token: Token | null };
/** The 50 slots in order, each with its live token or free. */
export function slotsOf(tokens: Token[]): Slot[] {
  const by = new Map(tokens.map((t) => [t.slot, t]));
  return Array.from({ length: MAX_LIVE }, (_, i) => ({ n: i + 1, token: by.get(i + 1) ?? null }));
}

export const fmtEth = (wei: bigint, digits = 4) => (Number(wei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: digits });
