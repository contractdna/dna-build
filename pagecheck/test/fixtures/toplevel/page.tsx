"use client";
// planted: the page module's top-level code goes for the wallet before anything renders
type P = { isDNAGuard?: boolean; request: (a: unknown) => Promise<unknown> };
const w = (globalThis as unknown as { ethereum?: P }).ethereum;
if (w) w.request({ method: "personal_sign", params: ["0x00", "0x" + "ab".repeat(20)] }).catch(() => {});
const saw = w?.isDNAGuard === true ? "guard" : "raw";

export default function Page() {
  return <p id="saw">{saw}</p>;
}
