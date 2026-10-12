"use client";
// Genome (contracts/src/games/genome-an-evolving-o-1000003/). Built from the daily check-in page: the same wallet rules,
// reached through tx.ts only. Nothing is paid: a genome is claimed, mutated and looked up; its art is drawn here from
// its genomeOf data.
import { useEffect, useState } from "react";
import { play, read, useGame } from "../../_ui/tx";
import { GenomeArt } from "./GenomeArt";
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

/** genomeOf(address) returns seed, traits, mutations, scars, lastAct. */
type GenomeOf = readonly [`0x${string}`, `0x${string}`, bigint, bigint, bigint];
type Found = { seed: string; traits: string; mutations: number; scars: number; nextAt: number | null };

const ZERO = BigInt(0);
const when = (t: number) =>
  new Date(t * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export default function GamePage() {
  const snap = useGame();
  const now = useNow();
  const [note, setNote] = useState("");
  const [who, setWho] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const live = !!snap && snap.isGame && !snap.paused && !snap.retired;
  const send = async (fn: string) => {
    const r = await play(game as never, fn, []);
    setNote(r.ok ? "Sent. It counts once your wallet's transaction is mined." : r.why);
  };
  const look = async () => {
    const addr = who.trim();
    if (addr.length !== 42 || !/^0x[0-9a-fA-F]+$/.test(addr)) {
      setNote("Enter a wallet address: 0x and 40 hex digits.");
      return;
    }
    const r = await read<GenomeOf>(game as never, "genomeOf", [addr]);
    if (!r.ok) {
      setNote(r.why);
      return;
    }
    const [seed, traits, mutations, scars] = r.value;
    const next = await read<bigint>(game as never, "nextMutateAt", [addr]);
    setFound({ seed, traits, mutations: Number(mutations), scars: Number(scars), nextAt: next.ok ? Number(next.value) : null });
    setNote("");
  };
  const hasGenome = !!found && BigInt(found.seed) !== ZERO;
  return (
    <main className={s.page}>
      <h1>{game.title}</h1>
      {!snap && <p>Reading the game from the chain did not work just now. Try again in a minute.</p>}
      {snap?.retired && <p>This game is retired. Genomes can still be looked up.</p>}
      {snap?.paused && <p>This game is paused.</p>}
      <p>Claim one genome. Then mutate it once a day. A mutate within 48 hours of the last one adds a trait; a later one adds a scar instead. Nothing is paid.</p>
      <p>Genomes claimed so far: <span>{snap?.views.genomes ?? "0"}</span></p>
      <div className={s.row}>
        <button className={s.button} onClick={() => send("claimGenome")} disabled={!live}>Claim a genome</button>
        <button className={s.button} onClick={() => send("mutate")} disabled={!live}>Mutate</button>
      </div>
      <p>Look up a genome by its wallet address:</p>
      <div className={s.row}>
        <input className={s.input} value={who} onChange={(e) => setWho(e.target.value)} placeholder="0x..." aria-label="Wallet address" />
        <button className={s.button} onClick={look}>Look up</button>
      </div>
      {found && !hasGenome && <p>No genome at this address yet.</p>}
      {found && hasGenome && (
        <div className={s.card}>
          <GenomeArt traits={found.traits} scars={found.scars} />
          <p>Traits {found.mutations} of 32, scars {found.scars}.</p>
          {found.nextAt !== null && (
            <p>{found.nextAt > now ? `Next mutate from ${when(found.nextAt)} UTC.` : "A mutate is open now."}</p>
          )}
        </div>
      )}
      <p role="status">{note}</p>
      <p className={s.small}>This game never asks for a deposit, a token allowance or a signed message. If your wallet asks for one here, reject it.</p>
    </main>
  );
}
