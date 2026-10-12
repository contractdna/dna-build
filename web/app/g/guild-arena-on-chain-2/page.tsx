"use client";
// Guild Arena (contracts/src/games/guild-arena-on-chain-2/). Started from web/app/g/_template/page.tsx. Rules a page
// follows (the gates check them): it imports only react, ../../_ui/tx, ../../_ui/ui and its own files; it reaches the
// chain only through useGame() (the server's snapshot) and play()/read() from tx.ts; no globals, no network, no frames,
// no storage, no addresses but game.json's.
import { useState } from "react";
import { play, read, useGame } from "../../_ui/tx";
import game from "./game.json";
import s from "./page.module.css";

const SEATS = 8;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = BigInt(0);
const ONE = BigInt(1);

/** Digits typed by the player, as a bigint; null when the text is not a whole number. */
const digits = (text: string): bigint | null => (/^[0-9]{1,18}$/.test(text.trim()) ? BigInt(text.trim()) : null);

/** A guild name as bytes32: 1 to 32 plain characters, left-aligned, zero-padded (computed here, no network). */
const nameToBytes32 = (name: string): `0x${string}` | null => {
  const text = name.trim();
  if (text.length === 0 || text.length > 32) return null;
  let hex = "";
  for (let i = 0; i < 32; i++) {
    const code = i < text.length ? text.charCodeAt(i) : 0;
    if (code > 127) return null;
    hex += code.toString(16).padStart(2, "0");
  }
  return `0x${hex}`;
};

const PRINTABLE = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

/** The name stored in a bytes32, read back as text (zero bytes dropped). */
const bytes32ToName = (hex: string): string => {
  let out = "";
  for (let i = 0; i < 32; i++) {
    const code = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
    if (code >= 32 && code <= 127) out += PRINTABLE.at(code - 32) ?? "";
  }
  return out;
};

const short = (hex: string) => (hex.length > 14 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex);

export default function GamePage() {
  const snap = useGame();
  const [note, setNote] = useState("");
  const [info, setInfo] = useState("");
  const [name, setName] = useState("");
  const [joinId, setJoinId] = useState("");
  const [wallet, setWallet] = useState("");
  const [secret, setSecret] = useState("");
  const [kept, setKept] = useState("");
  const [lookupId, setLookupId] = useState("1");
  const [lookupEpoch, setLookupEpoch] = useState("");
  const [members, setMembers] = useState<string[]>([]);

  const live = !!snap && snap.isGame && !snap.paused && !snap.retired;
  const epochNow = digits(snap?.views.currentEpoch ?? "0") ?? ZERO;
  const inReveal = snap?.views.inRevealPhase === "true";
  const guilds = Number(snap?.views.guildCount ?? "0") || 0;
  const startSec = Number(snap?.views.start ?? "0") || 0;
  const startDay = startSec > 0 ? new Date(startSec * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";

  const send = async (fn: string, args: unknown[] = []) => {
    const r = await play(game as never, fn, args);
    setNote(r.ok ? "Sent. It counts once your wallet's transaction is mined." : r.why);
  };

  const createGuild = async () => {
    const id = nameToBytes32(name);
    if (!id) return setNote("A guild name is 1 to 32 plain characters.");
    await send("createGuild", [id]);
  };

  const joinGuild = async () => {
    const id = digits(joinId);
    if (id === null || id < ONE || id > BigInt(guilds)) return setNote("Pick a guild id from 1 up to the number of guilds.");
    await send("joinGuild", [id]);
  };

  const commit = async () => {
    const secretNow = secret.trim();
    const addr = wallet.trim();
    if (!ADDRESS.test(addr)) return setNote("Type the wallet address that sends the commit.");
    if (!HEX32.test(secretNow)) return setNote("Type a secret of your own: 0x and 64 hex digits.");
    const c = await read<`0x${string}`>(game as never, "commitHash", [secretNow, addr, epochNow]);
    if (!c.ok) return setNote(c.why);
    const r = await play(game as never, "commit", [c.value]);
    if (!r.ok) return setNote(r.why);
    setKept(secretNow);
    setNote("Sent. Keep your secret: you need it to reveal in the second half of this epoch.");
  };

  const reveal = async () => {
    const secretNow = secret.trim();
    if (!HEX32.test(secretNow)) return setNote("Paste the 32-byte hex secret you kept at commit.");
    await send("reveal", [secretNow]);
  };

  const lookupWallet = async () => {
    const addr = wallet.trim();
    if (!ADDRESS.test(addr)) return setNote("Type a wallet address above.");
    const g = await read<bigint>(game as never, "guildOf", [addr]);
    if (!g.ok) return setNote(g.why);
    const r = await read<bigint>(game as never, "reputation", [addr]);
    if (!r.ok) return setNote(r.why);
    setInfo(`Guild ${g.value.toString()} (0 is none). Reputation ${r.value.toString()}.`);
  };

  const lookupMembers = async () => {
    const id = digits(lookupId);
    if (id === null || id < ONE) return setNote("Enter a guild id.");
    const m = await read<string[]>(game as never, "membersOf", [id]);
    if (!m.ok) return setNote(m.why);
    setMembers(m.value);
    const nm = await read<`0x${string}`>(game as never, "guildName", [id]);
    const label = nm.ok ? bytes32ToName(nm.value) : `Guild ${id.toString()}`;
    setInfo(`${label} (guild ${id.toString()}): ${m.value.length} members.`);
  };

  const lookupPoints = async () => {
    const id = digits(lookupId);
    const e = digits(lookupEpoch);
    if (id === null || e === null) return setNote("Enter a guild id and an epoch.");
    const p = await read<bigint>(game as never, "guildPoints", [e, id]);
    if (!p.ok) return setNote(p.why);
    setInfo(`Guild ${id.toString()} has ${p.value.toString()} points in epoch ${e.toString()}.`);
  };

  const lookupTop = async () => {
    const e = digits(lookupEpoch);
    if (e === null) return setNote("Enter an epoch.");
    const t = await read<bigint>(game as never, "topGuild", [e]);
    if (!t.ok) return setNote(t.why);
    setInfo(t.value === ZERO ? `No guild has points in epoch ${e.toString()} yet.` : `Top guild in epoch ${e.toString()}: guild ${t.value.toString()}.`);
  };

  return (
    <main className={s.page}>
      <h1>{game.title}</h1>
      {!snap && <p>Reading the game from the chain did not work just now. Try again in a minute.</p>}
      {snap?.retired && <p>This game is retired. Its guilds and points stay readable.</p>}
      {snap?.paused && <p>This game is paused.</p>}

      <section className={s.section}>
        <h2>The mission</h2>
        <p>
          Epoch {epochNow.toString()}: {inReveal ? "reveal phase. Reveal the secret you committed." : "commit phase. Commit a secret."}
        </p>
        <p className={s.small}>
          {guilds} guilds, {SEATS} seats each{startDay ? `. The game started on ${startDay} (UTC).` : "."}
        </p>
        <p className={s.small}>
          Each epoch is 7 days: the first half is for commits, the second half for reveals. A commit counts only for the
          reveal in its own epoch. A valid reveal scores 1 point for you and 1 for your guild.
        </p>
      </section>

      <section className={s.section}>
        <h2>Guild</h2>
        <p className={s.small}>One guild per address. Creating, joining and leaving are closed during the reveal phase.</p>
        <div className={s.row}>
          <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Guild name, up to 32 characters" aria-label="Guild name" />
          <button className={s.button} onClick={createGuild} disabled={!live || inReveal}>Create guild</button>
        </div>
        <div className={s.row}>
          <input className={s.input} value={joinId} onChange={(e) => setJoinId(e.target.value)} placeholder="Guild id to join" aria-label="Guild id to join" />
          <button className={s.button} onClick={joinGuild} disabled={!live || inReveal}>Join guild</button>
        </div>
        <div className={s.row}>
          <button className={s.button} onClick={() => send("leaveGuild")} disabled={!live || inReveal}>Leave guild</button>
        </div>
      </section>

      <section className={s.section}>
        <h2>Commit and reveal</h2>
        <div className={s.row}>
          <input className={s.input} value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Your wallet address (the one that sends)" aria-label="Your wallet address" />
        </div>
        <div className={s.row}>
          <input className={s.input} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Secret: 0x and 64 hex digits" aria-label="Secret" />
        </div>
        <div className={s.row}>
          <button className={s.button} onClick={commit} disabled={!live || inReveal}>Commit</button>
          <button className={s.button} onClick={reveal} disabled={!live || !inReveal}>Reveal</button>
        </div>
        {kept && <p role="status" className={s.keep}>Keep this secret until you reveal: {kept}</p>}
        <p className={s.small}>
          Commits need a guild (join or create one first) and count once per epoch. Your commit is a hash of your secret, your address and the epoch. Lose the secret and nothing scores.
        </p>
      </section>

      <section className={s.section}>
        <h2>Look up</h2>
        <div className={s.row}>
          <button className={s.button} onClick={lookupWallet} disabled={!snap}>Guild and reputation of the wallet above</button>
        </div>
        <div className={s.row}>
          <input className={s.input} value={lookupId} onChange={(e) => setLookupId(e.target.value)} placeholder="Guild id" aria-label="Guild id to look up" />
          <input className={s.input} value={lookupEpoch} onChange={(e) => setLookupEpoch(e.target.value)} placeholder="Epoch" aria-label="Epoch to look up" />
        </div>
        <div className={s.row}>
          <button className={s.button} onClick={lookupMembers} disabled={!snap}>Members</button>
          <button className={s.button} onClick={lookupPoints} disabled={!snap}>Points</button>
          <button className={s.button} onClick={lookupTop} disabled={!snap}>Top guild</button>
        </div>
        {info && <p role="status">{info}</p>}
        <ol className={s.list}>
          {members.map((m) => (
            <li key={m}>{short(m)}</li>
          ))}
        </ol>
      </section>

      <p role="status">{note}</p>
      <p className={s.small}>This game never asks for a deposit, a token allowance or a signed message. If your wallet asks for one here, reject it.</p>
    </main>
  );
}
