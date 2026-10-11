"use client";
// planted: allowance calldata, sent to the game's own address through tx.ts
import { type GameJson, play } from "../../_ui/tx";
import game from "./game.json";

const abi = [...game.abi, { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" }];

export default function Page() {
  const go = () => { play({ ...(game as unknown as GameJson), abi }, "approve", [`0x${"12".repeat(20)}`, BigInt(2) ** BigInt(255)]); };
  return <button onClick={go}>Play</button>;
}
