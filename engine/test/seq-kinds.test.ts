// What each kind of order may reach, and what none ever reaches, against planted changes: G1 per kind (with NEVER, the
// wall behind every kind), and a site change's G2 and G11.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { runGates } from "../src/seq-forge.ts";
import { type Change, depGate, engineReachGate, NEVER, pathGate, scopeIssue, siteNewIssues, touchLines, webGate } from "../src/seq-gates.ts";
import { KINDS } from "../src/seq-order.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const ch = (path: string, over: Partial<Change> = {}): Change => ({ path, status: "A", mode: "100644", size: 10, ...over });

// ---------------------------------------------------------------- NEVER: every kind

describe("never reachable, whatever the kind", () => {
  const planted: [string, string, RegExp][] = [
    ["the hook", "contracts/src/DNAHook.sol", /the hook/],
    ["the token", "contracts/src/DNAToken.sol", /the token/],
    ["the module registry", "contracts/src/ModuleRegistry.sol", /the core contracts/],
    ["the fee vault", "contracts/src/FeeVault.sol", /the core contracts/],
    ["the policy interfaces", "contracts/src/interfaces/IPolicies.sol", /the core contracts/],
    ["the game kit", "contracts/src/games/GameKit.sol", /the core contracts/],
    ["an existing module", "contracts/src/modules/AdaptiveFee.sol", /the core contracts/],
    ["the compiler settings", "contracts/foundry.toml", /the core contracts/],
    ["a deploy script", "contracts/script/Deploy.s.sol", /the core contracts/],
    ["a workflow", ".github/workflows/ci.yml", /workflows/],
    ["the code owners", ".github/CODEOWNERS", /workflows/],
    ["the enclave lockdown", "engine/src/enclave.ts", /enclave lockdown/],
    ["the config that runs the lockdown", "engine/src/config.ts", /enclave lockdown/],
    ["sealed keys", "engine/src/sealed.ts", /keys/],
    ["the log key's signatures", "engine/src/signed.ts", /keys/],
    ["the key scripts", "scripts/keys.sh", /keys/],
    ["owner approvals", "engine/src/approve.ts", /owner approvals/],
    ["owner signatures", "engine/src/owner-sig.ts", /owner approvals/],
    ["the log", "engine/src/log.ts", /the signed log/],
    ["the log's hashing", "engine/src/canonical.ts", /the signed log/],
    ["a migration", "engine/migrations/014_x.sql", /the signed log/],
    ["the transaction guards", "engine/src/tx.ts", /transaction guards/],
    ["the agent key's queue", "engine/src/keepers.ts", /transaction guards/],
    ["the op table", "engine/src/lib.ts", /transaction guards/],
    ["the mode switch", "engine/src/mode.ts", /enclave lockdown/],
    ["the X client", "engine/src/x.ts", /engine.s voice/],
    ["the post writer", "engine/src/voice.ts", /engine.s voice/],
    ["the owners' channel", "engine/src/telegram.ts", /owners. channel/],
    ["the chain reads", "engine/src/chainref.ts", /chain reads/],
    ["GitHub", "engine/src/github.ts", /GitHub/],
    ["the brain", "engine/src/brain.ts", /the brain/],
    // every file that loads or holds a model prompt (the private bundle's ids and their neutral defaults)
    ...["agents", "character", "card", "studio", "games", "persona"].map((f) => [`the prompts in ${f}.ts`, `engine/src/${f}.ts`, /model prompts and the persona/] as [string, string, RegExp]),
    ["the persona's test", "engine/test/persona.test.ts", /tests of what no order reaches/],
    ["the gates", "engine/src/seq-gates.ts", /own gates/],
    ["the Sequencer", "engine/src/sequencer.ts", /own gates/],
    ["the sequencer's guard", "sequencer/src/guard.ts", /own gates/],
    ["the page check", "pagecheck/src/check.ts", /own gates/],
    ["the spend caps", "engine/src/llm.ts", /spend caps/],
    ["the measured compose", "deploy/app-compose.json", /measured compose/],
    ["the private personality file", "persona/voice.md", /private personality file/],
    ["the wallet guard", "web/app/_ui/guard.ts", /security layer/],
    ["the CSP", "web/security.ts", /security layer/],
    ["a dependency", "web/package.json", /dependencies/],
  ];
  for (const kind of KINDS) {
    for (const [what, path, want] of planted) {
      test(`${kind}: planted: ${what}`, () => {
        const r = pathGate([ch(path)], "some-change", false, kind);
        assert.equal(r.ok, false);
        assert.match(r.issues.join("\n"), new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: never reachable \\(.*${want.source}`));
      });
      test(`${kind}: planted: ${what}, renamed away`, () => {
        assert.match(pathGate([ch("web/app/faq/page.tsx", { status: "R", oldPath: path })], "some-change", false, kind).issues.join("\n"), /never reachable/);
      });
    }
  }
  test("a game's and a module's own folders are not in it", () => {
    for (const p of ["contracts/src/games/dice-1/Dice.sol", "contracts/test/games/dice-1/Dice.t.sol", "contracts/src/modules/tier-fee/TierFee.sol", "contracts/test/modules/tier-fee/TierFee.t.sol", "web/app/g/dice-1/page.tsx"]) {
      assert.equal(NEVER.find(([re]) => re.test(p)), undefined, p);
    }
  });
});

// ---------------------------------------------------------------- site: G1

describe("site: G1 paths", () => {
  // the real base: the site as it is in this repository
  const BASE = { paths: execFileSync("git", ["-C", ROOT, "ls-files"]).toString().split("\n").filter(Boolean) };
  const site = (cs: Change[]) => pathGate(cs, "instinct-1", false, "site", BASE);
  test("a new route folder: its page, components, CSS module and .ts module pass (the first accepted idea's /instinct)", () => {
    assert.ok(BASE.paths.includes("web/app/page.tsx") && !BASE.paths.some((p) => p.startsWith("web/app/instinct/")), "the real site, without the new route");
    assert.deepEqual(site([ch("web/app/instinct/page.tsx"), ch("web/app/instinct/Reading.tsx"), ch("web/app/instinct/instinct.module.css"), ch("web/app/instinct/lines.ts")]).issues, []);
    assert.deepEqual(site([ch("web/app/instinct/page.tsx"), ch("web/app/instinct/week/page.tsx")]).issues, [], "a second new route under the new one");
    assert.deepEqual(site([ch("web/app/lab/notes/page.tsx")]).issues, [], "a new route under an existing one, in a folder of its own");
  });
  for (const [what, cs, want] of [
    ["the home page changed", [ch("web/app/page.tsx", { status: "M" })], /web\/app\/page\.tsx: changed \(a site change only adds new files\)/],
    ["the trade page changed", [ch("web/app/trade/page.tsx", { status: "M" })], /web\/app\/trade\/page\.tsx: changed/],
    ["the swap code changed", [ch("web/app/trade/swap.ts", { status: "M" })], /web\/app\/trade\/swap\.ts: changed/],
    ["an existing page removed", [ch("web/app/xp/page.tsx", { status: "D", mode: "000000" })], /web\/app\/xp\/page\.tsx: deleted/],
    ["an existing page renamed", [ch("web/app/instinct/page.tsx", { status: "R", oldPath: "web/app/xp/page.tsx" })], /renamed/],
    ["an existing page written as new", [ch("web/app/rules/page.tsx")], /web\/app\/rules\/page\.tsx: an existing file/],
    ["a new file beside an existing page", [ch("web/app/trade/Banner.tsx")], /web\/app\/trade\/ already exists/],
    ["a new component in an existing folder", [ch("web/app/docs/Extra.tsx")], /web\/app\/docs\/ already exists/],
    ["a file at the site's root", [ch("web/app/Banner.tsx")], /not in a route folder/],
    ["a route group that would take /", [ch("web/app/(x)/page.tsx")], /not a plain route/],
    ["a route group around a new page", [ch("web/app/(promo)/instinct/page.tsx")], /not a plain route/],
    ["a static page that takes a dynamic route's URL", [ch("web/app/journal/2026-10-12/page.tsx")], /\/journal\/2026-10-12 is a URL the existing route \/journal\/\[day\] serves/],
    ["a private folder", [ch("web/app/instinct/page.tsx"), ch("web/app/instinct/_parts/A.tsx")], /not a plain route/],
    ["a doc", [ch("docs/FAQ.md")], /docs\/FAQ\.md: outside the site's pages/],
    ["an existing doc changed", [ch("docs/ARCHITECTURE.md", { status: "M" })], /outside the site's pages/],
  ] as [string, Change[], RegExp][]) {
    test(`planted: ${what}`, () => {
      const r = site(cs);
      assert.equal(r.ok, false);
      assert.match(r.issues.join("\n"), want);
    });
  }
  test("a catch-all or an optional catch-all at the base takes every URL under it; a route group's page keeps its URL", () => {
    const base = { paths: ["web/app/page.tsx", "web/app/wiki/[...slug]/page.tsx", "web/app/(m)/shop/[[...p]]/page.tsx", "web/app/(m)/about/page.tsx"] };
    const issues = (p: string) => pathGate([ch(p)], "x-1", false, "site", base).issues.join();
    assert.match(issues("web/app/wiki/new/page.tsx"), /the existing route \/wiki\/\[\.\.\.slug\] serves/);
    assert.match(issues("web/app/shop/page.tsx"), /the existing route \/shop\/\[\[\.\.\.p\]\] serves/);
    assert.match(issues("web/app/about/page.tsx"), /the existing route \/about serves/);
    assert.equal(issues("web/app/wikis/page.tsx"), "");
  });
  test("no base tree: nothing to check against, refused", () => {
    assert.match(pathGate([ch("web/app/instinct/page.tsx")], "instinct-1", false, "site").issues.join(), /no base tree/);
  });
  for (const [what, c, want] of [
    ["an API route", ch("web/app/api/kill/[slug]/route.ts", { status: "M" }), /security layer/],
    ["a new route handler", ch("web/app/faq/route.ts"), /not page\.tsx/],
    ["a layout", ch("web/app/faq/layout.tsx"), /not page\.tsx/],
    ["the root layout", ch("web/app/layout.tsx", { status: "M" }), /security layer/],
    ["the play layout", ch("web/app/g/layout.tsx", { status: "M" }), /security layer/],
    ["a game's page", ch("web/app/g/dice-1/page.tsx"), /data, shared shell, games, API, proof/],
    ["the wallet helper", ch("web/app/_ui/tx.ts", { status: "M" }), /security layer/],
    ["the proxy", ch("web/proxy.ts", { status: "M" }), /security layer/],
    ["the next config", ch("web/next.config.ts", { status: "M" }), /security layer/],
    ["the data layer", ch("web/app/_data/source.ts", { status: "M" }), /data, shared shell, games, API, proof/],
    ["the proof pins", ch("web/app/proof/release.json", { status: "M" }), /security layer/],
    ["the proof page's checks", ch("web/app/proof/verify.ts", { status: "M" }), /security layer/],
    ["middleware", ch("web/app/middleware.ts"), /not page\.tsx/],
    ["an icon", ch("web/app/faq/icon.tsx"), /not page\.tsx/],
    ["global CSS", ch("web/app/globals.css", { status: "M" }), /not page\.tsx/],
    ["a public asset", ch("web/public/x.svg"), /outside the site's pages/],
    ["the shared shell", ch("web/app/_ui/Shell.tsx", { status: "M" }), /shared shell/],
    ["the scene", ch("web/app/_dna/DNA.tsx", { status: "M" }), /shared shell/],
    ["the security page", ch("web/app/security/page.tsx", { status: "M" }), /security or Sequencer pages/],
    ["the Sequencer page", ch("web/app/sequencer/page.tsx", { status: "M" }), /security or Sequencer pages/],
    ["the Sequencer's own rules", ch("docs/sequencer.md", { status: "M" }), /outside the site's pages/],
    ["the engine", ch("engine/src/watch.ts", { status: "M" }), /outside the site's pages/],
    ["a dot-dot path", ch("web/app/faq/../../security.ts"), /not a plain path/],
    ["a folder that is not a route", ch("web/app/FAQ Page/page.tsx"), /not a plain route/],
    ["a dynamic route (it could not be opened as it is)", ch("web/app/journal/[day]/Entry.tsx"), /not a plain route/],
    ["a symlink", ch("web/app/faq/page.tsx", { mode: "120000" }), /symlink/],
    ["an executable", ch("web/app/faq/page.tsx", { mode: "100755" }), /mode 100755/],
    ["a binary", ch("web/app/faq/Pic.tsx", { binary: true }), /binary/],
    ["a big file", ch("web/app/faq/page.tsx", { size: 100_001 }), /bytes/],
    ["a type change", ch("web/app/faq/page.tsx", { status: "T" }), /type changed/],
  ] as [string, Change, RegExp][]) {
    test(`planted: ${what}`, () => {
      const r = pathGate([ch("web/app/faq/page.tsx"), c], "faq-page", false, "site", BASE);
      assert.equal(r.ok, false);
      assert.match(r.issues.join("\n"), want);
    });
  }
  test("no changes, a bad name", () => {
    assert.match(pathGate([], "faq-page", false, "site", BASE).issues.join(), /no changes/);
    assert.match(pathGate([ch("web/app/faq/page.tsx")], "FAQ", false, "site", BASE).issues.join(), /not valid/);
  });
  test("scopeIssue is G1's rule, one path at a time", () => {
    assert.equal(scopeIssue("site", "x", "web/app/faq/page.tsx"), null);
    assert.match(scopeIssue("site", "x", "web/app/_ui/guard.ts") ?? "", /never reachable/);
    assert.match(scopeIssue("site", "x", "docs/FAQ.md") ?? "", /outside the site's pages/);
    assert.match(scopeIssue("game", "dice", "web/app/faq/page.tsx") ?? "", /outside the game's folders/);
  });
  test("siteNewIssues is G1's base rule for a plan's files (the build checks its plan with it)", () => {
    assert.deepEqual(siteNewIssues(["web/app/instinct/page.tsx", "web/app/instinct/Reading.tsx"], BASE.paths), []);
    assert.match(siteNewIssues(["web/app/page.tsx"], BASE.paths).join(), /an existing file/);
  });
});

// ---------------------------------------------------------------- site: G2, G11

const page = (body: string, path = "web/app/faq/page.tsx") => ({ [path]: body });
const OK_PAGE = `import type { Metadata } from "next";
import Link from "next/link";
import { getModules } from "../_data/source";
import { Shell } from "../_ui/Shell";
import { PageHead, Section } from "../_ui/ui";
import s from "./faq.module.css";

export const metadata: Metadata = { title: "Questions · DNA", description: "Plain answers. A Safe owner can approve or veto." };

export default async function Faq() {
  const core = await getModules().catch(() => undefined);
  const rows = [["Who decides?", "The brain, inside fixed limits."]] as const;
  return (
    <Shell>
      <PageHead title="Questions" />
      <Section>
        <details open className={s.q}>{rows.map(([q, a]) => <p key={q}>{q} {a}</p>)}</details>
        <p>{core ? "live" : "offline"} {rows.at(0)?.at(1)}</p>
        <Link href="/rules">The rules</Link>
      </Section>
    </Shell>
  );
}
`;

describe("site: G2 dependencies", () => {
  test("react, next/link, next/image, types from next, the shared UI, shell, icons, the data facade and the page's own folder pass", () => {
    assert.deepEqual(depGate(page(OK_PAGE), "faq", "site").issues, []);
    assert.deepEqual(depGate(page(`import { IconX } from "../_ui/icons";\nimport type { Module } from "../_data/types";\nimport { LIVE } from "../_data/flags";\nimport { Answer } from "./Answer";\nexport default function P() { return null; }\n`), "faq", "site").issues, []);
  });
  test("the fee constants pass: the pages that show a fee stay editable", () => {
    assert.deepEqual(depGate(page(`import { FEE, FEE_LINE, PLATFORM_NOTE } from "../_data/launchFee";\nexport default function P() { return FEE_LINE + FEE.ours + PLATFORM_NOTE; }\n`, "web/app/rules/page.tsx"), "rules", "site").issues, []);
  });
  for (const [what, imp] of [
    ["viem", `import { createWalletClient } from "viem";`],
    ["next/server", `import { NextResponse } from "next/server";`],
    ["next/headers", `import { cookies } from "next/headers";`],
    ["a value from next", `import { unstable_after } from "next";`],
    ["the wallet helper", `import { play } from "../_ui/tx";`],
    ["the wallet guard", `import { guardScript } from "../_ui/guard";`],
    ["game code", `import { loadGame } from "../g/game";`],
    ["API code", `import { GET } from "../api/health/route";`],
    ["the CSP", `import { playCsp } from "../../security";`],
    ["a node builtin", `import { readFileSync } from "node:fs";`],
    ["another page's component", `import { Table } from "../rules/Table";`],
    ["a component in a subfolder", `import { A } from "./parts/A";`],
    ["the live feed", `import { LiveProvider } from "../_live/LiveProvider";`],
    ["the scene", `import DNA from "../_dna/DNA";`],
    ["the shared moods", `import { moods } from "../_ui/moods";`],
    ["the database client", `import { db } from "../_data/live";`],
    ["request internals", `import { clientIp } from "../_data/clientIp";`],
    ["a re-export", `export * from "postgres";`],
  ] as [string, string][]) {
    test(`planted: ${what}`, () => assert.equal(depGate(page(`${imp}\nexport default function P() { return null; }\n`), "faq", "site").ok, false));
  }
});

/** The first accepted idea's page as a site change would write it: a new static route reading the data layer's getters,
 *  with a component, a CSS module and a .ts module of its own folder. */
const INSTINCT: Record<string, string> = {
  "web/app/instinct/page.tsx": `import type { Metadata } from "next";
import Link from "next/link";
import { getJournal, getLab } from "../_data/source";
import { Shell } from "../_ui/Shell";
import { PageHead, Section, ui } from "../_ui/ui";
import { Reading } from "./Reading";
import s from "./instinct.module.css";
import { headline } from "./lines";

export const metadata: Metadata = { title: "Instinct · DNA", description: "What DNA leans toward right now, read from its journal and its lab." };

export default async function InstinctPage() {
  const [journal, lab] = await Promise.all([getJournal().catch(() => []), getLab().catch(() => undefined)]);
  const last = journal.at(0);
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead title="Instinct" lede="What DNA leans toward right now." back={{ href: "/lab", label: "Lab" }} />
        <Section title="Today">
          <Reading line={headline(lab?.experiments.length ?? 0)} />
          {last ? <Link className={s.more} href={\`/journal/\${last.date}\`}>The latest journal entry</Link> : <p className={s.quiet}>Nothing written yet.</p>}
          <a className={s.up} href="#main">Back to the top</a>
        </Section>
      </div>
    </Shell>
  );
}
`,
  "web/app/instinct/Reading.tsx": `import s from "./instinct.module.css";

export function Reading({ line }: { line: string }) {
  return <p className={s.reading}>{line}</p>;
}
`,
  "web/app/instinct/instinct.module.css": ".reading { font-size: 1.25rem; }\n.more, .up { text-decoration: underline; }\n.quiet { opacity: 0.7; }\n",
  "web/app/instinct/lines.ts": `export const headline = (n: number) => (n === 0 ? "No experiment is running, so it is watching." : \`\${n} experiments are running, so it is testing.\`);
`,
};

describe("site: G11 code", () => {
  test("a new static route reading the data layer (/instinct, the first accepted idea) passes G1, G2 and G11", () => {
    const basePaths = execFileSync("git", ["-C", ROOT, "ls-files"]).toString().split("\n").filter(Boolean);
    const changes = Object.entries(INSTINCT).map(([path, t]) => ch(path, { size: t.length }));
    assert.deepEqual([...pathGate(changes, "instinct-1", false, "site", { paths: basePaths }).issues, ...depGate(INSTINCT, "instinct-1", "site").issues, ...webGate(INSTINCT, "instinct-1", "site").issues], []);
  });
  test("a server page with its metadata passes: no \"use client\" needed, an attribute named open is no global", () => {
    assert.deepEqual(webGate(page(OK_PAGE), "faq", "site").issues, []);
    assert.deepEqual(webGate({ "web/app/faq/faq.module.css": ".q { color: red; }" }, "faq", "site").issues, []);
  });
  for (const [what, body, want] of [
    ["window", `export default function P() { return <p>{window.location.href}</p>; }`, /window/],
    ["fetch", `export default async function P() { await fetch("/x"); return null; }`, /fetch/],
    ["process.env", `export default function P() { return <p>{process.env.DATABASE_URL}</p>; }`, /process/],
    ["a server action", `export default function P() { async function go() { "use server"; } return <p onClick={go} />; }`, /use server/],
    ["dangerouslySetInnerHTML", `export default function P() { return <div dangerouslySetInnerHTML={{ __html: "x" }} />; }`, /dangerouslySetInnerHTML/],
    ["a frame", `export default function P() { return <iframe />; }`, /<iframe>/],
    ["a form", `export default function P() { return <form />; }`, /<form>/],
    ["computed access", `const m = { a: 1 }; export default function P({ k }: { k: "a" }) { return <p>{m[k]}</p>; }`, /computed member access/],
    ["eval", `export default function P() { return <p>{eval("1")}</p>; }`, /eval/],
    ["a dynamic import", `export default async function P() { await import("../_data/source"); return null; }`, /dynamic import/],
    ["a URL", `export default function P() { return <a href="https://x.example">x</a>; }`, /:\\\/\\\//],
    ["a wallet method", `export default function P() { return <p>{"eth_sendTransaction"}</p>; }`, /eth_/],
    ["an address", `export default function P() { return <p>0x5FbDB2315678afecb367f032d93F642f64180aa3</p>; }`, /address literal/],
    ["route segment config", `export const dynamic = "force-dynamic";\nexport default function P() { return null; }`, /exports only its default and its metadata/],
    ["a CSS url()", `.q { background: url(/x.png); }`, /url\(\)/],
    // a site page is server-rendered HTML only
    ["a client page", `"use client";\nexport default function P() { return <p>hi</p>; }`, /"use client" \(a site page renders on the server only\)/],
    ["the click that leaves the site", `"use client";\nimport { useRef } from "react";\nexport default function P() { const r = useRef<HTMLAnchorElement>(null); return <p ref={(a) => { if (a) { a.href = "/" + "/evil.example"; a.click(); } }}>x</p>; }`, /"use client"/],
    ["an onClick handler", `export default function P() { return <button onClick={() => {}}>Go</button>; }`, /event handler onClick/],
    ["an onclick attribute", `export default function P() { return <p onclick="x">Go</p>; }`, /onclick/],
    // its words: what the public text screen refuses in a post
    ["a handle in the page's text", `export default function P() { return <p>Follow @someone for more</p>; }`, /a handle in the page's text/],
    ["a cashtag in the page's text", `export default function P() { return <p>Better than $PEPE</p>; }`, /a cashtag in the page's text/],
    ["a handle in a string", `const who = "@someone";\nexport default function P() { return <p>{who}</p>; }`, /a handle in the page's text/],
    ["another site's name", `export default function P() { return <p>Claim it at evil.example today</p>; }`, /another site's name or link/],
    // links stay on the site
    ["a link built off the site", `export default function P() { return <a href={"/" + "/evil.example"}>x</a>; }`, /href must be a path on this site/],
    ["a link with a tab after the slash", `export default function P() { return <a href="/\t/evil.example">x</a>; }`, /href must be a path on this site/],
    ["a link from a variable", `const to = "/rules";\nexport default function P() { return <a href={to}>x</a>; }`, /href must be a path on this site/],
    ["a template link that starts with the host", `export default function P({ h }: { h: string }) { return <a href={\`/\${h}\`}>x</a>; }`, /href must be a path on this site/],
    ["a built link handed to a shared component", `import { PageHead } from "../_ui/ui";\nexport default function P() { return <PageHead title="x" lede="y" back={{ href: "/" + "/evil.example", label: "Back" }} />; }`, /href must be a path on this site/],
    ["a link handed on by its name", `import { PageHead } from "../_ui/ui";\nconst href = "/lab";\nexport default function P() { return <PageHead title="x" lede="y" back={{ href, label: "Back" }} />; }`, /href must be a path on this site/],
    ["an image from another site", `export default function P() { return <img alt="" src={"/" + "/evil.example/x.png"} />; }`, /src must be a path on this site/],
    // no raw HTML or head tags by another way
    ["a spread attribute", `const p = { title: "x" };\nexport default function P() { return <div {...p} />; }`, /a spread attribute/],
    ["raw HTML by a string key", `import { cloneElement } from "react";\nexport default function P() { return cloneElement(<div />, { ["dangerouslySetInnerHTML"]: { __html: "<b>x</b>" } }); }`, /cloneElement|dangerouslySetInnerHTML|__html/],
    ["a style tag", `export default function P() { return <style>{"body { display: none }"}</style>; }`, /<style>/],
    ["metadata beyond a title and a description", `export const metadata = { title: "x", icons: { icon: "/x.png" } };\nexport default function P() { return null; }`, /metadata is an object with a title and a description only/],
    ["metadata changed after the check", `import type { Metadata } from "next";\nexport const metadata: Metadata = { title: "x" };\n(metadata as Metadata).openGraph = { title: "y" };\nexport default function P() { return null; }`, /metadata is named only as its one const export/],
    ["metadata as a let", `export let metadata = { title: "x" };\nexport default function P() { return null; }`, /metadata is a const/],
    // a tag is an intrinsic or a name the file binds as an import, a function or a const arrow
    ["a script by a variable tag", `const S = ("scr" + "ipt") as "div";\nexport default function P() { return <S>{"alert(1)"}</S>; }`, /<S> is not an import, a function declaration or a const arrow/],
    ["a tag from a parameter", `export default function P({ T }: { T: "div" }) { return <T>x</T>; }`, /<T> is not an import/],
    ["an import shadowed by a parameter", `import Link from "next/link";\nexport default function P({ Link }: { Link: "div" }) { return <Link>x</Link>; }`, /<Link> is not an import/],
    ["a tag by a member", `import * as R from "react";\nexport default function P() { return <R.Fragment>x</R.Fragment>; }`, /a tag is a plain name/],
    ["a namespaced attribute", `export default function P() { return <a xlink:href="/rules">x</a>; }`, /a namespaced attribute xlink:href/],
    ["next/link's as", `import Link from "next/link";\nexport default function P() { return <Link href="/rules" as="/x">x</Link>; }`, /attribute as/],
  ] as [string, string, RegExp][]) {
    test(`planted: ${what}`, () => {
      const files = what === "a CSS url()" ? { "web/app/faq/faq.module.css": body } : page(body);
      assert.match(webGate(files, "faq", "site").issues.join("\n"), want);
    });
  }
  test("a tag the file binds as a function declaration or a const arrow passes, as an imported one does", () => {
    assert.deepEqual(webGate(page(`import { Section } from "../_ui/ui";\nconst Row = ({ q }: { q: string }) => <p>{q}</p>;\nfunction Head() { return <h1>x</h1>; }\nexport default function P() { return <Section><Head /><Row q="a" /></Section>; }\n`), "faq", "site").issues, []);
  });
  test("a component (not page.tsx) may export what it likes; the reach rules still hold", () => {
    assert.deepEqual(webGate(page(`export const N = 1;\nexport function A() { return <p>{N}</p>; }\n`, "web/app/faq/Answer.tsx"), "faq", "site").issues, []);
    assert.match(webGate(page(`export function A() { return <p>{document.title}</p>; }\n`, "web/app/faq/Answer.tsx"), "faq", "site").issues.join(), /document/);
  });
  test("an existing simple page passes as written (the shape a new page takes)", () => {
    const p = "web/app/xp/page.tsx";
    const files = { [p]: readFileSync(`${ROOT}${p}`, "utf8") };
    assert.deepEqual([...webGate(files, "x", "site").issues, ...depGate(files, "x", "site").issues], []);
  });
});

// ---------------------------------------------------------------- engine: G1, G2

describe("engine: G1 paths (its tests required)", () => {
  test("a source file with its test, and a test fixture: added, changed or removed", () => {
    assert.deepEqual(pathGate([ch("engine/src/watch.ts", { status: "M" }), ch("engine/test/watch.test.ts"), ch("engine/test/fixtures/watch/blocks.json"), ch("engine/src/old.ts", { status: "D", mode: "000000" })], "retry-fix", false, "engine").issues, []);
  });
  test("planted: a test removed while its code stays; removed together, it passes", () => {
    const watch = [ch("engine/src/watch.ts", { status: "M" }), ch("engine/test/watch.test.ts")];
    assert.match(pathGate([...watch, ch("engine/test/games.test.ts", { status: "D", mode: "000000" })], "x", false, "engine").issues.join(), /engine\/test\/games\.test\.ts: a test removed while engine\/src\/games\.ts stays/);
    assert.match(pathGate([...watch, ch("engine/test/fixtures/watch/blocks.json", { status: "D", mode: "000000" })], "x", false, "engine").issues.join(), /a test removed while engine\/src\/blocks\.ts stays/);
    assert.deepEqual(pathGate([...watch, ch("engine/src/old.ts", { status: "D", mode: "000000" }), ch("engine/test/old.test.ts", { status: "D", mode: "000000" })], "retry-fix", false, "engine").issues, []);
  });
  for (const t of ["github", "brain", "brain-db", "proof", "voice", "swap", "live-x", "records.typecheck"]) {
    test(`planted: the tests of what no order reaches: engine/test/${t}${t.includes(".") ? "" : ".test"}.ts`, () => {
      const p = `engine/test/${t}${t.includes(".") ? "" : ".test"}.ts`;
      assert.match(pathGate([ch(p, { status: "M" })], "x", false, "engine").issues.join(), /tests of what no order reaches/);
    });
  }
  test("planted: a source change without a test", () => {
    assert.match(pathGate([ch("engine/src/watch.ts", { status: "M" })], "retry-fix", false, "engine").issues.join(), /needs its tests/);
    assert.match(pathGate([ch("engine/src/watch.ts", { status: "M" }), ch("engine/test/watch.test.ts", { status: "D", mode: "000000" })], "retry-fix", false, "engine").issues.join(), /needs its tests/, "a deleted test is no test");
  });
  for (const [what, path, want] of [
    ["the enclave lockdown", "engine/src/enclave.ts", /enclave lockdown/],
    ["the transaction guards", "engine/src/tx.ts", /transaction guards/],
    ["the agent key's queue", "engine/src/keepers.ts", /transaction guards/],
    ["the op table", "engine/src/lib.ts", /transaction guards/],
    ["the mode switch", "engine/src/mode.ts", /enclave lockdown/],
    ["the log", "engine/src/log.ts", /signed log/],
    ["owner approvals", "engine/src/approve.ts", /owner approvals/],
    ["owner signatures", "engine/src/owner-sig.ts", /owner approvals/],
    ["keys", "engine/src/sealed.ts", /keys/],
    ["the gates", "engine/src/seq-gates.ts", /own gates/],
    ["the gates' tests", "engine/test/seq-gates.test.ts", /tests of what no order reaches/],
    ["the Sequencer's tests", "engine/test/sequencer-db.test.ts", /tests of what no order reaches/],
    ["the anonymity guard's tests", "engine/test/anonymity.test.ts", /tests of what no order reaches/],
    ["a planted gate fixture", "engine/test/fixtures/seq/lastclick/web/app/g/lastclick/page.tsx", /tests of what no order reaches/],
    ["a migration", "engine/migrations/015_x.sql", /signed log/],
    ["the engine's packages", "engine/package.json", /dependencies/],
    ["the image", "engine/Dockerfile", /not an engine source or test file/],
    ["a script", "engine/scripts/compose.ts", /not an engine source or test file/],
    ["the model registry", "engine/models.json", /not an engine source or test file/],
    ["the brain's context", "engine/brain/context.md", /not an engine source or test file/],
    ["a source in a subfolder", "engine/src/x/y.ts", /not an engine source or test file/],
    ["the site", "web/app/page.tsx", /not an engine source or test file/],
  ] as [string, string, RegExp][]) {
    test(`planted: ${what}`, () => {
      const r = pathGate([ch("engine/src/watch.ts", { status: "M" }), ch("engine/test/watch.test.ts"), ch(path, { status: "M" })], "retry-fix", false, "engine");
      assert.equal(r.ok, false);
      assert.match(r.issues.join("\n"), want);
    });
  }
});

describe("engine: G2 dependencies", () => {
  const src = (imp: string) => ({ "engine/src/watch.ts": `${imp}\nexport const x = 1;\n` });
  test("its own files, node's builtins, the packages it has", () => {
    assert.deepEqual(depGate(src(`import { readFileSync } from "node:fs";\nimport { z } from "zod";\nimport { type Hex } from "viem";\nimport { privateKeyToAccount } from "viem/accounts";\nimport { d } from "./config.ts";\nimport postgres from "postgres";\nconst t = await import("./telegram.ts");`), "x", "engine").issues, []);
    assert.deepEqual(depGate({ "engine/test/watch.test.ts": `import { x } from "../src/watch.ts";\nimport { test } from "node:test";` }, "x", "engine").issues, []);
  });
  for (const [what, imp, path] of [
    ["a new package", `import axios from "axios";`],
    ["a scoped package it doesn't have", `import { x } from "@evil/pkg";`],
    ["child processes", `import { spawn } from "node:child_process";`],
    ["vm", `import vm from "node:vm";`],
    ["workers", `import { Worker } from "node:worker_threads";`],
    ["createRequire", `import { createRequire } from "node:module";`],
    ["a path out of the engine", `import { x } from "../../web/security.ts";`],
    ["a dynamic import of a computed name", `const m = "x"; await import(m);`],
    ["a dynamic import of a package it doesn't have", `await import("left-pad");`],
    ["require", `const fs = require("fs");`],
    ["a dev-only package", `import Ajv from "ajv";`],
    ["another dev-only package", `import { x } from "@phala/dcap-qvl";`],
    ["eval", `export const y = eval("1");`],
    ["Function", `export const f = Function("return 1");`],
    ["new Function", `export const f = new Function("return 1");`],
    ["process.binding", `export const b = process.binding("fs");`],
    ["process.dlopen", `export const d = process.dlopen;`],
    ["process.mainModule", `export const m = process.mainModule;`],
    ["process by a computed name", `export const e = process["env"];`],
    ["import.meta other than its url", `export const r = import.meta.resolve("./x.ts");`],
    ["import.meta.dirname", `export const d = import.meta.dirname;`],
    ["env from node:process", `import { env } from "node:process";\nexport const k = env.KEY;`],
    ["process under another name", `const proc = process;\nexport const k = proc["env"];`],
    ["process.getBuiltinModule", `export const fs = process.getBuiltinModule("fs");`],
    ["process through globalThis", `export const k = globalThis.process.env.KEY;`],
    ["env destructured from process", `const { env } = process;\nexport const k = env.KEY;`],
    ["process.env passed whole", `export const all = Object.keys(process.env);`],
    ["Reflect", `export const k = Reflect.get(process, "env");`],
    ["a function's constructor", `export const f = (() => {}).constructor("return 1");`],
    ["constructor by name", `export const f = (() => {})["constructor"];`],
    ["eval assembled from globalThis", `export const f = globalThis["ev" + "al"];`],
    ["a test importing the transaction guards", `import { send } from "../src/tx.ts";`, "engine/test/watch.test.ts"],
    ["a test importing the config (no extension)", `import { d } from "../src/config";`, "engine/test/watch.test.ts"],
    ["a test importing the Telegram channel dynamically", `const t = await import("../src/telegram.ts");`, "engine/test/watch.test.ts"],
  ] as [string, string, string?][]) {
    test(`planted: ${what}`, () => {
      const files = path ? { [path]: `${imp}\nexport const x = 1;\n` } : src(imp);
      const r = depGate(files, "x", "engine");
      assert.equal(r.ok, false);
      if (path) assert.match(r.issues.join("\n"), /a test of what no order reaches/);
    });
  }
  test("import.meta.url and a test of the engine's own code pass", () => {
    assert.deepEqual(depGate(src(`export const u = import.meta.url;\nexport const fresh = new URL("./x", import.meta.url);`), "x", "engine").issues, []);
  });
});

describe("engine: G16 reach, against the base, and the touch report", () => {
  const ch2 = (path: string, status: Change["status"] = "M") => ch(path, { status });
  const run = (head: string, base = "", path = "engine/src/watch.ts") => engineReachGate([ch2(path, base ? "M" : "A")], { [path]: head }, base ? { [path]: base } : {});
  test("an edit that reads and sends nothing new passes", () => {
    const base = `import { d } from "./config.ts";\nexport const a = process.env.A;\nexport async function get() { return fetch("https://rpc.example/x"); }\n`;
    assert.deepEqual(run(`${base}export const b = 2;\n`, base).result.issues, []);
  });
  for (const [what, head, base, want] of [
    ["a new environment name", `export const a = process.env.A;\nexport const k = process.env.KEY;\n`, `export const a = process.env.A;\n`, /new environment reads \(KEY\)/],
    ["a swapped environment name (same count)", `export const a = process.env.KEY;\n`, `export const a = process.env.A;\n`, /new environment reads \(KEY\)/],
    ["a postgres client in a file that had no network", `import postgres from "postgres";\nexport const db = postgres("postgres://x");\n`, `export const a = 1;\n`, /a network sink in a file that had none/],
    ["a viem http transport", `import { http } from "viem";\nexport const t = http("https://rpc.example");\n`, `export const a = 1;\n`, /a network sink in a file that had none/],
    ["a viem webSocket transport", `import { webSocket } from "viem";\nexport const t = webSocket("wss://rpc.example");\n`, `export const a = 1;\n`, /a network sink in a file that had none/],
    ["the dstack SDK", `import { DstackClient } from "@phala/dstack-sdk";\nexport const c = DstackClient;\n`, `export const a = 1;\n`, /a network sink in a file that had none/],
    ["fetch in a file that had no network", `export async function leak(x: string) { await fetch("/api"); }\n`, `export const a = 1;\n`, /a network sink in a file that had none/],
    ["a WebSocket in a new file", `export const s = new WebSocket("wss://x.example");\n`, "", /a network sink in a file that had none/],
    ["node:https in a file that had no network", `import { request } from "node:https";\nexport const r = request;\n`, `export const a = 1;\n`, /a network sink/],
    ["node:dns", `import { lookup } from "node:dns";\nexport const l = lookup;\n`, `export const a = 1;\n`, /a network sink/],
    ["a new host in a file that already fetched", `export const g = () => fetch("https://evil.example/c");\n`, `export const g = () => fetch("https://rpc.example/x");\n`, /a new URL host "evil\.example"/],
  ] as [string, string, string, RegExp][]) {
    test(`planted: ${what}`, () => assert.match(run(head, base).result.issues.join("\n"), want));
  }
  test("the touch report: lines, every watched module used and the change in its calls, new env names, node:fs/os, eval, new URLs and host-like text, strings built for a sink", () => {
    const base = `import { alert } from "./telegram.ts";\nexport const x = 1;\nexport const y = 2;\nexport const f = () => alert("a", "k");\n`;
    const head = [
      `import { alert } from "./telegram.ts";`, `import { send } from "./tx.ts";`, `import * as gh from "./github.ts";`, `import { readFileSync } from "node:fs";`,
      `export const x = 1;`, `export const f = () => alert("a", "k");`, `export const g = async (to: string) => { await send(to); await gh.merge(1, "s"); const t = await import("./llm.ts"); return (await import("./sealed.ts")).unseal(t); };`,
      `export const u = "https://new.example/z";`, `export const h = "exfil.example";`, `export const k = process.env.TOKEN;`, `export const e = eval;`,
      `export const p = (id: string) => fetch(\`/x/\${id}\`);`,
    ].join("\n") + "\n";
    const [t] = run(head, base).touch;
    assert.deepEqual([t.plus, t.minus], [9, 1]);
    assert.deepEqual(t.imports, ["github", "llm", "sealed", "telegram", "tx"], "static and import(…) alike");
    assert.deepEqual(t.calls, { "tx.send": 1, "github.merge": 1, "sealed.unseal": 1 });
    assert.deepEqual([t.env, t.fsOs, t.evals, t.urls, t.hosts], [["TOKEN"], ["node:fs"], true, ["https://new.example/z"], ["exfil.example"]]);
    assert.match(t.built.join(), /fetch\(…\) at line 12/);
    assert.match(touchLines([t])[0], /^engine\/src\/watch\.ts \+9\/-1; uses github, llm, sealed, telegram, tx; calls tx\.send \+1, github\.merge \+1, sealed\.unseal \+1; new env TOKEN; node:fs; eval\/Function; URLs https:\/\/new\.example\/z; hosts exfil\.example; built for a sink: fetch/);
    assert.deepEqual(run(base, base).touch[0].calls, {}, "an unchanged call count is no change");
  });
});

test("the engine never approves a pull request: its GitHub client has no review call (its token is the code owner's)", () => {
  const src = readFileSync(`${ROOT}engine/src/github.ts`, "utf8");
  assert.doesNotMatch(src, /\/reviews\b/);
  assert.doesNotMatch(src, /\bAPPROVE\b/);
  assert.match(NEVER.find(([re]) => re.test("engine/src/github.ts"))?.[1] ?? "", /GitHub/, "and no engine change may add one");
});

test("runGates: an engine change runs its static gates only (paths with its tests, imports, text); nothing of it runs", async () => {
  const files = { "engine/src/watch.ts": "export const x = 1;\n", "engine/test/watch.test.ts": `import { x } from "../src/watch.ts";\nimport { test } from "node:test";\ntest("x", () => {});\n` };
  const changes = Object.entries(files).map(([path, t]) => ch(path, { size: t.length, status: "M" }));
  const run = await runGates({ kind: "engine", slug: "retry-fix", changes, files, baseHasSlug: false, prBody: "Retries a failed watch read once.", kit: "/nonexistent-kit", order: { seed: "a" } });
  assert.deepEqual(run.results.map((r) => [r.gate, r.ok]), [["G1", true], ["G2", true], ["G12", true], ["G16", true]]);
  const bad = await runGates({ kind: "engine", slug: "retry-fix", changes: [...changes, ch("engine/src/tx.ts", { status: "M" })], files, baseHasSlug: false, prBody: "Fine.", kit: "/nonexistent-kit", order: { seed: "a" } });
  assert.match(bad.results[0].issues.join(), /engine\/src\/tx\.ts: never reachable \(the transaction guards\)/);
});

test("runGates: a site change runs the static gates only (no workspace, no forge)", async () => {
  const files = { ...page(OK_PAGE), "web/app/faq/faq.module.css": ".q { color: red; }\n" };
  const changes = Object.entries(files).map(([path, t]) => ch(path, { size: t.length }));
  const basePaths = execFileSync("git", ["-C", ROOT, "ls-files"]).toString().split("\n").filter(Boolean);
  const run = await runGates({ kind: "site", slug: "faq-page", changes, files, baseHasSlug: false, basePaths, prBody: "A questions page with plain answers.", kit: "/nonexistent-kit", order: { seed: "a" } });
  assert.deepEqual(run.results.map((r) => [r.gate, r.ok]), [["G1", true], ["G2", true], ["G11", true], ["G12", true]]);
  assert.equal(run.game, undefined);
  const bad = await runGates({ kind: "site", slug: "faq-page", changes: [...changes, ch("web/app/_ui/guard.ts", { status: "M" })], files, baseHasSlug: false, basePaths, prBody: "Fine.", kit: "/nonexistent-kit", order: { seed: "a" } });
  assert.equal(bad.results[0].ok, false);
  const blind = await runGates({ kind: "site", slug: "faq-page", changes, files, baseHasSlug: false, prBody: "A questions page with plain answers.", kit: "/nonexistent-kit", order: { seed: "a" } });
  assert.match(blind.results[0].issues.join(), /no base tree/, "no base paths: G1 refuses");
});
