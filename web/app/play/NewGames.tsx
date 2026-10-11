// The Sequencer's games on /play: every web/app/g/<slug>/game.json, linked to its page on the play origin. With live
// data, retired ones are listed apart (their page stays up, archived; claims stay open). None yet: LIVE says so, mock mode
// renders nothing.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PLAY_URL } from "../../security";
import { LIVE } from "../_data/flags";
import { loadGame, snapshot } from "../g/game";
import { Section, ui } from "../_ui/ui";

export function gameSlugs(root = process.cwd()) {
  try {
    return readdirSync(join(root, "app", "g"), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

export async function NewGames() {
  const games = gameSlugs().map((s) => loadGame(s)).filter((g) => g !== null);
  if (games.length === 0) {
    return LIVE ? (
      <Section title="New games" note="built by the AI dev team">
        <p className={`${ui.prose} ${ui.muted}`}>No games yet: the dev team builds the first one from the winning idea. Each one ships only after every check and one public hour.</p>
      </Section>
    ) : null;
  }
  const snaps = LIVE ? await Promise.all(games.map((g) => snapshot(g))) : games.map(() => null);
  const item = (i: number) => <li key={games[i].slug}><a className={ui.link} href={`${PLAY_URL}/g/${games[i].slug}`}>{games[i].title}</a></li>;
  const live = games.map((_, i) => i).filter((i) => !snaps[i]?.retired);
  const retired = games.map((_, i) => i).filter((i) => snaps[i]?.retired);
  return (
    <Section title="New games" note="built by the AI dev team">
      <ul className={ui.prose}>{live.map(item)}</ul>
      {retired.length > 0 && <details className={ui.more}><summary>Retired</summary><ul className={ui.prose}>{retired.map(item)}</ul></details>}
      <p className={`${ui.prose} ${ui.muted}`}>Each game runs on its own page at a separate address. Games never take deposits or ask for approvals.</p>
    </Section>
  );
}
