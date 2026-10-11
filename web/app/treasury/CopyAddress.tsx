"use client";

import { useEffect, useRef, useState } from "react";
import { IconCopy } from "../_ui/icons";
import t from "./treasury.module.css";

/** Shows `label` (the server-shortened value) and copies the full `address`. */
export function CopyAddress({ address, label, what = "address" }: { address: string; label: string; what?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try { await navigator.clipboard.writeText(address); } catch { return; } // only confirm a real copy
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button type="button" className={t.copy} onClick={copy} aria-label={`Copy ${what} ${label}`} title={address}>
      <span>{copied ? "copied" : label}</span>
      <IconCopy />
      <span className="sr-only" aria-live="polite">{copied ? "Copied" : ""}</span>
    </button>
  );
}
