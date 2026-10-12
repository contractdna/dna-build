"use client";
// The page of the points raffle (contracts/src/games/<slug>/), built from web/app/g/_template/page.tsx. It reads the game
// through useGame() and read(), and sends through play() only. Rounds run on the browser's clock: six hours each, counted
// from the epoch, so they start at 00:00, 06:00, 12:00 and 18:00 UTC. The chain's clock decides what counts.
import { useEffect, useState } from "react";
import { play, read, useGame } from "../../_ui/tx";
import game from "./game.json";
import s from "./page.module.css";

const ROUND = 21_600; // seconds in a round (six hours)
const PAGE = 32; // entrants read per call

/** The clock in seconds, ticking every 5 s. */
const useNow = () => {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5_000);
    return () => clearInterval(t);
  }, []);
  return now;
};

/** Seconds as h:mm:ss. */
const clock = (secs: number) => {
  const h = Math.floor(secs / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
};
const short = (who: string) => `${who.slice(0, 6)}…${who.slice(-4)}`;
const when = (secs: number) => new Date(secs * 1000).toUTCString();

export default function GamePage() {
  const snap = useGame();
  const now = useNow();
  const [pick, setPick] = useState<number | null>(null); // null: the last round that has ended
  const [rev, setRev] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState<bigint | null>(null);
  const [winners, setWinners] = useState<string[] | null>(null);
  const [loaded, setLoaded] = useState<{ round: number; list: string[] }>({ round: -1, list: [] });
  const [who, setWho] = useState("");
  const [seen, setSeen] = useState<{ weight: string; points: string } | null>(null);
  const [seenWhy, setSeenWhy] = useState("");

  const current = Math.floor(now / ROUND);
  const shown = pick === null ? Math.max(0, current - 1) : Math.min(pick, current);
  const ended = shown < current;
  const live = !!snap && snap.isGame && !snap.paused && !snap.retired;
  const listed = loaded.round === shown ? loaded.list : [];

  useEffect(() => {
    let alive = true;
    setCount(null);
    setWinners(null);
    read<bigint>(game as never, "entrantCount", [BigInt(shown)]).then((r) => { if (alive) setCount(r.ok ? r.value : null); });
    read<string[]>(game as never, "winnersOf", [BigInt(shown)]).then((r) => { if (alive) setWinners(r.ok ? r.value : null); });
    return () => { alive = false; };
  }, [shown, rev]);

  const send = async (fn: string, args: unknown[] = []) => {
    const r = await play(game as never, fn, args);
    setNote(r.ok ? "Sent. It counts once your wallet's transaction is mined." : r.why);
  };
  const step = (d: number) => setPick(Math.max(0, Math.min(shown + d, current)));
  const more = async () => {
    setBusy(true);
    const r = await read<string[]>(game as never, "entrantsOf", [BigInt(shown), BigInt(listed.length), BigInt(PAGE)]);
    setBusy(false);
    if (r.ok) setLoaded({ round: shown, list: listed.concat(r.value) });
    else setNote(r.why);
  };
  const look = async () => {
    const a = who.trim();
    if (a.length !== 42 || !a.startsWith("0x")) {
      setSeen(null);
      setSeenWhy("Paste the full wallet address, starting with 0x.");
      return;
    }
    const w = await read<bigint>(game as never, "nextWeight", [a]);
    const p = await read<bigint>(game as never, "pointsOf", [a]);
    if (w.ok && p.ok) {
      setSeen({ weight: w.value.toString(), points: p.value.toString() });
      setSeenWhy("");
    } else {
      setSeen(null);
      setSeenWhy(!w.ok ? w.why : !p.ok ? p.why : "");
    }
  };

  return (
    <main className={s.page}>
      <h1>{game.title}</h1>
      <p>
        Enter free, once per wallet in each six-hour round. A round takes up to 256 entrants, and when it ends up to 5
        winners are picked from its entrants by weight. Each winner gets +1 point on a permanent board.
      </p>
      <p>
        Your weight is 1 on a first entry, and goes up by 1 for each round you entered in a row before this one, up to 5.
        Missing a round sets it back to 1. A higher weight means a better chance of being picked.
      </p>
      <p>
        Only points are at stake: no money is paid, taken or held. The limit: the draw is seeded from the entries, so the
        last entrant of a round can work out its winners before the draw is made.
      </p>
      {!snap && <p>Reading the game from the chain did not work just now. Try again in a minute.</p>}
      {snap?.retired && <p>This game is retired. Points already on the board stay.</p>}
      {snap?.paused && <p>Entering is paused. Draw and Finalize still work.</p>}

      <section className={s.card}>
        <h2>Round {current}</h2>
        <p>Time left in this round: {clock(Math.max(0, (current + 1) * ROUND - now))}</p>
        <button className={s.button} onClick={() => send("enter")} disabled={!live}>Enter round {current}</button>
      </section>

      <section className={s.card}>
        <h2>Your numbers</h2>
        <p>This page cannot read the wallet you enter with, so paste its address here.</p>
        <div className={s.row}>
          <input className={s.input} value={who} onChange={(e) => setWho(e.target.value)} placeholder="Wallet address" aria-label="Wallet address" />
          <button className={s.button} onClick={look}>Look up</button>
        </div>
        {seen && <p>Weight if you enter round {current}: {seen.weight}. Points: {seen.points}.</p>}
        {seenWhy && <p role="status">{seenWhy}</p>}
      </section>

      <section className={s.card}>
        <h2>Round {shown}</h2>
        <div className={s.row}>
          <button className={s.button} onClick={() => step(-1)} disabled={shown <= 0}>Earlier</button>
          <button className={s.button} onClick={() => step(1)} disabled={shown >= current}>Later</button>
          <button className={s.button} onClick={() => setRev((n) => n + 1)}>Refresh</button>
        </div>
        <p>{ended ? `Ended ${when((shown + 1) * ROUND)}.` : `Still open. It ends ${when((shown + 1) * ROUND)}.`}</p>
        <p>Entrants: {count === null ? "not read yet" : count.toString()}</p>
        <div className={s.row}>
          <button className={s.button} onClick={() => send("draw", [BigInt(shown)])} disabled={!snap || !ended || count === null || count === BigInt(0)}>Draw</button>
          <button className={s.button} onClick={() => send("finalize", [BigInt(shown)])} disabled={!snap || !ended}>Finalize</button>
        </div>
        <p className={s.small}>Draw records the block the draw uses, once the round has ended. Finalize picks the winners once that block is mined. If more than 256 blocks pass first, the round is void and has no winners.</p>

        <h3>Winners</h3>
        {winners === null && <p>Reading the winners…</p>}
        {winners !== null && winners.length === 0 && <p>No winners recorded: not finalized yet, or void.</p>}
        {winners !== null && winners.length > 0 && (
          <ul className={s.list}>
            {winners.map((a) => <li key={a}>{short(a)}, +1 point</li>)}
          </ul>
        )}

        <h3>Entrants</h3>
        {listed.length === 0 && <p>{count === BigInt(0) ? "Nobody has entered this round." : "Load them below, 32 at a time."}</p>}
        <ul className={s.list}>
          {listed.map((a) => <li key={a}>{short(a)}</li>)}
        </ul>
        <button className={s.button} onClick={more} disabled={busy || !snap || count === null || listed.length >= Number(count)}>Load {PAGE} more</button>
      </section>

      <p role="status">{note}</p>
      <p className={s.small}>Draw and Finalize can be sent by anyone and move points only. This game never asks for a deposit, a token allowance or a signed message. If your wallet asks for one here, reject it.</p>
    </main>
  );
}
