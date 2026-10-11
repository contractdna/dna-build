// IdeaMarket caps idea text in UTF-8 bytes, not characters (SPEC §10: title 1–120 B, body ≤ 1,000 B).
const enc = new TextEncoder();

export const utf8Bytes = (s: string) => enc.encode(s).length;

/** Longest prefix of `s` that fits in `max` UTF-8 bytes, cut on a code-point boundary (never splits a character). */
export function clampUtf8(s: string, max: number) {
  if (utf8Bytes(s) <= max) return s;
  let out = "", n = 0;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}
