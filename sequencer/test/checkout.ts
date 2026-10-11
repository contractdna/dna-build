// A small checkout for the tests: the kit, the page template, the game templates and the rules, committed as the order's base.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HELD_TEMPLATES, TEMPLATES, templateRoots } from "../src/roles.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const KIT = [
  "contracts/src/games/GameKit.sol", "contracts/src/games/IGames.sol", "contracts/src/games/GameFactory.sol", "contracts/src/games/GameFunder.sol","contracts/test/games/GameKitConformance.sol",
  "contracts/games/foundry.toml", "contracts/lib/forge-std/src", "web/app/g/_template", "web/app/_ui/tx.ts", "contracts/docs/games.md", "docs/sequencer.md",
  "contracts/modules/foundry.toml", "contracts/src/interfaces/IPolicies.sol", "contracts/test/modules/ModuleConformance.sol",
  ...[...TEMPLATES, ...HELD_TEMPLATES].flatMap(templateRoots).map((r) => r.replace(/\/$/, "")),
];

export function checkout() {
  const d = mkdtempSync(join(tmpdir(), "seq-run-"));
  for (const k of KIT) {
    mkdirSync(dirname(join(d, k)), { recursive: true });
    cpSync(join(REPO, k), join(d, k), { recursive: true });
  }
  const g = (...a: string[]) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]).toString().trim();
  g("init", "-q");
  g("add", "-A");
  g("commit", "-qm", "base");
  return { dir: d, base: g("rev-parse", "HEAD") };
}
