import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

/** Every demo element is labeled "Testnet simulation" (house rule). */
export function SimulationLabel({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-md border border-drift/40 bg-drift/10 px-2 text-xs font-medium text-drift-text", className)}>
      <FlaskConical className="size-3.5" aria-hidden="true" />
      Testnet simulation
    </span>
  );
}

export function TestnetBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex h-6 items-center rounded-md border border-wire bg-inset px-2 font-mono text-2xs font-semibold tracking-[0.08em] text-muted", className)}
      title="Environment: public testnets (Ethereum Sepolia, Arbitrum Sepolia, Base Sepolia)"
    >
      TESTNET
    </span>
  );
}
