// The vaults' art files the site serves at /vaults/art/<slot>.jpg (the base the contract's tokenURI names): all 50
// slots, the collection image and the banner must be in web/public before the page ships.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

const file = (name) => new URL(`../public/vaults/art/${name}.jpg`, import.meta.url);

test("web/public/vaults/art has 1..50, collection and banner as jpg", () => {
  const missing = [...Array.from({ length: 50 }, (_, i) => String(i + 1)), "collection", "banner"].filter((n) => !existsSync(file(n)));
  assert.deepEqual(missing, [], `missing art files: ${missing.join(", ")}`);
});
