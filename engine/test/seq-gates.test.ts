// The Sequencer's gates, each against planted violations (test/fixtures/seq/). The forge-backed part needs forge and
// contracts/lib/forge-std (CI: the engine job checks out submodules); it is skipped without them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { type Address, getContractAddress, type Hex, keccak256 } from "viem";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { compile, failedTest, forkGate, gasGate, idOf, LIMITS, mutationGate, runGates, runLimited, runtimeCode, testsGate, workspace } from "../src/seq-forge.ts";
import {
  abiGate, addressGate, applyMutant, bannedOpcode, bytecodeGate, type Change, depGate, gameInterface, type GameJson, identityGate, mutants, pathGate,
  parseRaw, type PrFacts, resolveSol, runtimeOf, sha256, solCodeBytes, solImports, solPatternGate, textGate, webGate,
} from "../src/seq-gates.ts";
import { ARRAY_OK, CHEAT_CALLER, CHEAT_SRC, ETCH_LINE, NEW_SOURCE, SRC, TEST } from "./fixtures/seq/planted.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const KIT = join(ROOT, "contracts");
const FIX = new URL("./fixtures/seq/lastclick/", import.meta.url).pathname;
const hasForge = (() => {
  try { execFileSync("forge", ["--version"], { stdio: "ignore" }); } catch { return false; }
  return existsSync(join(KIT, "lib/forge-std/src/Test.sol"));
})();
const skip = hasForge ? false : "needs forge and contracts/lib/forge-std";

/** The fixture game's files, by repo path. */
function lastclick(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(FIX, p)] = readFileSync(p, "utf8");
    }
  };
  walk(FIX);
  return out;
}
const added = (files: Record<string, string>): Change[] => Object.entries(files).map(([path, t]) => ({ path, status: "A", mode: "100644", size: t.length }));

// ---------------------------------------------------------------- G1

describe("G1 paths", () => {
  const ok = (path: string): Change => ({ path, status: "A", mode: "100644", size: 10 });
  test("a new game's own files pass", () => {
    assert.equal(pathGate(added(lastclick()), "lastclick", false).ok, true);
  });
  for (const [what, c, want] of [
    ["a workflow", ok(".github/workflows/x.yml"), /outside/],
    ["the hook", ok("contracts/src/DNAHook.sol"), /outside/],
    ["the CSP config", ok("web/next.config.ts"), /outside/],
    ["a package file", ok("engine/package.json"), /outside/],
    ["the kit", ok("contracts/src/games/GameKit.sol"), /outside/],
    ["the conformance suite", ok("contracts/test/games/GameKitConformance.sol"), /outside/],
    ["another page folder", ok("web/app/play/draw/x.tsx"), /outside/],
    ["another game", ok("contracts/src/games/other/X.sol"), /outside/],
    ["a dot-dot path", ok("contracts/src/games/lastclick/../../DNAHook.sol"), /outside/],
    ["a symlink", { ...ok("web/app/g/lastclick/x.tsx"), mode: "120000" }, /symlink/],
    ["a submodule", { ...ok("contracts/src/games/lastclick/lib"), mode: "160000" }, /submodule/],
    ["an executable", { ...ok("web/app/g/lastclick/x.tsx"), mode: "100755" }, /mode 100755/],
    ["a binary", { ...ok("web/app/g/lastclick/x.tsx"), binary: true }, /binary/],
    ["a big file", { ...ok("web/app/g/lastclick/x.tsx"), size: 100_001 }, /bytes/],
    ["a deletion", { ...ok("web/app/g/lastclick/x.tsx"), status: "D" }, /deleted/],
    ["a .gitattributes in the contract folder", ok("contracts/src/games/lastclick/.gitattributes"), /only \.sol files and SPEC\.json/],
    ["a non-Solidity test file", ok("contracts/test/games/lastclick/notes.txt"), /only \.sol files and SPEC\.json/],
    ["a rename from outside", { ...ok("web/app/g/lastclick/x.tsx"), status: "R", oldPath: "web/app/page.tsx" }, /renamed from outside/],
  ] as [string, Change, RegExp][]) {
    test(`planted: ${what}`, () => {
      const r = pathGate([ok("contracts/src/games/lastclick/A.sol"), c], "lastclick", false);
      assert.equal(r.ok, false);
      assert.match(r.issues.join("\n"), want);
    });
  }
  test("planted: an existing game's folder, a reserved or bad slug, no changes", () => {
    assert.match(pathGate([ok("contracts/src/games/lastclick/A.sol")], "lastclick", true).issues.join(), /already exist/);
    assert.match(pathGate([ok("contracts/src/games/example/A.sol")], "example", false).issues.join(), /not a valid/);
    assert.match(pathGate([ok("contracts/src/games/X/A.sol")], "X", false).issues.join(), /not a valid/);
    assert.match(pathGate([], "lastclick", false).issues.join(), /no changes/);
  });
});

test("git diff --raw: adds, renames, symlinks, deletions and modes, as the CLI reads them", () => {
  const d = mkdtempSync(join(tmpdir(), "seq-git-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]).toString();
  try {
    g("init", "-q");
    writeFileSync(join(d, "keep.txt"), "a\n".repeat(50));
    writeFileSync(join(d, "gone.txt"), "x\n");
    g("add", "-A");
    g("commit", "-qm", "base");
    const base = g("rev-parse", "HEAD").trim();
    mkdirSync(join(d, "web/app/g/x"), { recursive: true });
    writeFileSync(join(d, "web/app/g/x/page.tsx"), "export default 1;\n");
    symlinkSync("/etc/passwd", join(d, "web/app/g/x/link"));
    renameSync(join(d, "keep.txt"), join(d, "web/app/g/x/moved.txt"));
    rmSync(join(d, "gone.txt"));
    g("add", "-A");
    g("commit", "-qm", "head");
    const cs = parseRaw(g("diff", "--raw", "-z", "--no-abbrev", "-M", base, "HEAD"));
    const by = Object.fromEntries(cs.map((c) => [c.path, c]));
    assert.equal(by["web/app/g/x/page.tsx"].status, "A");
    assert.equal(by["web/app/g/x/page.tsx"].mode, "100644");
    assert.equal(by["web/app/g/x/link"].mode, "120000");
    assert.deepEqual([by["web/app/g/x/moved.txt"].status, by["web/app/g/x/moved.txt"].oldPath], ["R", "keep.txt"]);
    assert.equal(by["gone.txt"].status, "D");
    const r = pathGate(cs, "x", false);
    assert.match(r.issues.join("\n"), /symlink/);
    assert.match(r.issues.join("\n"), /renamed from outside/);
    assert.match(r.issues.join("\n"), /gone\.txt: outside/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("mutation sites read code only: comments and strings are blanked byte for byte", () => {
  const src = 'x = a /* é < */ < b; s = "<=";';
  const code = solCodeBytes(src);
  assert.equal(code.length, Buffer.byteLength(src));
  assert.equal(code.toString("latin1").indexOf("<"), Buffer.from(src).indexOf("< b"));
  assert.ok(!code.toString("latin1").includes("<="));
});

// ---------------------------------------------------------------- G2

describe("G2 dependencies", () => {
  test("the fixture game's imports pass; imports are read past comments and strings", () => {
    assert.equal(depGate(lastclick(), "lastclick").ok, true);
    assert.deepEqual(solImports(`// import "evil.sol";\n/* import "x"; */\nstring constant S = "import 'y';";\nimport {A} from "../GameKit.sol";\nimport "./B.sol";`), ["../GameKit.sol", "./B.sol"]);
    assert.equal(resolveSol("contracts/src/games/g/A.sol", "../GameKit.sol"), "contracts/src/games/GameKit.sol");
    assert.equal(resolveSol("contracts/src/games/g/A.sol", "solady/X.sol"), null);
  });
  const sol = (path: string, imp: string) => ({ [path]: `pragma solidity 0.8.26;\nimport ${imp};\ncontract A {}\n` });
  for (const [what, files] of [
    ["a library", sol("contracts/src/games/g/A.sol", `"solady/utils/LibString.sol"`)],
    ["openzeppelin by remapping", sol("contracts/src/games/g/A.sol", `{X} from "@openzeppelin/contracts/token/ERC20/ERC20.sol"`)],
    ["the hook by relative path", sol("contracts/src/games/g/A.sol", `"../../DNAHook.sol"`)],
    ["the factory from a game source", sol("contracts/src/games/g/A.sol", `"../GameFactory.sol"`)],
    ["forge-std from a game source", sol("contracts/src/games/g/A.sol", `"forge-std/Test.sol"`)],
    ["a remapped spec climbing out", sol("contracts/test/games/g/A.t.sol", `"forge-std/../../../src/DNAHook.sol"`)],
    ["another game", sol("contracts/src/games/g/A.sol", `"../other/B.sol"`)],
    ["ethers in a page", { "web/app/g/g/page.tsx": `import { Wallet } from "ethers";\nexport default function P() { return null; }` }],
    ["viem in a page", { "web/app/g/g/page.tsx": `import { createWalletClient } from "viem";` }],
    ["another page's module", { "web/app/g/g/page.tsx": `import x from "../../play/page";` }],
    ["a re-export", { "web/app/g/g/page.tsx": `export * from "next/server";` }],
  ] as [string, Record<string, string>][]) {
    test(`planted: ${what}`, () => assert.equal(depGate(files, "g").ok, false));
  }
});

// ---------------------------------------------------------------- G4

describe("G4 bytecode", () => {
  test("planted opcodes; PUSH data skipped; size", () => {
    for (const op of ["f0", "f2", "f4", "f5", "ff"]) assert.equal(bytecodeGate(`0x6001${op}00`).ok, false, op);
    assert.equal(bannedOpcode("0x63f4f4f4f400"), null);
    assert.equal(bannedOpcode("0x7f" + "f4".repeat(32) + "00"), null);
    assert.equal(bannedOpcode("0x63f4f4f4f4f4"), 5);
    assert.equal(bannedOpcode("0x5ff4"), 1);
    assert.equal(bytecodeGate("0x" + "5b".repeat(24_576)).ok, true);
    assert.match(bytecodeGate("0x" + "5b".repeat(24_577)).issues.join(), /24577 bytes/);
    assert.match(bytecodeGate("0x").issues.join(), /no deployed code/);
  });
});

// ---------------------------------------------------------------- G11

describe("G11 web page", () => {
  const page = (body: string, name = "page.tsx") => ({ [`web/app/g/g/${name}`]: body });
  test("the fixture page passes", () => assert.equal(webGate(lastclick(), "lastclick").ok, true));
  test("components are not tags: next/link's <Link> passes, a lowercase banned tag does not", () => {
    const link = `"use client";\nimport Link from "next/link";\nexport default function P() { return <Link href="/play">back</Link>; }\n`;
    assert.deepEqual(webGate(page(link), "g").issues, []);
    assert.match(webGate(page(link.replace("<Link href=\"/play\">back</Link>", "<iframe />")), "g").issues.join("\n"), /<iframe>/);
  });
  test("the template builders copy passes G2 and G11 as a game's page", () => {
    const dir = join(ROOT, "web/app/g/_template");
    const files = Object.fromEntries(readdirSync(dir).map((f) => [`web/app/g/copied/${f}`, readFileSync(join(dir, f), "utf8")]));
    assert.deepEqual(webGate(files, "copied").issues, []);
    assert.deepEqual(depGate(files, "copied").issues, []);
  });
  test("a page's files together: at most 200,000 bytes (UTF-8); the templates sit far below it", () => {
    const css = (n: number, name: string) => page(" ".repeat(n), name); // a CSS module of n bytes
    const twoFull = { ...css(100_000, "a.module.css"), ...css(100_000, "b.module.css") };
    assert.deepEqual(webGate(twoFull, "g").issues, []);
    assert.match(webGate({ ...twoFull, ...css(1, "c.module.css") }, "g").issues.join("\n"), /web\/app\/g\/g\/: 200001 bytes in its files \(max 200000\)/);
    // multi-byte text counts as bytes: 70,000 three-byte characters are 210,000 bytes
    assert.match(webGate(page(`.a {}\n/*${"€".repeat(70_000)}*/\n`, "a.module.css"), "g").issues.join("\n"), /bytes in its files/);
    // a game's contract files are not page files
    assert.deepEqual(webGate({ ...twoFull, "contracts/src/games/g/G.sol": "x".repeat(150_000) }, "g").issues, []);
    for (const t of ["_template", "_template-daily-checkin", "_template-last-buyer", "_template-raffle"]) {
      const dir = join(ROOT, "web/app/g", t);
      const total = readdirSync(dir).reduce((s, f) => s + statSync(join(dir, f)).size, 0);
      assert.ok(total < 40_000, `${t}: ${total} bytes`);
    }
  });
  test("a local named open (a menu's state) is not the global open()", () => {
    const menu = `"use client";\nimport { useState } from "react";\nexport default function P() {\n  const [open, setOpen] = useState(false);\n  const toggle = (open: boolean) => setOpen(!open);\n  return <button onClick={() => toggle(open)}>{open ? "close" : "menu"}</button>;\n}\n`;
    assert.deepEqual(webGate(page(menu), "g").issues, []);
  });
  for (const [what, files, want] of [
    ["window.ethereum", page(`window.ethereum.request({ method: "x" });`), /window/],
    ["obfuscated provider (constructor chain + atob)", page(`[].constructor.constructor("return this")()[["eth","ereum"].join("")].request({ method: atob("ZXRoX3NlbmRUcmFuc2FjdGlvbg==") });`), /constructor/],
    ["a computed global key", page(`const g = (0, eval)("this"); g["ra" + "bby"];`), /eval/],
    ["a built-string member key", page(`const o = {} as Record<string, unknown>; o["ra" + "bby"];`), /computed member access/],
    ["eth_sendTransaction string", page(`const m = "eth_sendTransaction";`), /eth_/],
    ["personal_sign", page(`const m = "personal_sign";`), /personal_sign/],
    ["typed data", page(`const m = "eth_signTypedData_v4";`), /eth_/],
    ["approve", page(`const fn = "approve";`), /approve/],
    ["permit", page(`const fn = "permit";`), /permit/],
    ["setApprovalForAll", page(`const fn = "setApprovalForAll";`), /setapprovalforall/],
    ["a foreign address literal", page(`const to = "0x000000000000000000000000000000000000dEaD";`), /address literal/],
    ["a URL", page(`const u = "https://x.example/c";`), /matching/],
    ["fetch", page(`fetch("/x");`), /fetch/],
    ["a websocket", page(`new WebSocket("/s");`), /WebSocket/],
    ["a peer connection", page(`const p = new RTCPeerConnection();`), /RTCPeerConnection/],
    ["a prefixed peer connection", page(`const p = new webkitRTCPeerConnection();`), /webkitRTCPeerConnection/],
    ["a data channel type", page(`const c: RTCDataChannel | null = null;`), /RTCDataChannel/],
    ["dynamic import", page(`import("./x");`), /dynamic import/],
    ["eval", page(`eval("1");`), /eval/],
    ["Function", page(`new Function("return 1")();`), /Function/],
    ["an iframe", page(`export default () => <iframe srcDoc="<p>x</p>" />;`), /iframe/],
    ["srcdoc / contentWindow", page(`const f = document.createElement("x"); f.contentWindow;`), /contentWindow/],
    ["a popup", page(`open("/g/x");`), /open/],
    ["a popup through a member", page(`"use client";\nconst w = {} as { open(u: string): void }; w.open("/g/x");`), /: open$/m],
    ["a popup after a local open in another scope", page(`"use client";\nfunction a() { const open = 1; return open; }\nopen("/g/x");`), /:3: open$/m],
    ["open destructured from an object", page(`"use client";\nconst { open } = {} as { open: () => void };`), /: open$/m],
    ["open declared with no body", page(`"use client";\nfunction open(u: string): void;\nopen("/" + "/evil.example");`), /: open$/m],
    ["open declared ambient", page(`"use client";\ndeclare const open: (u: string) => void;\nopen("/g/x");`), /: open$/m],
    ["navigation", page(`location.href = "/";`), /location/],
    ["storage", page(`localStorage.setItem("a", "b");`), /localStorage/],
    ["postMessage", page(`parent.postMessage("x", "*");`), /postMessage/],
    ["dangerouslySetInnerHTML", page(`export default () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;`), /dangerouslySetInnerHTML/],
    ["a script tag string", page(`const s = "<script>alert(1)</script>";`), /script/],
    ["use server", page(`"use server";\nexport async function a() {}`), /use server/],
    ["an EIP-6963 event", page(`const e = "eip6963:requestProvider";`), /eip6963/],
    ["a route handler", page(`export function GET() {}`, "route.ts"), /not page.tsx/],
    ["a layout", page(`export default function L() { return null; }`, "layout.tsx"), /not page.tsx/],
    ["middleware", page(`export function middleware() {}`, "middleware.ts"), /not page.tsx/],
    ["a plain .ts module", page(`export const x = 1;`, "helpers.ts"), /not page.tsx/],
    ["CSS url()", page(`.a { background: url(https://x.example/i.png); }`, "page.module.css"), /url/],
    ["CSS @import", page(`@import "https://x.example/a.css";`, "page.module.css"), /@import/],
    ["game.json with an extra key", page(`{"slug":"g","title":"G","chainId":1,"address":"0x1111111111111111111111111111111111111111","codehash":"0x${"2".repeat(64)}","abi":[],"rpc":"x"}`, "game.json"), /keys/],
    ["game.json on another chain", page(`{"slug":"g","title":"G","chainId":10,"address":"0x1111111111111111111111111111111111111111","codehash":"0x${"2".repeat(64)}","abi":[]}`, "game.json"), /chainId/],
    ["an inline handler string", page(`export default () => <button onClick="go()" />;`), /inline event handler/],
    ["no use client", page(`export default function P() { return null; }`), /must start with "use client"/],
    ["use client not first", page(`import x from "react";\n"use client";`), /must start with "use client"/],
    ["route segment config in page.tsx", page(`"use client";\nexport const dynamic = "force-static";\nexport default function P() { return null; }`), /exports only its default/],
    ["a named re-export in page.tsx", page(`"use client";\nexport { x } from "./X";`), /exports only its default/],
    ["an identifier key", page(`"use client";\nconst k = "x"; const o: Record<string, number> = {}; o[k];`), /computed member access/],
    ["view", page(`"use client";\nconst w = (globalThis as never)?.view;`), /view/],
    ["a template head", page(`"use client";\nconst a = 1; const u = \`https://x.example/\${a}\`;`), /matching/],
    ["a template middle", page(`"use client";\nconst a = 1; const u = \`\${a}eth_send\${a}\`;`), /eth_/],
    ["a protocol-relative URL", page(`"use client";\nconst u = "//x.example/c";`), /matching/],
    ["a meta refresh", page(`"use client";\nexport default () => <meta httpEquiv="refresh" content="0" />;`), /<meta>/],
    ["a link tag", page(`"use client";\nexport default () => <link rel="prefetch" />;`), /<link>/],
    ["a base tag", page(`"use client";\nexport default () => <base />;`), /<base>/],
    ["an object", page(`"use client";\nexport default () => <object />;`), /<object>/],
    ["an embed", page(`"use client";\nexport default () => <embed />;`), /<embed>/],
    ["a form", page(`"use client";\nexport default () => <form />;`), /<form>/],
    ["formAction", page(`"use client";\nexport default () => <button formAction="/x" />;`), /formAction/],
    ["ping", page(`"use client";\nexport default () => <a ping="/x" />;`), /ping/],
    ["innerHTML", page(`"use client";\nconst e = {} as { innerHTML: string }; e.innerHTML = "x";`), /innerHTML/],
    ["createElement", page(`"use client";\nimport { createElement } from "react";`), /createElement/],
    ["clipboard", page(`"use client";\nconst n = {} as { clipboard: unknown }; n.clipboard;`), /clipboard/],
    ["an opengraph image", page(`export default function I() { return null; }`, "opengraph-image.tsx"), /not page.tsx/],
    ["an icon", page(`export default function I() { return null; }`, "icon.tsx"), /not page.tsx/],
    ["a sitemap", page(`export default function S() { return []; }`, "sitemap.ts"), /not page.tsx/],
    ["global-error", page(`export default function E() { return null; }`, "global-error.tsx"), /not page.tsx/],
    ["a lowercase component", page(`"use client";\nexport default function c() { return null; }`, "card.tsx"), /not page.tsx/],
    ["a nested file", page(`"use client";`, "parts/Card.tsx"), /not page.tsx/],
  ] as [string, Record<string, string>, RegExp][]) {
    test(`planted: ${what}`, () => {
      const r = webGate(files, "g");
      assert.equal(r.ok, false, what);
      assert.match(r.issues.join("\n"), want);
    });
  }
});

// ---------------------------------------------------------------- G12

describe("G12 text and secrets", () => {
  test("a short plain body passes", () => {
    assert.equal(textGate("Last Click: each click starts or extends a one-hour round. When it runs out the last clicker wins a tenth of the pot. Tests cover rounds, claims and retirement.", {}).ok, true);
  });
  for (const [what, body, files, want] of [
    ["121 words", "word ".repeat(121), {}, /121 words/],
    ["a link", "See https://x.example for more.", {}, /url/],
    ["a handle", "Thanks @someone.", {}, /handle/],
    ["a cashtag", "Better than $PEPE.", {}, /cashtag/],
    ["an em dash", "A game — for you.", {}, /dash/],
    ["stock wording", "We leverage a seamless design.", {}, /stock wording/],
    ["an Anthropic key in a file", "Fine.", { "web/app/g/g/page.tsx": "const k = 'sk-ant-api03-abcdefghijklmnop';" }, /key-shaped/],
    ["a GitHub token in the body", "ghp_abcdefghijklmnopqrstuvwxyz123456", {}, /key-shaped/],
    ["a private key block", "Fine.", { "x": "-----BEGIN EC PRIVATE KEY-----" }, /key-shaped/],
  ] as [string, string, Record<string, string>, RegExp][]) {
    test(`planted: ${what}`, () => assert.match(textGate(body, files).issues.join("\n"), want));
  }
});

// ---------------------------------------------------------------- G13 / G14

describe("G13 address, G14 identity", () => {
  const factory = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
  const salt = keccak256("0x01");
  const initCode = "0x6080604052" as Hex;
  const deployed = "0x60806040" as Hex;
  const good: GameJson = { slug: "g", title: "G", chainId: 1, address: getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode: initCode }), codehash: keccak256(deployed), abi: [] };
  test("the predicted address and codehash pass; anything else fails", () => {
    const runtime = deployed;
    assert.equal(addressGate(good, { factory, salt, initCode, runtime, slug: "g" }).ok, true);
    assert.match(addressGate({ ...good, address: "0x1111111111111111111111111111111111111111" }, { factory, salt, initCode, runtime, slug: "g" }).issues.join(), /not the factory's/);
    assert.match(addressGate({ ...good, codehash: keccak256("0x00") }, { factory, salt, initCode, runtime, slug: "g" }).issues.join(), /codehash/);
    assert.match(addressGate(good, { factory, salt: keccak256("0x02"), initCode, runtime, slug: "g" }).issues.join(), /not the factory's/);
    assert.match(addressGate(null, { factory, salt, initCode, runtime, slug: "g" }).issues.join(), /no game.json/);
    assert.match(addressGate(good, { factory, salt, initCode, runtime: null, slug: "g" }).issues.join(), /immutables other than the kit's/);
  });
  test("runtimeOf writes each immutable as a left-padded word; an unknown immutable gives null", () => {
    const code = `0x60${"00".repeat(32)}60${"00".repeat(32)}00` as Hex;
    const r = runtimeOf(code, { "7": [{ start: 1, length: 32 }], "9": [{ start: 34, length: 32 }] }, { "7": factory, "9": "0x00000000000000000000000000000000000000aa" });
    assert.equal(r, `0x60${"0".repeat(24)}${factory.slice(2).toLowerCase()}60${"0".repeat(62)}aa00`);
    assert.equal(runtimeOf(code, { "8": [{ start: 1, length: 32 }] }, { "7": factory }), null);
  });
  const o = { orderId: "o1", round: 2, baseSha: "b".repeat(40), gatedSha: "h".repeat(40), bot: "dna-sequencer[bot]" };
  const pr: PrFacts = { headRepo: "r", baseRepo: "r", author: o.bot, headRef: "seq/o1-r2", headSha: o.gatedSha, commits: [{ sha: o.gatedSha, parents: [o.baseSha], author: o.bot, committer: "web-flow", verified: true }] };
  test("the bot's one signed commit on the order's branch passes", () => assert.equal(identityGate(pr, o).ok, true));
  test("a commit the bot also committed itself passes", () => assert.equal(identityGate({ ...pr, commits: [{ ...pr.commits[0], committer: o.bot }] }, o).ok, true));
  for (const [what, p, want] of [
    ["a fork PR", { ...pr, headRepo: "fork" }, /fork/],
    ["a human author", { ...pr, author: "someone" }, /not the bot/],
    ["another branch", { ...pr, headRef: "seq/o1-r1" }, /not the order's/],
    ["a moved head", { ...pr, headSha: "x".repeat(40) }, /moved/],
    ["two commits", { ...pr, commits: [...pr.commits, pr.commits[0]] }, /2 commits/],
    ["a human committer", { ...pr, commits: [{ ...pr.commits[0], committer: "someone" }] }, /committer/],
    ["GitHub committing for a human author", { ...pr, commits: [{ ...pr.commits[0], author: "someone" }] }, /author/],
    ["GitHub committing an unsigned commit", { ...pr, commits: [{ ...pr.commits[0], verified: false }] }, /committer/],
    ["an unsigned commit", { ...pr, commits: [{ ...pr.commits[0], verified: false }] }, /not signed/],
    ["another base", { ...pr, commits: [{ ...pr.commits[0], parents: ["c".repeat(40)] }] }, /parent/],
  ] as [string, PrFacts, RegExp][]) {
    test(`planted: ${what}`, () => assert.match(identityGate(p, o).issues.join("\n"), want));
  }
});

// ---------------------------------------------------------------- child processes

describe("limited child processes", () => {
  test("a timeout kills the whole process group, children included", async () => {
    const r = await runLimited("sh", ["-c", "sleep 31.25 & sleep 31.25; echo never"], { cwd: "/tmp", env: { PATH: process.env.PATH! }, timeoutMs: 500 });
    assert.equal(r.timedOut, true);
    assert.doesNotMatch(r.out, /never/);
    await new Promise((res) => setTimeout(res, 200));
    // pgrep directly (no shell whose own command line would match), exit 1 = nothing found
    const left = (() => { try { return execFileSync("pgrep", ["-f", "sleep 31.25"]).toString().trim(); } catch { return ""; } })();
    assert.equal(left, "", "no sleep left behind");
  });
  test("an abort signal kills the whole process group at once, children included (and an already-aborted one before it runs)", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 300);
    const r = await runLimited("sh", ["-c", "sleep 32.5 & sleep 32.5; echo never"], { cwd: "/tmp", env: { PATH: process.env.PATH! }, timeoutMs: 60_000, signal: ac.signal });
    assert.ok(Date.now() - t0 < 5_000);
    assert.equal(r.aborted, true);
    assert.doesNotMatch(r.out, /never/);
    await new Promise((res) => setTimeout(res, 200));
    const left = (() => { try { return execFileSync("pgrep", ["-f", "sleep 32.5"]).toString().trim(); } catch { return ""; } })();
    assert.equal(left, "", "no sleep left behind");
    const done = await runLimited("sh", ["-c", "echo ran"], { cwd: "/tmp", env: { PATH: process.env.PATH! }, timeoutMs: 60_000, signal: AbortSignal.abort() });
    assert.equal(done.aborted, true);
    assert.doesNotMatch(done.out, /ran/);
  });
  test("output is capped and the env is only what is given", async () => {
    const r = await runLimited("sh", ["-c", "echo \"${SECRET:-none}\"; yes | head -c 200000"], { cwd: "/tmp", env: { PATH: process.env.PATH! }, timeoutMs: 10_000 });
    assert.match(r.out, /^none/);
    assert.ok(r.out.length <= LIMITS.outputBytes);
  });
  test("planted: a process asking for 8 GB fails cleanly under the memory limit (Linux, prlimit)", { skip: process.platform !== "linux" ? "prlimit is Linux-only" : false }, async () => {
    const r = await runLimited(process.execPath, ["-e", "const b = []; for (let i = 0; i < 64; i++) b.push(Buffer.alloc(128 * 1024 * 1024, 1)); console.log('allocated')"], { cwd: "/tmp", env: { PATH: process.env.PATH! }, timeoutMs: 60_000 });
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.out, /allocated/);
    assert.equal(r.timedOut, false);
  });
});

// ---------------------------------------------------------------- forge-backed: G3, G5, mutants, G6–G9, the runner

test("a failed test's issue carries forge's reason: one line, cut to 300 characters, withheld when it reads like a link or a handle", () => {
  assert.equal(failedTest("test_a()", { status: "Failure", reason: null }), "test_a(): Failure");
  assert.equal(failedTest("test_a()", { status: "Failure", reason: "panic: arithmetic underflow or overflow\n(0x11)" }), "test_a(): Failure: panic: arithmetic underflow or overflow (0x11)");
  assert.equal(failedTest("test_a()", { status: "Failure", reason: `revert: ${"x".repeat(400)}` }).length, "test_a(): Failure: ".length + 300);
  assert.equal(failedTest("test_a()", { status: "Failure", reason: "revert: see https://evil.example/x or @someone" }), "test_a(): Failure: (reason withheld: url, handle)");
});

describe("a path that leaves the game's folders", () => {
  const escape = `seq-escape-${process.pid}.sol`;
  const files = { "contracts/src/games/g1/A.sol": "contract A {}\n", [`contracts/src/games/g1/../../../../../../../../tmp/${escape}`]: "contract X {}\n" };
  test("runGates stops at G1: no workspace, no forge", async () => {
    const run = await runGates({ slug: "g1", changes: added(files), files, baseHasSlug: false, prBody: "Fine.", kit: "/nonexistent-kit", order: { seed: "a" } });
    assert.deepEqual(run.results.map((r) => r.gate), ["G1", "G2", "G11", "G12"]);
    assert.equal(run.results[0].ok, false);
    assert.equal(run.game, undefined);
  });
  test("workspace never writes outside itself", { skip }, () => {
    const w = workspace(KIT, files, "g1");
    try {
      assert.ok(existsSync(join(w, "src/games/g1/A.sol")));
      assert.ok(!existsSync(join("/tmp", escape)), "nothing written outside the workspace");
    } finally {
      rmSync(w, { recursive: true, force: true });
    }
  });
});

describe("forge-backed gates", { skip }, () => {
  const files: Record<string, string> = {};
  for (const [n, f] of Object.entries(SRC)) files[`contracts/src/games/planted/${n}.sol`] = f.code;
  for (const [n, f] of Object.entries(TEST)) files[`contracts/test/games/planted/${n}.t.sol`] = f.code;
  files["contracts/src/games/planted/ArrayOk.sol"] = ARRAY_OK;
  files["contracts/test/games/planted/NewSource.t.sol"] = NEW_SOURCE;
  files["contracts/src/games/planted/CheatSrc.sol"] = CHEAT_SRC;
  files["contracts/test/games/planted/CheatCaller.t.sol"] = CHEAT_CALLER;
  let ws = "";
  let c: Awaited<ReturnType<typeof compile>>;
  before(async () => {
    ws = workspace(KIT, files, "planted");
    c = await compile(ws, files, "planted");
    assert.ok(c.ok, c.out);
  });
  after(() => rmSync(ws, { recursive: true, force: true }));

  test("G3: every planted source and test pattern is reported for its own file", () => {
    for (const [n, f] of [...Object.entries(SRC).filter(([n]) => n !== "Payable"), ...Object.entries(TEST)]) {
      const u = [...c.src, ...c.test].find((x) => x.file.endsWith(`/${n}.sol`) || x.file.endsWith(`/${n}.t.sol`))!;
      const r = solPatternGate(c.src.includes(u) ? [u] : [], c.test.includes(u) ? [u] : []);
      assert.equal(r.ok, false, n);
      assert.match(r.issues.join("\n"), f.want, n);
    }
  });

  test("G3 reads a test as written: new <source contract> is not a cheatcode call, and lines are the file's own", () => {
    const u = c.test.find((x) => x.file.endsWith("/NewSource.t.sol"))!;
    const [start, len] = String(u.ast.src).split(":").map(Number);
    assert.equal(start + len, Buffer.byteLength(u.text), "the AST is of the original text");
    assert.deepEqual(solPatternGate([], [u]).issues, [`${u.file}:${ETCH_LINE}: cheatcode vm.etch`]);
  });

  test("G3: a cheatcode reached through an interface in the game's source, at a computed address, is refused", () => {
    const src = c.src.find((x) => x.file.endsWith("/CheatSrc.sol"))!;
    const caller = c.test.find((x) => x.file.endsWith("/CheatCaller.t.sol"))!;
    assert.deepEqual(depGate({ [src.file]: src.text, [caller.file]: caller.text }, "planted").issues, [], "G2 lets the test import the game's own file");
    assert.deepEqual(solPatternGate([], [caller]).issues, [], "the call alone reads like any other");
    assert.deepEqual(solPatternGate([src], [caller]).issues, [`${src.file}:6: declares a function named like a banned cheatcode (etch)`]);
  });

  test("G3: a new array is not a new contract", () => {
    const u = c.src.find((x) => x.file.endsWith("/ArrayOk.sol"))!;
    assert.deepEqual(solPatternGate([u], []).issues, []);
  });

  test("G5: payable functions, receive, a contract that is not a game, interface and spec drift", () => {
    const kitArt = c.artifacts("GameKit.sol").find((a) => a.name === "GameKit")!;
    const kitId = idOf(kitArt.ast, "GameKit")!;
    const one = (n: string) => c.src.filter((u) => u.file.endsWith(`/${n}.sol`));
    const abi = (n: string) => c.artifacts(`${n}.sol`).find((a) => a.name === n)!.abi;
    const spec = { spec: "s", specSha256: sha256("s"), interface: ["f()"], files: ["contracts/src/games/planted/Payable.sol"] };
    const base = { kitId, kitAbi: kitArt.abi as never[], spec, orderSpecSha256: sha256("s"), changed: ["contracts/src/games/planted/Payable.sol"] };
    assert.match(abiGate({ ...base, srcUnits: one("Payable"), abi: abi("Payable") }).issues.join(), /f\(\) is payable/);
    assert.match(abiGate({ ...base, srcUnits: one("Receives"), abi: abi("Receives") }).issues.join(), /receive/);
    assert.match(abiGate({ ...base, srcUnits: one("Creates"), abi: abi("Creates") }).issues.join(), /2 deployable contracts/);
    assert.match(abiGate({ ...base, srcUnits: one("SelfCall"), abi: abi("SelfCall") }).issues.join(), /g\(\) is not in SPEC.json/);
    assert.match(abiGate({ ...base, srcUnits: one("Origin"), abi: abi("Origin"), orderSpecSha256: sha256("other") }).issues.join(), /not the order's/);
    assert.match(abiGate({ ...base, srcUnits: one("Origin"), abi: abi("Origin"), spec: { ...spec, spec: "edited" } }).issues.join(), /does not hash/);
    assert.match(abiGate({ ...base, srcUnits: one("Origin"), abi: abi("Origin"), changed: ["contracts/src/games/planted/Extra.sol"] }).issues.join(), /not in SPEC.json's files/);
    assert.match(abiGate({ ...base, srcUnits: one("Origin"), abi: abi("Origin"), spec: null }).issues.join(), /no SPEC.json/);
  });

  test("G5: SPEC.json's interface is the compiled ABI beyond the kit's; a listed function the ABI lacks, a kit function missing, a selfdestruct-like name all fail", () => {
    const kitArt = c.artifacts("GameKit.sol").find((a) => a.name === "GameKit")!;
    const kitId = idOf(kitArt.ast, "GameKit")!;
    const kitAbi = kitArt.abi as never[];
    const one = (n: string) => c.src.filter((u) => u.file.endsWith(`/${n}.sol`));
    const abi = c.artifacts("Origin.sol").find((a) => a.name === "Origin")!.abi as never[];
    // what the build writes: the ABI's own functions, sorted, none of the kit's
    const iface = gameInterface(abi, kitAbi);
    assert.deepEqual(iface, ["f()"]);
    assert.ok(!iface.includes("fund()"));
    const spec = { spec: "s", specSha256: sha256("s"), interface: iface, files: ["contracts/src/games/planted/Origin.sol"] };
    const base = { srcUnits: one("Origin"), kitId, kitAbi, abi, spec, orderSpecSha256: sha256("s"), changed: ["contracts/src/games/planted/Origin.sol"] };
    assert.deepEqual(abiGate(base).issues, []);
    assert.match(abiGate({ ...base, spec: { ...spec, interface: [...iface, "gone()"] } }).issues.join(), /gone\(\) is in SPEC.json's interface but not in the ABI/);
    assert.match(abiGate({ ...base, spec: { ...spec, interface: [] } }).issues.join(), /f\(\) is not in SPEC.json's interface/);
    const noFund = (abi as { type: string; name?: string }[]).filter((x) => !(x.type === "function" && x.name === "fund"));
    assert.match(abiGate({ ...base, abi: noFund as never[] }).issues.join(), /fund\(\) of the kit is not in the ABI/);
    const sd = { type: "function", name: "selfDestruct", inputs: [], outputs: [], stateMutability: "nonpayable" } as never;
    const withSd = [...abi, sd] as never[];
    assert.match(abiGate({ ...base, abi: withSd, spec: { ...spec, interface: gameInterface(withSd, kitAbi) } }).issues.join(), /selfDestruct\(\) is named like selfdestruct/);
  });

  test("the fixture game passes every gate (G13 needs the order's factory: skipped here)", async () => {
    const f = lastclick();
    const body = "Last Click: each click starts or extends a one-hour round. When it runs out the last clicker wins a tenth of the pot.";
    const run = await runGates({ slug: "lastclick", changes: added(f), files: f, baseHasSlug: false, prBody: body, kit: KIT, order: { seed: "a".repeat(40) } });
    const bad = run.results.filter((r) => !r.ok);
    assert.deepEqual(bad, []);
    assert.deepEqual(run.results.map((r) => r.gate), ["G1", "G2", "G11", "G12", "G3", "G5", "G4", "G6", "G8", "G9", "G7"]);
    assert.ok(run.game?.initCode.startsWith("0x60"));
  });

  test("the reference game the sequencer copies (contracts/{src,test}/games/example) passes every gate", async () => {
    const S = "contracts/src/games/reference/Example.sol", T = "contracts/test/games/reference/Example.t.sol";
    const f: Record<string, string> = {
      [S]: readFileSync(join(KIT, "src/games/example/Example.sol"), "utf8"),
      [T]: readFileSync(join(KIT, "test/games/example/Example.t.sol"), "utf8").replaceAll("games/example/", "games/reference/"),
    };
    f["contracts/src/games/reference/SPEC.json"] = JSON.stringify({ spec: "s", specSha256: sha256("s"), interface: ["click()", "settle()", "leader()", "deadline()", "ROUND()", "PRIZE_BPS()"], files: [S, T] });
    const run = await runGates({ slug: "reference", changes: added(f), files: f, baseHasSlug: false, prBody: "The reference game: the last click wins a tenth of the pot.", kit: KIT, order: { seed: "b".repeat(40) } });
    assert.deepEqual(run.results.filter((r) => !r.ok), []);
    assert.deepEqual(run.results.map((r) => r.gate), ["G1", "G2", "G11", "G12", "G3", "G5", "G4", "G6", "G8", "G9", "G7"]);
  });

  test("the address gate runs when the order names the factory and salt", async () => {
    const f = lastclick();
    const factory = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
    const run = await runGates({ slug: "lastclick", changes: added(f), files: f, baseHasSlug: false, prBody: "Fine.", kit: KIT, order: { seed: "a", factory, safe: "0x00000000000000000000000000000000000005af", salt: keccak256("0x01") } });
    assert.match(run.results.find((r) => r.gate === "G13")!.issues.join(), /not the factory's/, "the fixture's placeholder address is caught");
  });

  describe("planted weak games", () => {
    const f = lastclick();
    const T = "contracts/test/games/lastclick/LastClick.t.sol";
    const S = "contracts/src/games/lastclick/LastClick.sol";
    test("G7: a suite that asserts nothing lets planted bugs survive; G6: no fuzz, no invariant, no conformance", async () => {
      const weak = { ...f, [T]: `// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\n\nimport {Test} from "forge-std/Test.sol";\nimport {LastClick} from "../../../src/games/lastclick/LastClick.sol";\n\ncontract LastClickTest is Test {\n    function test_nothing() public pure {\n        assertTrue(true);\n    }\n}\n` };
      const w = workspace(KIT, weak, "lastclick");
      try {
        const cw = await compile(w, weak, "lastclick");
        assert.ok(cw.ok, cw.out);
        const t = await testsGate(w, "lastclick", cw.test, idOf(cw.artifacts("GameKitConformance.sol")[0]?.ast, "GameKitConformance"));
        assert.match(t.issues.join(), /no fuzz test/);
        assert.match(t.issues.join(), /no invariant test/);
        assert.match(t.issues.join(), /GameKitConformance/);
        const m = await mutationGate(w, "lastclick", cw.src, "seed");
        assert.equal(m.ok, false);
        assert.match(m.issues.join("\n"), /survived/);
      } finally { rmSync(w, { recursive: true, force: true }); }
    });
    test("G8: a function above the gas cap", async () => {
      const heavy = { ...f, [S]: f[S].replace("    function _roundOpen()", "    uint256[] internal log;\n\n    function burn() external whenLive {\n        for (uint256 i; i < 300; ++i) {\n            log.push(i);\n        }\n    }\n\n    function _roundOpen()"), [T]: f[T].replace("    function test_lastClickerIsOwedTenPercent()", "    function test_burn() public {\n        LastClick(address(game)).burn();\n    }\n\n    function test_lastClickerIsOwedTenPercent()") };
      const w = workspace(KIT, heavy, "lastclick");
      try {
        assert.ok((await compile(w, heavy, "lastclick")).ok);
        assert.match((await gasGate(w, "lastclick", "LastClick")).issues.join(), /burn\(\): \d+ gas/);
      } finally { rmSync(w, { recursive: true, force: true }); }
    });
    test("G9: a game whose sweep strands its money fails the conformance run on a fresh anvil", async () => {
      const stuck = { ...f, [S]: f[S].replace("return deadline != 0;", "return true;") };
      const w = workspace(KIT, stuck, "lastclick");
      try {
        assert.ok((await compile(w, stuck, "lastclick")).ok);
        const r = await forkGate(w, "lastclick");
        assert.equal(r.ok, false);
        assert.match(r.issues.join(), /test_conformance_/);
        assert.ok(r.issues.some((i) => /^test_conformance_\w+\(\): Failure: \S/.test(i)), `the revert reason is in the issue: ${r.issues.join(" | ")}`);
      } finally { rmSync(w, { recursive: true, force: true }); }
    });
  });

  test("G13's code hash is the on-chain extcodehash: a real game deployed through the real factory on anvil", async () => {
    const f = lastclick();
    const w = workspace(KIT, f, "lastclick");
    const port = 18_545 + (process.pid % 1000);
    const anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore", detached: true });
    try {
      const cl = await compile(w, f, "lastclick");
      assert.ok(cl.ok, cl.out);
      const rpc = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100; i++) { if (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((x) => x.ok, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }
      const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // anvil #0 (public test key)
      const wallet = createWalletClient({ account, chain: foundry, transport: http(rpc) });
      const pub = createPublicClient({ chain: foundry, transport: http(rpc) });
      const art = (file: string, name: string) => cl.artifacts(file).find((a) => a.name === name)!;
      const deploy = async (a: ReturnType<typeof art>, args: unknown[]) => (await pub.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }) })).contractAddress!;
      const registry = await deploy(art("GameKitConformance.sol", "MockAgentRegistry"), [account.address]);
      const safe = "0x00000000000000000000000000000000000005af" as Address;
      const factory = await deploy(art("GameFactory.sol", "GameFactory"), [safe, registry]);
      const game = art("LastClick.sol", "LastClick");
      const salt = keccak256("0x42");
      const fAbi = art("GameFactory.sol", "GameFactory").abi;
      await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: factory, abi: fAbi, functionName: "deploy", args: [game.bytecode.object, salt] }) });
      const at = getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode: game.bytecode.object });
      const onChain = await pub.getCode({ address: at });
      const kitAst = cl.artifacts("GameKit.sol").find((a) => a.name === "GameKit")!.ast;
      const runtime = runtimeCode(game, kitAst, factory, safe)!;
      assert.equal(keccak256(onChain!), keccak256(runtime), "our runtime is the chain's");
      assert.notEqual(keccak256(game.deployedBytecode.object), keccak256(onChain!), "the compiler's runtime (immutables zeroed) is not");
      const gameJson: GameJson = { slug: "lastclick", title: "Last Click", chainId: 1, address: at, codehash: keccak256(onChain!), abi: [] };
      assert.deepEqual(addressGate(gameJson, { factory, salt, initCode: game.bytecode.object, runtime, slug: "lastclick" }).issues, []);
    } finally {
      try { process.kill(-anvil.pid!, "SIGKILL"); } catch { /* gone */ }
      rmSync(w, { recursive: true, force: true });
    }
  });

  test("mutants: deterministic per seed, each a real edit", () => {
    const f = lastclick();
    const w = workspace(KIT, f, "lastclick");
    return compile(w, f, "lastclick").then((cl) => {
      rmSync(w, { recursive: true, force: true });
      const a = mutants(cl.src, "seed-1");
      assert.deepEqual(a, mutants(cl.src, "seed-1"));
      assert.notDeepEqual(a.map((m) => m.at), mutants(cl.src, "seed-2").map((m) => m.at));
      assert.equal(a.length, 8);
      for (const m of a) assert.notEqual(applyMutant(f[m.file], m), f[m.file]);
    });
  });
});
