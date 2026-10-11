// One colour mood per section for the inner pages' helix field (ParticleField) and its no-WebGL gradient (PageHead).
// Plain module, not "use client": the server-rendered PageHead reads it too. Colours: the homepage palette (_dna/scene.js).
// Every section shares one base light (an amber key, a blue/lilac rim); a mood only shifts it a little (tint below).
export const MOODS = {
  live: ["#4fd6c8", "#9fd8ff", "#86eadf", "#57e0c7"],
  lab: ["#4fd6c8", "#8a5cf0", "#ff86bb", "#cdb6ff"],
  mind: ["#8a5cf0", "#cdb6ff", "#b195ff", "#9fd8ff"],
  memory: ["#4fd6c8", "#cdb6ff", "#86eadf", "#8a5cf0"],
  mystery: ["#cdb6ff", "#8a5cf0", "#ff86bb", "#d24aa8"],
  rules: ["#ff86bb", "#ff6f5e", "#d24aa8", "#ffb0cf"],
  treasury: ["#ffc06b", "#ff6f5e", "#ffb347", "#4fd6c8"],
  play: ["#ffc06b", "#ff86bb", "#ffb347", "#8a5cf0"],
  bounties: ["#ff86bb", "#ff6f5e", "#ffc06b", "#d24aa8"],
  ideas: ["#8a5cf0", "#ffc06b", "#cdb6ff", "#ff86bb"],
  journal: ["#9fd8ff", "#4fd6c8", "#cdb6ff", "#eef3f2"],
  security: ["#ff6f5e", "#ff86bb", "#ffc06b", "#9fd8ff"],
  modules: ["#4fd6c8", "#8a5cf0", "#9fd8ff", "#cdb6ff"],
  autonomy: ["#4fd6c8", "#ffc06b", "#86eadf", "#9fd8ff"],
  streak: ["#8a5cf0", "#ff86bb", "#4fd6c8", "#cdb6ff"],
  how: ["#4fd6c8", "#ff86bb", "#8a5cf0", "#ffc06b"],
  sequencer: ["#4fd6c8", "#8a5cf0", "#9fd8ff", "#cdb6ff"],
  news: ["#ffc06b", "#4fd6c8", "#9fd8ff", "#ff86bb"],
} as const;
export type Mood = keyof typeof MOODS;

/** the base light every section shares; PageHead hands the same two to its CSS gradient fallback */
export const BASE_KEY = "#ffb35c", BASE_RIM = "#7d93ff";
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

/** key, rim, accent as 9 floats (0–1 rgb): the key leans 15% toward the mood, the rim half way, the glow is the mood's */
export function tint(mood: Mood): number[] {
  const [m0, m1] = MOODS[mood].map(rgb), key = rgb(BASE_KEY);
  return [...mix(key, m0, 0.15), ...mix(rgb(BASE_RIM), m1, 0.5), ...mix(m0, key, 0.2)];
}
