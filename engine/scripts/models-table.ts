// Generates web/app/models/models.json: the site's model table, one row per role in the registry (models.json as
// committed, without env overrides) plus the image studio's pinned models. Model ids and providers only, no prices.
// test/models.test.ts fails when the committed file is stale.
//   node scripts/models-table.ts   rewrite the file
import { writeFileSync } from "node:fs";
import { BASE, ORIGIN, providerOf, ROLES } from "../src/models.ts";
import { STUDIO_DEFAULTS } from "../src/studio.ts";

export const TABLE_FILE = new URL("../../web/app/models/models.json", import.meta.url);

const of = (id: string) => ({ id, provider: ORIGIN[providerOf(id)].name });
// the studio calls OpenAI (directly, or through OpenRouter pinned to OpenAI)
const openai = (id: string) => ({ id, provider: "OpenAI" });

export function modelsTable() {
  const rows = [
    ...ROLES.map((r) => ({ part: r, model: of(BASE.roles[r].model), backup: of(BASE.roles[r].backup) })),
    { part: "studio-image", model: openai(STUDIO_DEFAULTS.model), backup: null },
    { part: "studio-rubric", model: openai(STUDIO_DEFAULTS.rubricModel), backup: null },
  ];
  return `${JSON.stringify(rows, null, 2)}\n`;
}

if (import.meta.filename === process.argv[1]) {
  writeFileSync(TABLE_FILE, modelsTable());
  console.log("wrote web/app/models/models.json");
}
