"use client";
import { useState } from "react";
import { play } from "../../_ui/tx";
import game from "./game.json";
import s from "./page.module.css";

export default function LastClickPage() {
  const [note, setNote] = useState("");
  const click = async () => {
    const r = await play(game, "click", []);
    setNote(r.ok ? "You are in the lead." : r.why);
  };
  return (
    <main className={s.page}>
      <h1>{game.title}</h1>
      <p>Click to take the lead. When an hour passes with no click, the last clicker wins a tenth of the pot.</p>
      <button className={s.button} onClick={click}>Click</button>
      <p>{note}</p>
    </main>
  );
}
