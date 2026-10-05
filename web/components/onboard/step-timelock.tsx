"use client";

import { CircleCheck, Hourglass } from "lucide-react";
import type { ChainKey, SpecProposalResponse } from "@/lib/api/types";
import { useNow } from "@/lib/api/hooks";
import { CHAINS } from "@/lib/chains";
import { formatDateTime, formatDuration } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { TxLink } from "@/components/kh/links";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function StepTimelock({ proposal, chain }: { proposal: SpecProposalResponse | undefined; chain: ChainKey }) {
  const now = useNow();
  const { reducedMotion } = usePrefs();
  if (!proposal || !proposal.activatesAt || !proposal.proposedAt) {
    return (
      <div className="flex flex-col items-center gap-4 py-8" aria-busy="true">
        <Skeleton className="size-56 rounded-full" />
        <Skeleton className="h-4 w-48" />
      </div>
    );
  }
  const end = Date.parse(proposal.activatesAt);
  const start = Date.parse(proposal.proposedAt);
  const total = Math.max(1, end - start);
  const t = now === 0 ? start : now;
  const remaining = Math.max(0, Math.ceil((end - t) / 1000));
  const active = proposal.state === "active" || remaining === 0;
  const frac = active ? 1 : Math.min(1, Math.max(0, (t - start) / total));
  const r = 92;
  const circ = 2 * Math.PI * r;
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  const hh = Math.floor(mm / 60);
  const color = active ? "var(--status-conserved)" : "var(--status-recovering)";
  return (
    <div className="grid items-center gap-8 lg:grid-cols-[auto_minmax(0,1fr)]" data-testid="timelock">
      <div className="relative mx-auto size-[220px] sm:size-[240px]">
        <div aria-hidden="true" className="absolute inset-6 rounded-full blur-2xl" style={{ background: `color-mix(in oklab, ${color} 18%, transparent)` }} />
        <svg viewBox="0 0 220 220" className="relative size-full -rotate-90" role="img" aria-label={active ? "Timelock complete" : `Timelock ${Math.round(frac * 100)} percent elapsed`}>
          <circle cx="110" cy="110" r={r} fill="none" stroke="var(--line-wire)" strokeWidth="6" />
                    <circle
            cx="110"
            cy="110"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - frac)}
            style={{ transition: reducedMotion ? "none" : "stroke-dashoffset 1s linear, stroke 400ms ease", filter: `drop-shadow(0 0 6px ${color})` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {active ? (
            <>
              <CircleCheck className="size-7 text-conserved" aria-hidden="true" />
              <p className="mt-2 text-xl font-semibold text-conserved">Active</p>
              <p className="text-xs text-muted">Spec live in the Registry</p>
            </>
          ) : (
            <>
              <Hourglass className="size-5 text-recovering" aria-hidden="true" />
              <p className="mt-2 font-mono text-[40px] font-medium leading-none tracking-[-0.03em] text-fg tnum" aria-live="off">
                {hh > 0 ? `${hh}:${pad(mm % 60)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`}
              </p>
              <p className="mt-1.5 text-xs text-muted">until activation</p>
            </>
          )}
        </div>
      </div>
      <div className="space-y-4">
        <div>
          <h3 className={cn("text-lg font-semibold tracking-[-0.01em]", active ? "text-conserved" : "text-fg")}>{active ? "Circuit closed, spec active" : "Timelock running"}</h3>
          <p className="mt-1 max-w-[56ch] text-sm text-muted">
            {active
              ? "W4 Topology Watch picks up SpecActivated and every workflow loads the new config."
              : "Holders and risk stewards can read the pending spec before it binds. Nobody can loosen the rules in a hurry."}
          </p>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-wire bg-inset px-4 py-3">
            <dt className="text-xs text-subtle">Timelock</dt>
            <dd className="mt-1 font-mono text-base text-fg tnum">{formatDuration(proposal.timelockSeconds)}</dd>
            <dd className="text-xs text-muted">10 minutes on testnet, 48h in production</dd>
          </div>
          <div className="rounded-xl border border-wire bg-inset px-4 py-3">
            <dt className="text-xs text-subtle">Activates</dt>
            <dd className="mt-1 font-mono text-sm text-fg tnum">{formatDateTime(proposal.activatesAt)}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {proposal.proposeTx ? (
            <span className="flex items-center gap-2 text-muted">
              Propose tx <TxLink tx={proposal.proposeTx} />
            </span>
          ) : null}
          {proposal.activateTx ? (
            <span className="flex items-center gap-2 text-muted">
              Activate tx <TxLink tx={proposal.activateTx} />
            </span>
          ) : null}
          <span className="text-xs text-subtle">KirchhoffRegistry on {CHAINS[chain].name}</span>
        </div>
      </div>
    </div>
  );
}
