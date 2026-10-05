"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** Copies `value` to the clipboard and confirms inline. Failure is shown, never swallowed. */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = window.setTimeout(() => setState("idle"), 1600);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setState("copied"),
          (e: unknown) => {
            console.warn("Clipboard write failed", e);
            setState("failed");
          },
        );
      }}
      aria-label={state === "copied" ? `${label} copied` : `Copy ${label}`}
      className={cn(
        "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-wire bg-raised px-2 text-xs text-muted shadow-[inset_0_1px_0_0_rgb(255_255_255/0.04)] transition-[color,border-color,background-color] duration-150 hover:border-line-strong hover:text-fg",
        state === "copied" && "border-conserved/50 text-conserved hover:text-conserved",
        state === "failed" && "border-drift/50 text-drift",
        className,
      )}
    >
      {state === "copied" ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy blocked" : "Copy"}</span>
    </button>
  );
}
