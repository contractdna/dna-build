// The public changelog (app/_data/changes.json, served at /api/changes): the engine reads it, so its shape is fixed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const changes = JSON.parse(readFileSync(new URL("../app/_data/changes.json", import.meta.url), "utf8"));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

test("changes.json: unique ids, valid ISO times newest first, bounded title and summary, a site path", () => {
  assert.ok(Array.isArray(changes) && changes.length > 0);
  assert.equal(new Set(changes.map((c) => c.id)).size, changes.length, "ids are unique");
  for (const c of changes) {
    assert.deepEqual(Object.keys(c).sort(), ["at", "id", "summary", "title", "url"], c.id);
    assert.match(c.id, /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/, c.id);
    assert.ok(ISO.test(c.at) && !Number.isNaN(Date.parse(c.at)), `${c.id}: at is an ISO date-time`);
    assert.ok(typeof c.title === "string" && c.title.length > 0 && c.title.length <= 60, `${c.id}: title 1–60 chars`);
    assert.ok(typeof c.summary === "string" && c.summary.length > 0 && c.summary.length <= 200, `${c.id}: summary 1–200 chars`);
    assert.match(c.url, /^\/[^\s]*$/, `${c.id}: url is a path on the site`);
  }
  for (let i = 1; i < changes.length; i++) assert.ok(Date.parse(changes[i - 1].at) >= Date.parse(changes[i].at), "newest first");
});

test("/api/changes: public GET, open CORS, cached 60 s", () => {
  const route = readFileSync(new URL("../app/api/changes/route.ts", import.meta.url), "utf8");
  assert.match(route, /export function GET/);
  assert.match(route, /"Access-Control-Allow-Origin": "\*"/);
  assert.match(route, /max-age=60/);
});
