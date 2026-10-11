// Re-encode the animated logo for X: H.264 High, yuv420p, 30 fps, CRF 18 capped at 8 Mbps,
// BT.709, no audio, fast-start, no metadata (the container's tags, the encoder's SEI), 1080×1080 (X allows up to
// 1920×1200 for every account). Baked into the engine image as media/dna-logo.mp4. Needs ffmpeg; never runs in the
// enclave.
//   node scripts/encode-logo.ts "<source logo.mp4>"
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = process.argv[2];
if (!src) throw new Error("usage: node scripts/encode-logo.ts <source mp4>");
const tmp = mkdtempSync(join(tmpdir(), "dna-logo-"));
const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
for (const [size, out] of [[1080, "dna-logo.mp4"]] as const) {
  const mid = join(tmp, out);
  ff(["-i", src, "-vf", `scale=${size}:${size}:flags=lanczos,format=yuv420p`, "-r", "30", "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "18",
    "-maxrate", "8M", "-bufsize", "16M", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-an", "-map_metadata", "-1",
    "-bsf:v", "filter_units=remove_types=6", "-f", "mp4", mid]);
  // a bit-exact remux drops the muxer's own encoder tags and moves the index to the front
  ff(["-i", mid, "-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-metadata:s:v:0", "handler_name=Video",
    "-movflags", "+faststart", new URL(`../media/${out}`, import.meta.url).pathname]);
}
rmSync(tmp, { recursive: true });
