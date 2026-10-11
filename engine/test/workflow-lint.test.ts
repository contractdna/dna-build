// The workflow lint, against planted violations, and the repo's own workflows.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { lintWorkflow } from "../scripts/workflow-lint.ts";

const SHA = "11d5960a326750d5838078e36cf38b85af677262";
const ok = (body: string) => `name: x\non: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${body}`;

test("the repo's workflows are clean", () => {
  const dir = new URL("../../.github/workflows/", import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".yml"))) assert.deepEqual(lintWorkflow(f, readFileSync(dir + f, "utf8")), [], f);
});

test("a pinned, permissioned workflow passes", () => {
  assert.deepEqual(lintWorkflow("x.yml", ok(`      - uses: actions/checkout@${SHA} # v4.4.0\n      - uses: ./local\n`)), []);
});

for (const [what, file, text, want] of [
  ["a tag-pinned action", "x.yml", ok("      - uses: actions/checkout@v4\n"), /not pinned/],
  ["a branch-pinned action", "x.yml", ok("      - uses: some/action@main\n"), /not pinned/],
  ["a short sha", "x.yml", ok("      - uses: some/action@11d5960\n"), /not pinned/],
  ["a docker action", "x.yml", ok("      - uses: docker://alpine:3\n"), /docker action/],
  ["pull_request_target", "x.yml", `name: x\non:\n  pull_request_target:\npermissions: {}\njobs: {}\n`, /pull_request_target/],
  ["no top-level permissions", "x.yml", `name: x\non: push\njobs:\n  a:\n    permissions:\n      contents: read\n`, /no top-level permissions/],
  ["a secret outside the allow-list", "ci.yml", ok("      - run: echo ${{ secrets.KEEPER_PRIVATE_KEY }}\n"), /KEEPER_PRIVATE_KEY is not allowed/],
  ["the LLM key outside sequencer.yml", "sequencer-gates.yml", ok("      - env: { K: '${{ secrets.OPENROUTER_API_KEY_SEQUENCER }}' }\n"), /not allowed/],
  ["dynamic secrets", "x.yml", ok("      - run: echo '${{ toJSON(secrets) }}'\n"), /dynamically/],
  ["actions/cache in the Sequencer", "sequencer.yml", ok(`      - uses: actions/cache@${SHA}\n`), /actions\/cache/],
  ["a setup cache input in the Sequencer", "sequencer-gates.yml", ok(`      - uses: actions/setup-node@${SHA}\n        with:\n          cache: npm\n`), /cache input/],
  ["a cache path input in the Sequencer", "sequencer.yml", ok(`      - uses: actions/setup-node@${SHA}\n        with:\n          cache-dependency-path: x\n`), /cache input/],
  ["a job granting write", "x.yml", `name: x\non: push\npermissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n`, /grants write/],
  ["write-all", "x.yml", `name: x\non: push\npermissions: {}\njobs:\n  a:\n    permissions: write-all\n`, /grants write/],
  ["a job granting write in a flow mapping", "x.yml", `name: x\non: push\npermissions: {}\njobs:\n  a:\n    permissions: { contents: write }\n`, /grants write/],
  ["top-level write-all", "x.yml", `name: x\non: push\npermissions: write-all\njobs: {}\n`, /grants write/],
  ["top-level write in a flow mapping", "x.yml", `name: x\non: push\npermissions: { contents: read, issues: write }\njobs: {}\n`, /grants write/],
  ["top-level write in a block", "x.yml", `name: x\non: push\npermissions:\n  contents: write\njobs: {}\n`, /grants write/],
  ["secrets: inherit", "x.yml", `name: x\non: push\npermissions: {}\njobs:\n  a:\n    uses: ./.github/workflows/y.yml\n    secrets: inherit\n`, /secrets: inherit/],
  ["workflow_run", "x.yml", `name: x\non:\n  workflow_run:\n    workflows: [ci]\npermissions: {}\njobs: {}\n`, /workflow_run/],
  ["issue_comment", "x.yml", `name: x\non: [issue_comment]\npermissions: {}\njobs: {}\n`, /issue_comment/],
  ["a cache input in a flow mapping", "sequencer.yml", ok(`      - uses: foundry-rs/foundry-toolchain@${SHA}\n        with: { version: v1, cache: true }\n`), /cache input/],
] as [string, string, string, RegExp][]) {
  test(`planted: ${what}`, () => assert.match(lintWorkflow(file, text).join("\n"), want));
}
