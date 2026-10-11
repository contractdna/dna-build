// The images agree with the code that relies on them: the engine image's solc is the workflows' pinned one and the one
// the env lockdown accepts; it carries exactly the game kit the gates copy; the page check's image puts the web app,
// Chromium and the service where the service looks for them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { IMAGE_SOLC } from "../src/enclave.ts";
import { KIT_FILES } from "../src/seq-forge.ts";
import { SEQ } from "../src/sequencer.ts";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const engine = read("engine/Dockerfile");
const ignore = read("engine/Dockerfile.dockerignore");

test("solc: the engine image's binary is the workflows' pin, at the path the lockdown and the gates use", () => {
  const pin = engine.match(/ADD --checksum=sha256:([0-9a-f]{64}) .*solc-linux-amd64-v0\.8\.26\+commit\.8a97fa7a (\S+)/);
  assert.ok(pin, "ADD of the pinned solc");
  for (const wf of [".github/workflows/sequencer-gates.yml", ".github/workflows/sequencer.yml"]) assert.match(read(wf), new RegExp(`SOLC_SHA256: ${pin[1]}`), wf);
  assert.equal(pin[2], IMAGE_SOLC);
  assert.match(engine, new RegExp(`^ENV SEQ_SOLC=${IMAGE_SOLC.replace(/\//g, "\\/")}$`, "m"));
  assert.equal(engine.match(/^ENV /gm)?.length, 1, "no other ENV (the lockdown refuses unknown variables)");
});

test("the engine image has CA certificates (forge's HTTP client refuses to start without them, even for a loopback fork), from the same fixed snapshot as the page check's packages, checked by sha256", () => {
  const pc = read("pagecheck/Dockerfile");
  const snap = (d: string) => [...d.matchAll(/snapshot\.debian\.org\/archive\/(debian(?:-security)?)\/(\d{8}T\d{6}Z) (\S+) main/g)].map((m) => m.slice(1).join(" "));
  assert.equal(snap(engine).length, 3);
  assert.deepEqual(snap(engine), snap(pc), "one snapshot date for both images");
  assert.match(engine, /apt-get -o Acquire::Retries=5 update/);
  const pin = engine.match(/apt-get -o Acquire::Retries=5 download ca-certificates=(\S+) [\s\S]*?echo "([0-9a-f]{64})  ca-certificates_(\S+)_all\.deb" \| sha256sum -c -/);
  assert.ok(pin, "the ca-certificates package is checked against its own sha256");
  assert.equal(pin[1], pin[3]);
  assert.match(engine, /install -y --no-install-recommends \.\/ca-certificates_\S+_all\.deb/);
  assert.match(engine, /test -s \/etc\/ssl\/certs\/ca-certificates\.crt/);
  assert.match(engine, /rm -rf [^\n]*\/var\/lib\/apt\/lists\/\*/);
});

test("three uids, so one container's threads never count against another's process limit: the engine 1000, the forge sandbox 1001 (in the engine's group, for the shared volume), the page check 1002", () => {
  const pc = read("pagecheck/Dockerfile");
  const compose = read("deploy/docker-compose.template.yml");
  assert.match(engine, /^USER node$/m, "the engine: node (1000)");
  assert.match(engine, /echo 'forge:x:1001:1000::\/tmp:\/usr\/sbin\/nologin' >> \/etc\/passwd/);
  assert.match(pc, /echo 'pagecheck:x:1002:1002::\/tmp:\/usr\/sbin\/nologin' >> \/etc\/passwd/);
  assert.match(pc, /echo 'pagecheck:x:1002:' >> \/etc\/group/);
  assert.match(pc, /^USER 1002:1002$/m);
  const svc = (name: string) => compose.match(new RegExp(`^  ${name}:\\n((?: {4}.*\\n|\\s*\\n)*)`, "m"))?.[1] ?? "";
  assert.match(svc("forge"), /^ {4}user: "1001:1000"$/m);
  assert.match(svc("pagecheck"), /^ {4}user: "1002:1002"$/m);
  assert.doesNotMatch(svc("engine"), /user:/, "the engine runs as its image's user");
});

test("the game kit: every file the gates copy is in the image (and let through the build context) at SEQ.kit", () => {
  assert.equal(SEQ.kit, "/app/contracts");
  for (const f of [...KIT_FILES, "lib/forge-std/src"]) {
    assert.ok(ignore.split("\n").includes(`!contracts/${f}`), `dockerignore lets contracts/${f} in`);
    const name = f.split("/").pop()!;
    assert.ok(engine.split("\n").some((l) => l.startsWith("COPY ") && l.includes(`contracts/${f}`) && (l.includes(`./contracts/${f}`) || l.trimEnd().endsWith(`./contracts/${f.slice(0, -name.length)}`))), `COPY contracts/${f}`);
  }
  assert.match(engine, /mkdir -p \/data\/dna \/work && chown node:node \/data\/dna \/work/, "the forge container's shared volume is the runtime user's");
});

test("the page check's image: web/ at /app/web, Debian's Chromium at /usr/bin/chromium, the service on 8090", () => {
  const pc = read("pagecheck/Dockerfile");
  const server = read("pagecheck/src/server.ts");
  assert.match(server, /web: "\/app\/web", chromium: "\/usr\/bin\/chromium"/);
  assert.match(server, /port: 8090/);
  assert.match(pc, /^WORKDIR \/app$/m);
  assert.match(pc, /^COPY web \.\/web$/m);
  assert.match(pc, /^EXPOSE 8090$/m);
  assert.match(pc, /apt-get (?:-o \S+ )*download chromium=(\S+) [\s\S]*sha256sum -c -/, "the chromium package is checked against its own sha256");
  assert.match(pc, /apt-get -o Acquire::Retries=5 update/, "the snapshot archive gets retries");
  assert.match(pc, /snapshot\.debian\.org\/archive\/debian-security\/\d{8}T\d{6}Z bookworm-security/);
  assert.doesNotMatch(pc, /^ENV /m);
});
