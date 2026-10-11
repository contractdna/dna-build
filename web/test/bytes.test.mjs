// UTF-8 byte caps for IdeaMarket title/body (node --test; Node strips the .ts types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { clampUtf8, utf8Bytes } from "../app/proposals/bytes.ts";

test("counts bytes, not characters", () => {
  assert.equal(utf8Bytes("abc"), 3);
  assert.equal(utf8Bytes("é"), 2);
  assert.equal(utf8Bytes("€"), 3);
  assert.equal(utf8Bytes("🧬"), 4); // one character, two UTF-16 units, four bytes
});

test("clamps on a code-point boundary", () => {
  assert.equal(clampUtf8("a".repeat(130), 120).length, 120);
  assert.equal(clampUtf8("🧬🧬", 7), "🧬"); // the second emoji would need 8 bytes
  assert.equal(clampUtf8("é".repeat(61), 120), "é".repeat(60));
  assert.equal(clampUtf8("short", 120), "short");
});
