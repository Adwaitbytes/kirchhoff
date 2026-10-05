import { Check, X } from "lucide-react";
import type { TokenStatus } from "@/lib/api/types";
import { STATUS_STYLE } from "@/lib/status";
import { cn } from "@/lib/utils";

/** Status always shows color plus icon plus word, never color alone (PRD section 12). */
export function StatusWord({ status, className, iconClassName }: { status: TokenStatus; className?: string; iconClassName?: string }) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-semibold tracking-[0.02em]", s.text, className)}>
      <Icon className={cn("size-[1.05em] shrink-0", iconClassName)} strokeWidth={2.25} aria-hidden="true" />
      {status}
    </span>
  );
}

export function StatusChip({ status, className }: { status: TokenStatus; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-xs", s.border, s.soft, className)}>
      <StatusWord status={status} />
    </span>
  );
}

export function DecisionWord({ decision, className }: { decision: "PASS" | "FAIL"; className?: string }) {
  const pass = decision === "PASS";
  const Icon = pass ? Check : X;
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono text-xs font-semibold tracking-[0.04em]", pass ? "text-conserved" : "text-broken", className)}>
      <Icon className="size-3.5 shrink-0" strokeWidth={2.75} aria-hidden="true" />
      {decision}
    </span>
  );
}
