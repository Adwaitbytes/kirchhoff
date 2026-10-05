import { cn } from "@/lib/utils";

/** The mark: a junction where three currents meet, the node of Kirchhoff's current law. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden="true" fill="none">
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" className="fill-raised stroke-wire" />
      <path d="M16 16 L6.5 8.5 M16 16 L25.5 8.5 M16 16 V26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-fg" />
      <circle cx="16" cy="16" r="3.4" className="fill-conserved" />
      <circle cx="6.5" cy="8.5" r="1.6" className="fill-muted" />
      <circle cx="25.5" cy="8.5" r="1.6" className="fill-muted" />
      <circle cx="16" cy="26" r="1.6" className="fill-muted" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn("font-mono text-[13px] font-semibold tracking-[0.22em] text-fg", className)}>KIRCHHOFF</span>;
}
