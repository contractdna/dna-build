// The Sequencer's games on /play (#games): every game the GameFactory deployed, played right here through a panel this
// site wrote (GamePanel.tsx), never the game's own page. Retired ones are listed apart: their claims stay open.
// None yet: LIVE says so, mock mode renders nothing.
import { LIVE } from "../_data/flags";
import { getGames } from "../_data/source";
import { PoisonNote, WalletBar } from "../_ui/Wallet";
import { Section, ui } from "../_ui/ui";
import { GamePanel } from "./GamePanel";
import s from "./play.module.css";

export async function NewGames() {
  const games = await getGames().catch(() => null);
  if (!LIVE) return null;
  if (!games?.length) {
    return (
      <div id="games">
        <Section title="New games" note="built by the AI dev team">
          <p className={`${ui.prose} ${ui.muted}`}>{games ? "No games yet: the dev team builds the first one from the winning idea. Each one ships only after every check and one public hour." : "The games can't be read right now. Try again in a minute."}</p>
        </Section>
      </div>
    );
  }
  const panel = (g: (typeof games)[number]) => g.abi
    ? <GamePanel key={g.address} address={g.address} codehash={g.codehash} title={g.title} retired={g.retired} abi={g.abi} />
    : <article key={g.address} className={s.game}><h3 className={ui.cardTitle}>{g.title}</h3><p className={ui.prose}>This game&apos;s controls can&apos;t be loaded right now. Try again in a minute, or use it <a className={ui.link} href={`https://etherscan.io/address/${g.address}#writeContract`} target="_blank" rel="noopener noreferrer">on Etherscan</a>.</p></article>;
  const live = games.filter((g) => !g.retired), retired = games.filter((g) => g.retired);
  return (
    <div id="games">
      <Section title="New games" note="built by the AI dev team">
        <WalletBar token={null} />
        {live.length > 0 ? <div className={s.games}>{live.map(panel)}</div> : <p className={`${ui.prose} ${ui.muted}`}>No game is live right now.</p>}
        {retired.length > 0 && <details className={ui.more}><summary>Retired games</summary><div className={s.games}>{retired.map(panel)}</div></details>}
        <p className={`${ui.prose} ${ui.muted}`}>Each game is a contract the AI dev team wrote, checked and shipped in public. Games never take deposits, and never need an approval or a signed message: every button here sends a transaction with no ETH, to the game only.</p>
        <PoisonNote />
      </Section>
    </div>
  );
}
