import type { ReactNode } from "react";
import { Clock3, Info, Lock, OctagonX, PlugZap, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "stale" | "error" | "info" | "breach" | "quarantine" | "warn";

const TONE: Record<Tone, { icon: typeof Info; cls: string }> = {
  stale: { icon: Clock3, cls: "border-unknown/40 bg-unknown/10 text-fg [&_svg]:text-unknown-text" },
  error: { icon: PlugZap, cls: "border-drift/40 bg-drift/10 text-fg [&_svg]:text-drift" },
  warn: { icon: TriangleAlert, cls: "border-drift/40 bg-drift/10 text-fg [&_svg]:text-drift" },
  info: { icon: Info, cls: "border-wire bg-raised text-fg [&_svg]:text-muted" },
  breach: { icon: OctagonX, cls: "border-broken/50 bg-broken/10 text-fg [&_svg]:text-broken" },
  quarantine: { icon: Lock, cls: "border-quarantined/45 bg-quarantined/10 text-fg [&_svg]:text-quarantined" },
};

export function Banner({ tone, children, action, className, role }: { tone: Tone; children: ReactNode; action?: ReactNode; className?: string; role?: "status" | "alert" }) {
  const t = TONE[tone];
  const Icon = t.icon;
  return (
    <div role={role ?? (tone === "error" || tone === "breach" || tone === "quarantine" ? "alert" : "status")} className={cn("flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm", t.cls, className)}>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
