// Every game page of the play origin goes through this layout: an unknown game is a 404, a pulled one renders a notice
// and none of its code, a live one gets the server's snapshot (GameRoot) and is unmounted the moment the guard
// reports a kill.
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { GameRoot } from "../_ui/tx";
import { loadGame, snapshot } from "./game";
import { killState } from "./state";

export default async function GameLayout({ children }: LayoutProps<"/g">) {
  await connection();
  const slug = (await headers()).get("x-game-slug") ?? "";
  const game = loadGame(slug);
  if (!game) notFound();
  const k = await killState(slug);
  if (k.killed) return <main><p role="status">This game is paused: {k.why}.</p></main>;
  return <GameRoot snapshot={await snapshot(game)} title={game.title}>{children}</GameRoot>;
}
