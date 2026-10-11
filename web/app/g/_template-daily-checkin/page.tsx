"use client";
// Template page for the daily check-in (contracts/src/games/daily-checkin/). Copy this folder to web/app/g/<slug>/ with
// the contract; the build writes game.json. Same rules as web/app/g/_template/page.tsx. Days come from the browser's
// clock (the server's snapshot is as old as the page).
import { useEffect, useState } from "react";
import { play, useGame } from "../../_ui/tx";
import game from "./game.json";
import s from "./page.module.css";

const DAY = 86_400;
/** The clock in seconds, ticking every 5 s. */
const useNow = () => {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5_000);
    return () => clearInterval(t);
  }, []);
  return now;
};
const label = (day: number) => new Date(day * DAY * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export default function GamePage() {
  const snap = useGame();
  const [note, setNote] = useState("");
  const live = !!snap && snap.isGame && !snap.paused && !snap.retired;
  const today = Math.floor(useNow() / DAY);
  const collectDays = Number(snap?.views.COLLECT_DAYS ?? "0");
  // a day can be collected from the day after it until COLLECT_DAYS days after that: today - COLLECT_DAYS .. yesterday
  const collectable = Array.from({ length: collectDays }, (_, i) => today - 1 - i).filter((d) => d >= 0);
  const send = async (fn: string, args: unknown[] = []) => {
    const r = await play(game as never, fn, args);
    setNote(r.ok ? "Sent. It counts once your wallet's transaction is mined." : r.why);
  };
  return (
    <main className={s.page}>
      <h1>{game.title}</h1>
      {!snap && <p>Reading the game from the chain did not work just now. Try again in a minute.</p>}
      {snap?.retired && <p>This game is retired. Anything you won stays claimable.</p>}
      {snap?.paused && <p>This game is paused.</p>}
      {snap && live && snap.freeBalanceWei === "0" && <p>Awaiting funding: the game opens once its first funds arrive.</p>}
      <p>Check in once a day (days run midnight to midnight UTC). When a day ends, its check-ins split a small share of the pot. Collect your share within {collectDays} days, then claim it.</p>
      <div className={s.row}>
        <button className={s.button} onClick={() => send("checkIn")} disabled={!live}>Check in today</button>
        <button className={s.button} onClick={() => send("claim")} disabled={!snap}>Claim</button>
      </div>
      <p>Collect a day you checked in on:</p>
      <div className={s.row}>
        {collectable.map((d) => (
          <button key={d} className={s.button} onClick={() => send("collect", [BigInt(d)])} disabled={!snap || snap.paused}>{label(d)}</button>
        ))}
      </div>
      <p role="status">{note}</p>
      <p className={s.small}>This game never asks for a deposit, a token allowance or a signed message. If your wallet asks for one here, reject it.</p>
    </main>
  );
}
