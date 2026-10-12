"use client";
// Word Hunt (contracts/src/games/word-hunt-free-guess-1000006/). Same rules as web/app/g/_template/page.tsx.
// Round state comes from the server's snapshot views (strings); per-player reads and sends go through tx.ts.
import { useState } from "react";
import { play, read, useGame } from "../../_ui/tx";
import game from "./game.json";
import s from "./page.module.css";

const ZERO_WORD = /^0x0*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PLAIN = /^[\x20-\x7e]+$/;

/** The guess as the contract compares it: lowercase, trimmed, 1 to 32 plain characters (one byte each). */
const tidy = (raw: string): string => raw.trim().toLowerCase();
const guessOk = (g: string): boolean => g.length >= 1 && g.length <= 32 && PLAIN.test(g);
const isZero = (v: string): boolean => ZERO_WORD.test(v) || v === "0";

export default function GamePage() {
  const snap = useGame();
  const [guessRaw, setGuessRaw] = useState("");
  const [who, setWho] = useState("");
  const [note, setNote] = useState("");
  const [wins, setWins] = useState("");
  const live = !!snap && snap.isGame && !snap.paused && !snap.retired;
  const guess = tidy(guessRaw);
  const player = who.trim();
  const roundId = snap?.views.roundId ?? "0";
  const endBlock = snap?.views.endBlock ?? "0";
  const open = snap?.views.roundOpen === "true";
  const winner = snap?.views.winner ?? "0x0";
  const closed = snap?.views.closed === "true";
  const won = !open && !isZero(winner);
  const haveRound = roundId !== "0";

  const commit = async () => {
    if (!guessOk(guess)) return setNote("Type the guess: 1 to 32 plain characters.");
    if (!ADDRESS.test(player)) return setNote("Type the wallet address you play from.");
    const h = await read<string>(game as never, "commitHashOf", [guess, player]);
    if (!h.ok) return setNote(h.why);
    const r = await play(game as never, "commitGuess", [h.value]);
    setNote(r.ok ? "Committed. Keep your guess, and reveal it from the same wallet after a block." : r.why);
  };

  const reveal = async () => {
    if (!guessOk(guess)) return setNote("Type the guess you committed: 1 to 32 plain characters.");
    const r = await play(game as never, "revealGuess", [guess]);
    setNote(r.ok ? "Sent. A right guess wins the round once your wallet's transaction is mined." : r.why);
  };

  const checkWins = async () => {
    if (!ADDRESS.test(player)) return setNote("Type the wallet address you play from.");
    const r = await read<bigint>(game as never, "wins", [player]);
    setWins(r.ok ? String(r.value) : "");
    if (!r.ok) setNote(r.why);
  };

  return (
    <main className={s.page}>
      <h1>{game.title}</h1>
      {!snap && <p>Reading the game from the chain did not work just now. Try again in a minute.</p>}
      {snap?.retired && <p>This game is retired. Anything you won stays claimable.</p>}
      {snap?.paused && <p>This game is paused.</p>}
      <p>Guess the hidden word. Commit a hash of your guess in one block, then reveal the guess from the same wallet in a later block. The first right reveal wins the round. Wins count on the leaderboard; there is no ETH prize.</p>
      <p>One open commit per address in each round. A commit cannot be reused by another address.</p>
      {!haveRound && <p>No round has been opened yet.</p>}
      {haveRound && open && <p className={s.round}>Round {roundId} is open until block {endBlock}.</p>}
      {haveRound && won && <p className={s.round}>Round {roundId} was won by {winner}.</p>}
      {haveRound && !open && !won && closed && <p className={s.round}>Round {roundId} closed with no winner.</p>}
      {haveRound && !open && !won && !closed && <p className={s.round}>Round {roundId} has passed its last block with no winner and is not closed yet.</p>}
      <div className={s.field}>
        <label htmlFor="guess">Your guess (up to 32 plain characters)</label>
        <input id="guess" className={s.input} value={guessRaw} maxLength={32} onChange={(e) => setGuessRaw(e.target.value)} />
      </div>
      <div className={s.field}>
        <label htmlFor="player">Your wallet address</label>
        <input id="player" className={s.input} value={who} onChange={(e) => setWho(e.target.value)} />
      </div>
      <div className={s.row}>
        <button className={s.button} onClick={commit} disabled={!live || !open}>Commit guess</button>
        <button className={s.button} onClick={reveal} disabled={!live || !open}>Reveal guess</button>
        <button className={s.button} onClick={checkWins} disabled={!snap}>Show my wins</button>
      </div>
      {wins !== "" && <p>Wins for this address: {wins}</p>}
      <p role="status">{note}</p>
      <p className={s.small}>Keep your guess until you reveal it, and reveal from the wallet you committed with. This game never asks for a deposit, a token allowance or a signed message. If your wallet asks for one here, reject it.</p>
    </main>
  );
}
