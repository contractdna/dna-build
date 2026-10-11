"use client";
// Template page for last player wins (contracts/src/games/last-buyer/). Copy this folder to web/app/g/<slug>/ with the
// contract; the build writes game.json. Same rules as web/app/g/_template/page.tsx. Buttons follow the browser's clock
// against the round's end, so none is offered when its call would revert.
import { useEffect, useState } from "react";
import { play, useGame } from "../../_ui/tx";
import game from "./game.json";
import s from "./page.module.css";

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
  const now = useNow();
  const live = !!snap && snap.isGame && !snap.paused && !snap.retired;
  const endsAt = Number(snap?.views.endsAt ?? "0");
  const running = endsAt > 0 && now < endsAt;
  const ended = endsAt > 0 && now >= endsAt;
  const send = async (fn: string) => {
    const r = await play(game as never, fn, []);
    setNote(r.ok ? "Sent. It counts once your wallet's transaction is mined." : r.why);
  };
  return (
    <main className={s.page}>
      <h1>{game.title}</h1>
      {!snap && <p>Reading the game from the chain did not work just now. Try again in a minute.</p>}
      {snap?.retired && <p>This game is retired. Anything you won stays claimable.</p>}
      {snap?.paused && <p>This game is paused.</p>}
      {snap && live && snap.freeBalanceWei === "0" && <p>Awaiting funding: the game opens once its first funds arrive.</p>}
      <p>Each play restarts the countdown. When it runs out, the last player wins a share of the pot. A round lasts at least a day, and a play in the last second still gives everyone a full countdown to answer.</p>
      {running && <p>This round ends {new Date(endsAt * 1000).toUTCString()} unless someone plays first.</p>}
      {ended && <p>This round has ended. Settle it to pay its winner; the next play starts a new round.</p>}
      {endsAt === 0 && <p>No round is running. The next play starts one.</p>}
      <div className={s.row}>
        <button className={s.button} onClick={() => send("play")} disabled={!live || ended}>Play</button>
        <button className={s.button} onClick={() => send("settle")} disabled={!live || !ended}>Settle the round</button>
        <button className={s.button} onClick={() => send("claim")} disabled={!snap}>Claim</button>
      </div>
      <p role="status">{note}</p>
      <p className={s.small}>This game never asks for a deposit, a token allowance or a signed message. If your wallet asks for one here, reject it.</p>
    </main>
  );
}
