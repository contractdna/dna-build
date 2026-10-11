import DNA from "./_dna/DNA";
import { LIVE } from "./_data/flags";
import { getTreasury } from "./_data/source";

export default async function Home() {
  // LIVE: the split FeeVault applies now (a rollback or the AI can move it inside its bounds), never the launch figures;
  // database down: no split line, the page still renders (like the layout's core)
  return <DNA split={LIVE ? await getTreasury().then((t) => t.split.map((x) => x.bps), () => []) : undefined} />;
}
