"use client";
// Template page for the raffle (contracts/src/games/raffle/; held, not offered to the sequencer). Copy this folder to
// web/app/g/<slug>/ with the contract; the build writes game.json. Same rules as web/app/g/_template/page.tsx. The
// ticket code is drawn and hashed here, never sent anywhere before its reveal, and shown once: the page keeps nothing
// (no storage), so the player keeps it to reveal. Buttons follow the browser's clock against the round's windows.
import { useEffect, useState } from "react";
import { hashSecret, play, useGame } from "../../_ui/tx";
import game from "./game.json";
import s from "./page.module.css";

const newCode = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const when = (secs: number) => new Date(secs * 1000).toUTCString();
/** The clock in seconds, ticking every 5 s. */
const useNow = () => {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5_000);
    return () => clearInterval(t);
  }, []);
  return now;
};

export default function GamePage() {
  const snap = useGame();
  const [note, setNote] = useState("");
  const [ticket, setTicket] = useState("");
  const [code, setCode] = useState("");
  const now = useNow();
  const live = !!snap && snap.isGame && !snap.paused && !snap.retired;
  const entryEnds = Number(snap?.views.entryEnds ?? "0");
  const revealEnds = entryEnds + Number(snap?.views.REVEAL_WINDOW ?? "0");
  const entering = entryEnds === 0 || now < entryEnds;
  const revealing = entryEnds > 0 && now >= entryEnds && now < revealEnds;
  const drawable = entryEnds > 0 && now >= revealEnds;
  const said = (r: { ok: boolean; why?: string }) => setNote(r.ok ? "Sent. It counts once your wallet's transaction is mined." : String(r.why));
  const enter = async () => {
    const t = newCode();
    const h = hashSecret(t);
    if (!h) return setNote("Could not draw a ticket code.");
    setTicket(t);
    said(await play(game as never, "enter", [h]));
  };
  const reveal = async () => {
    const c = code.trim().toLowerCase();
    if (!hashSecret(c)) return setNote("A ticket code is 0x and 64 letters or digits.");
    said(await play(game as never, "reveal", [c]));
  };
  return (
    <main className={s.page}>
      <h1>{game.title}</h1>
      {!snap && <p>Reading the game from the chain did not work just now. Try again in a minute.</p>}
      {snap?.retired && <p>This game is retired. Anything you won stays claimable.</p>}
      {snap?.paused && <p>This game is paused.</p>}
      {snap && live && snap.freeBalanceWei === "0" && <p>Awaiting funding: the game opens once its first funds arrive.</p>}
      <p>Enter once per round with a ticket code only you know. After entries close, reveal your code: the codes revealed pick the winner, who wins a share of the pot. If you do not reveal, your entry does not count.</p>
      {entryEnds > 0 ? <p>Entries close {when(entryEnds)}. Reveals close {when(revealEnds)}. Entrants so far: {snap?.views.entrants}.</p> : <p>No round is running. The first entry starts one.</p>}
      <div className={s.row}>
        <button className={s.button} onClick={enter} disabled={!live || !entering}>Enter</button>
        <button className={s.button} onClick={() => play(game as never, "settle", []).then(said)} disabled={!live || !drawable}>Draw the winner</button>
        <button className={s.button} onClick={() => play(game as never, "claim", []).then(said)} disabled={!snap}>Claim</button>
      </div>
      {ticket && <p className={s.ticket}>Your ticket code: <code>{ticket}</code>. Keep it: you need it to reveal, and this page will not show it again.</p>}
      <div className={s.row}>
        <input className={s.input} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Your ticket code" aria-label="Your ticket code" />
        <button className={s.button} onClick={reveal} disabled={!snap || !revealing}>Reveal</button>
      </div>
      <p role="status">{note}</p>
      <p className={s.small}>This game never asks for a deposit, a token allowance or a signed message. If your wallet asks for one here, reject it.</p>
    </main>
  );
}
