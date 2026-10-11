/** Canonical JSON: bigints as decimal strings, Dates as ISO strings, object keys sorted recursively, no whitespace.
 *  Dependency-free, so the watchdog and the CLIs can hash records exactly as the log does. */
export function canonical(v: unknown): string {
  const norm = (x: unknown): unknown =>
    typeof x === "bigint" ? x.toString()
    : x instanceof Date ? x.toISOString()
    : Array.isArray(x) ? x.map(norm)
    : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]))
    : x;
  return JSON.stringify(norm(v));
}
