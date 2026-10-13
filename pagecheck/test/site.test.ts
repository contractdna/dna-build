// A build that dies before compiling anything: the reason comes back plain. A copy leaves out the native binaries a
// node_modules above it holds, and loads those.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildFailure, buildSite, prepareSite } from "../src/site.ts";

test("an swc binary that cannot load is named as the cause", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-swc-"));
  try {
    mkdirSync(join(dir, "node_modules", "next", "dist", "bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "next", "dist", "bin", "next"), `console.error("Error: /tmp/x/next-swc.linux-x64-gnu.node: failed to map segment from shared object"); process.exit(1);`);
    await assert.rejects(buildSite(dir, 30_000), /swc binary could not load \(is \/tmp mounted noexec\?\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(buildFailure(1, "Type error: x"), /^next build failed \(1\): Type error: x$/);
});

test("a copy leaves out the swc and sharp binaries a node_modules above it holds, and resolves to those", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pc-native-"));
  const put = (p: string, text = "") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
  try {
    const web = join(tmp, "web");
    for (const p of ["@next/swc-linux-x64-gnu", "@next/env", "@img/sharp-linux-x64"]) put(join(web, "node_modules", p, "index.js"), "module.exports = 'web';");
    put(join(web, "node_modules", "next", "package.json"), "{}");
    // nothing above: everything is copied
    const alone = mkdtempSync(join(tmp, "alone-"));
    const a = prepareSite(web, {}, alone);
    for (const p of ["@next/swc-linux-x64-gnu", "@next/env", "@img/sharp-linux-x64"]) assert.ok(existsSync(join(a, "node_modules", p)), p);
    // the image's shape: a node_modules above the copy root holds the natives
    const root = join(tmp, "root");
    put(join(tmp, "node_modules", "@next", "swc-linux-x64-gnu", "index.js"), "module.exports = 'above';");
    put(join(tmp, "node_modules", "@img", "sharp-linux-x64", "index.js"), "module.exports = 'above';");
    mkdirSync(root);
    const c = prepareSite(web, {}, root);
    assert.ok(!existsSync(join(c, "node_modules", "@next", "swc-linux-x64-gnu")));
    assert.ok(!existsSync(join(c, "node_modules", "@img")));
    assert.ok(existsSync(join(c, "node_modules", "@next", "env", "index.js")));
    const req = createRequire(join(c, "node_modules", "next", "package.json"));
    assert.equal(req("@next/swc-linux-x64-gnu"), "above");
    assert.equal(req("@img/sharp-linux-x64"), "above");
    assert.equal(req("@next/env"), "web");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
