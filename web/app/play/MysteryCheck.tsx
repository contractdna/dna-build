"use client";
// In-browser check of a revealed mystery: keccak256(salt ‖ payload) must equal the commitment sealed on-chain
// at least two days earlier (exactly MutationBoard.reveal's rule). Nothing is fetched: the three values come from chain events.
import { useState } from "react";
import { concat, type Hex, hexToString, keccak256 } from "viem";
import { ui } from "../_ui/ui";
import s from "./play.module.css";

export function MysteryCheck({ commitment, salt, payload }: { commitment: Hex; salt: Hex; payload: Hex }) {
  const [ok, setOk] = useState<boolean | null>(null);
  let text = payload;
  try { text = hexToString(payload) as Hex; } catch { /* binary payload: show the hex */ }
  return (
    <div className={s.check}>
      <p className={s.mono}>payload {text}</p>
      <button className={ui.button} type="button" onClick={() => setOk(keccak256(concat([salt, payload])) === commitment.toLowerCase())}>Check the seal in my browser</button>
      {ok !== null && <p role="status" className={ok ? s.pass : s.failText}>{ok ? "Matches: this is exactly what was sealed." : "Does not match the sealed commitment."}</p>}
    </div>
  );
}
