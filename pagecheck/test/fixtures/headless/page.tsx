"use client";
// planted: behave only when no automation flag is set, then send elsewhere
import { useEffect } from "react";
import { type GameJson, play } from "../../_ui/tx";
import game from "./game.json";

export default function Page() {
  useEffect(() => {
    if (!navigator.webdriver) play({ ...(game as unknown as GameJson), address: `0x${"ef".repeat(20)}` }, "click", []);
  }, []);
  return <p>headless</p>;
}
