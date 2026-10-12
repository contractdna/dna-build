"use client";
// The Word Hunt page (contracts/src/games/word-hunt-free-guess-1000006/). Built from web/app/g/_template and changed
// for a commit-reveal guess. Rules a page follows (the gates check them): it imports only react, ../../_ui/tx and its
// own files; it reaches the chain only through useGame() and play()/read() from tx.ts; no globals, no network, no
// storage, no addresses but game.json's. The page stores nothing: the player keeps the guess until the reveal.
import { useState } from "react";
import { play, read, useGame } from "../../_ui/tx";
import game from "./game.json";
import s from "./page.module.css";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const NONE = /^0x0+$/;

export default function GamePage() {
  const snap = useGame();
  const [guess, setGuess] = useState("");
  const [player, setPlayer] = useState("");
  const [note, setNote] = useState("");
  const [mine, setMine] = useState("");
  const live = !!snap && snap.isGame && !snap.paused && !snap.retired;
  const word = guess.trim().toLowerCase();
  const who = player.trim();
  const goodWord = word.length > 0 && word.length <= 32;
  const goodPlayer = ADDR.test(who);
  const started = Number(snap?.views.round ?? "0") > 0;
  const winner = snap?.views.winner ?? "";
  const won = winner !== "" && !NONE.test(winner);

  const commit = async () => {
    const h = await read<string>(game as never, "hashGuess", [word, who]);
    if (!h.ok) {
      setNote(h.why);
      return;
    }
    const r = await play(game as never, "commitGuess", [h.value]);
    setNote(r.ok ? "Commit sent. Reveal your guess in a later block, from the same address. Keep your guess: the page stores nothing." : r.why);
  };
  const reveal = async () => {
    const r = await play(game as never, "revealGuess", [word]);
    setNote(r.ok ? "Reveal sent. A right guess wins the round. It counts once your wallet's transaction is mined." : r.why);
  };
  const myWins = async () => {
    const r = await read<bigint>(game as never, "wins", [who]);
    setMine(r.ok ? String(r.value) : r.why);
  };

  return (
    <main className={s.page}>
      <h1>{game.title}</h1>
      {!snap && <p>Reading the game from the chain did not work just now. Try again in a minute.</p>}
      {snap?.retired && <p>This game is retired. Anything you won stays claimable.</p>}
      {snap?.paused && <p>This game is paused.</p>}
      {snap && live && snap.freeBalanceWei === "0" && <p>Awaiting funding: the game opens once its first funds arrive.</p>}
      <p>Find the round's word. First commit a hash of your guess, bound to your address. Then reveal the guess in a later block. The first correct reveal wins the round.</p>
      {snap && (started ? <p>Round {snap.views.round}, ends at block {snap.views.endBlock}.</p> : <p>No round is running. The Safe or its keeper opens one.</p>)}
      {won && <p>This round is won by {winner}.</p>}
      <label className={s.small} htmlFor="who">Your address (the commit binds to it)</label>
      <input id="who" className={s.input} value={player} onChange={(e) => setPlayer(e.target.value)} spellCheck={false} autoComplete="off" placeholder="your wallet address" />
      <label className={s.small} htmlFor="guess">Your guess: 1 to 32 characters, trimmed and lowercased</label>
      <input id="guess" className={s.input} value={guess} onChange={(e) => setGuess(e.target.value)} spellCheck={false} autoComplete="off" />
      <div className={s.row}>
        <button className={s.button} onClick={commit} disabled={!live || !goodWord || !goodPlayer}>Commit my guess</button>
        <button className={s.button} onClick={reveal} disabled={!live || !goodWord}>Reveal my guess</button>
        <button className={s.button} onClick={myWins} disabled={!snap || !goodPlayer}>My wins</button>
      </div>
      {mine !== "" && <p>Wins for this address: {mine}</p>}
      <p role="status">{note}</p>
      <p className={s.small}>The page stores nothing. Keep your guess until you reveal it, and reveal from the address you committed with. A reveal in the same block as its commit is refused.</p>
      <p className={s.small}>This game never asks for a deposit, a token allowance or a signed message. If your wallet asks for one here, reject it.</p>
    </main>
  );
}
