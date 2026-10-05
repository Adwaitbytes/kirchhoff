"use client";

import { useState } from "react";
import { ChevronDown, FileDiff, ShieldAlert } from "lucide-react";
import type { PendingSpecProposal, SpecFieldChange } from "@/lib/api/types";
import { useNow, useSpecProposals } from "@/lib/api/hooks";
import { CHAINS } from "@/lib/chains";
import { addressUrl, shortHash, txRefUrl } from "@/lib/explorer";
import { formatAge, formatDateTime } from "@/lib/format";
import { Verifiable } from "@/components/kh/links";
import { cn } from "@/lib/utils";

const EFFECT: Record<SpecFieldChange["effect"], { label: string; cls: string }> = {
  loosens: { label: "loosens", cls: "border-broken/50 bg-broken/10 text-broken" },
  tightens: { label: "tightens", cls: "border-conserved/50 bg-conserved/10 text-conserved" },
  neutral: { label: "neutral", cls: "border-wire bg-inset text-muted" },
};

function Countdown({ p }: { p: PendingSpecProposal }) {
  const now = useNow();
  const end = Date.parse(p.activatesAt);
  const start = Date.parse(p.proposedAt);
  if (now === 0) return <span className="font-mono tnum">{formatDateTime(p.activatesAt)}</span>;
  const left = Math.max(0, Math.floor((end - now) / 1000));
  const frac = Math.min(1, Math.max(0, (now - start) / Math.max(1, end - start)));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-inset" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 rounded-full bg-drift" style={{ width: `${frac * 100}%` }} />
      </span>
      <span className="font-mono text-fg tnum" data-testid="spec-timelock">
        {left === 0 ? "timelock ended" : `activates in ${formatAge(left)}`}
      </span>
    </span>
  );
}

function Proposal({ p }: { p: PendingSpecProposal }) {
  const [open, setOpen] = useState(true);
  const loosens = p.diff.filter((d) => d.effect === "loosens").length;
  const home = p.proposeTx.chain;
  return (
    <section
      role="alert"
      aria-label="Spec change pending"
      data-testid="spec-proposal-alert"
      className={cn(
        "overflow-hidden rounded-lg border text-sm shadow-[inset_0_1px_0_0_var(--panel-highlight)]",
        loosens > 0 ? "border-broken/45 bg-[linear-gradient(90deg,color-mix(in_oklab,var(--status-broken)_10%,transparent),color-mix(in_oklab,var(--status-drift)_7%,transparent))]" : "border-drift/45 bg-drift/[0.07]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-2.5">
        {loosens > 0 ? <ShieldAlert className="size-4 shrink-0 text-broken" aria-hidden="true" /> : <FileDiff className="size-4 shrink-0 text-drift" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-fg">
            Spec change pending · {p.diff.length} field{p.diff.length === 1 ? "" : "s"}
            {loosens > 0 ? <span className="text-broken"> · {loosens} loosen{loosens === 1 ? "s" : ""} a rule</span> : null}
          </p>
          <p className="text-xs text-muted">
            Proposed by{" "}
            <Verifiable href={addressUrl(home, p.proposer)} label="Proposer Safe" className="font-mono">
              {shortHash(p.proposer)}
            </Verifiable>{" "}
            in{" "}
            <Verifiable href={txRefUrl(p.proposeTx)} label="Propose transaction" className="font-mono">
              {shortHash(p.proposeTx.hash)}
            </Verifiable>{" "}
            on {CHAINS[home].short} · hash <span className="font-mono">{shortHash(p.specHash)}</span>
          </p>
        </div>
        <Countdown p={p} />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-raised hover:text-fg"
        >
          Diff
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="overflow-x-auto border-t border-wire/70">
          <table className="w-full text-xs" data-testid="spec-diff">
            <caption className="sr-only">Field-level diff of the pending spec against the active spec</caption>
            <thead>
              <tr className="text-subtle">
                <th scope="col" className="px-3.5 py-1.5 text-left font-medium">Field</th>
                <th scope="col" className="px-3 py-1.5 text-left font-medium">Active</th>
                <th scope="col" className="px-3 py-1.5 text-left font-medium">Proposed</th>
                <th scope="col" className="px-3.5 py-1.5 text-right font-medium">Effect</th>
              </tr>
            </thead>
            <tbody>
              {p.diff.map((d) => (
                <tr key={d.path} className="border-t border-wire/50">
                  <th scope="row" className="px-3.5 py-1.5 text-left font-mono font-normal text-fg">{d.path}</th>
                  <td className="px-3 py-1.5 font-mono text-muted line-through decoration-broken/50">{d.before ?? "none"}</td>
                  <td className="px-3 py-1.5 font-mono text-fg">{d.after ?? "removed"}</td>
                  <td className="px-3.5 py-1.5 text-right">
                    <span className={cn("inline-flex rounded border px-1.5 py-px font-mono text-2xs", EFFECT[d.effect].cls)}>{EFFECT[d.effect].label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Spec poisoning guard (PRD section 14, threat 7): every pending KIRCH-SPEC change is shown to
 * operators and holders with a field-level diff and its timelock, so nobody can loosen rules quietly.
 */
export function SpecProposalAlert({ token, className }: { token: string; className?: string }) {
  const q = useSpecProposals(token);
  const pending = (q.data?.items ?? []).filter((p) => p.state === "proposed");
  if (pending.length === 0) return null;
  return (
    <div className={cn("space-y-2", className)}>
      {pending.map((p) => (
        <Proposal key={p.specHash} p={p} />
      ))}
    </div>
  );
}
