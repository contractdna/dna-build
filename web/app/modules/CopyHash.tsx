"use client";

import { useState } from "react";
import { IconCopy } from "../_ui/icons";
import css from "./modules.module.css";

/** Shows `display` (the server passes `short(value)`) and copies the full value. */
export function CopyHash({ value, display, label }: { value: string; display: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(value).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button type="button" className={css.copy} onClick={copy} aria-label={`Copy full ${label}`} title={value}>
      <span>{copied ? "copied" : display}</span>
      <IconCopy />
    </button>
  );
}
