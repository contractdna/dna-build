"use client";
// The starting point of a Sequencer game's page (copied to web/app/g/<slug>/; `_template` itself is never routed).
// Rules a page follows (the gates check them): it imports only react, next/link, next/image, ../../_ui/tx,
// ../../_ui/ui and its own files; it reaches the chain only through useGame() (the server's snapshot) and play()/read()
// from tx.ts; no globals, no network, no frames, no storage, no addresses but game.json's.
import { useState } from "react";
import { play, useGame } from "../../_ui/tx";
import game from "./game.json";
import s from "./page.module.css";

export default function GamePage() {
  const snap = useGame();
  const [note, setNote] = useState("");
  const live = !!snap && snap.isGame && !snap.paused && !snap.retired;
  const act = async () => {
    const r = await play(game as never, "click", []);
    setNote(r.ok ? "Sent. It counts once your wallet's transaction is mined." : r.why);
  };
  return (
    <main className={s.page}>
      <h1>{game.title}</h1>
      {!snap && <p>Reading the game from the chain did not work just now. Try again in a minute.</p>}
      {snap?.retired && <p>This game is retired. Anything you won stays claimable.</p>}
      {snap?.paused && <p>This game is paused.</p>}
      {snap && live && snap.freeBalanceWei === "0" && <p>Awaiting funding: the game opens once its first funds arrive.</p>}
      <button className={s.button} onClick={act} disabled={!live}>Play</button>
      <p role="status">{note}</p>
      <p className={s.small}>This game never asks for a deposit, a token allowance or a signed message. If your wallet asks for one here, reject it.</p>
    </main>
  );
}
