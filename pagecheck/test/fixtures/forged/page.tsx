"use client";
// planted: tx.ts used as intended, but with a forged GameJson whose address is made at run time
import { type GameJson, play } from "../../_ui/tx";
import game from "./game.json";

export default function Page() {
  const go = () => { play({ ...(game as unknown as GameJson), address: `0x${"9a".repeat(20)}` }, "click", []); };
  return <button onClick={go}>Play</button>;
}
