// After `SITE_ROLE=play next build`: start the play origin and check a game address that doesn't exist is a plain 404
// (not a 500 from main-site chrome that needs the live feed), and the kill check answers.
//   node scripts/check-play-start.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const WEB = new URL("..", import.meta.url).pathname;
const port = await new Promise((ok) => { const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const child = spawn(process.execPath, [`${WEB}node_modules/next/dist/bin/next`, "start", "-p", String(port)], { cwd: WEB, env: { ...process.env, SITE_ROLE: "play" }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
const bad = [];
try {
  for (let i = 0; ; i++) {
    try { await fetch(`${base}/api/kill/x`); break; } catch { if (i > 150) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
  }
  const nf = await fetch(`${base}/g/no-such-game`, { redirect: "manual" });
  if (nf.status !== 404) bad.push(`/g/no-such-game: ${nf.status}, want 404`);
  if (!/no game at this address/.test(await nf.text())) bad.push("/g/no-such-game: not the play not-found page");
  const kill = await fetch(`${base}/api/kill/x`);
  if (kill.status !== 200) bad.push(`/api/kill/x: ${kill.status}, want 200`);
} finally { child.kill(); }
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
console.log("play start: 404 page and kill check ok");
