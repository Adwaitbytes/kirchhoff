"use client";

import { Ban, Lock, OctagonX, SearchX, ShieldX, Sigma, Zap, type LucideIcon } from "lucide-react";
import type { EvidenceItem, EvidenceKind } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import { blockUrl, ccipMessageUrl, shortHash } from "@/lib/explorer";
import { formatTime } from "@/lib/format";
import { ExternalLink, TxLink } from "@/components/kh/links";
import { cn } from "@/lib/utils";
import { sortedEvidence } from "@/components/incident/postmortem";

const KIND: Readonly<Record<EvidenceKind, { icon: LucideIcon; label: string; tone: string }>> = {
  offending_credit: { icon: Zap, label: "Offending credit", tone: "text-broken bg-broken/12 ring-broken/40" },
  debit_search: { icon: SearchX, label: "Debit search", tone: "text-drift bg-drift/12 ring-drift/35" },
  breach_report: { icon: OctagonX, label: "BREACH report", tone: "text-broken bg-broken/12 ring-broken/40" },
  quarantine_tx: { icon: Lock, label: "Quarantine", tone: "text-quarantined bg-quarantined/12 ring-quarantined/40" },
  refused_message: { icon: Ban, label: "Refused at the junction", tone: "text-broken bg-broken/12 ring-broken/40" },
  guard_revert: { icon: ShieldX, label: "Guard revert", tone: "text-quarantined bg-quarantined/12 ring-quarantined/40" },
  epoch_report: { icon: Sigma, label: "Loop epoch", tone: "text-recovering bg-recovering/12 ring-recovering/40" },
};

export function evidenceDomId(id: string): string {
  return `evidence-${id}`;
}

export function EvidenceTimeline({ evidence, highlighted }: { evidence: readonly EvidenceItem[]; highlighted: string | null }) {
  const items = sortedEvidence(evidence);
  if (items.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted">No evidence recorded yet</p>;
  }
  return (
    <ol data-testid="evidence-timeline" className="relative px-4 py-4 sm:px-5" aria-label="Evidence timeline, oldest first">
      {items.map((e, idx) => {
        const k = KIND[e.kind];
        const Icon = k.icon;
        const last = idx === items.length - 1;
        const on = highlighted === e.id;
        return (
          <li key={e.id} id={evidenceDomId(e.id)} className="relative grid scroll-mt-24 grid-cols-[28px_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
            {!last ? <span aria-hidden="true" className="absolute bottom-0 left-[13.5px] top-8 w-px bg-gradient-to-b from-line-strong to-wire" /> : null}
            <span className={cn("relative z-[1] mt-0.5 flex size-7 items-center justify-center rounded-full ring-1 shadow-[0_0_0_4px_var(--bg-panel)]", k.tone)}>
              <Icon className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
            </span>
            <div
              className={cn(
                "min-w-0 rounded-lg border px-3 py-2.5 transition-[background-color,border-color,box-shadow] duration-500",
                on
                  ? "border-[color-mix(in_oklab,var(--status-conserved)_55%,transparent)] bg-conserved/[0.07] shadow-[0_0_0_3px_color-mix(in_oklab,var(--status-conserved)_18%,transparent)]"
                  : "border-transparent hover:border-wire hover:bg-raised/60",
              )}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <span className="font-mono text-subtle tnum">{formatTime(e.at)}</span>
                <span className="font-medium text-muted">{k.label}</span>
                <span className="text-subtle">·</span>
                <span className="text-muted">{CHAINS[e.chain].name}</span>
                <span className="ml-auto rounded border border-wire bg-inset px-1.5 font-mono text-2xs text-subtle">{e.id}</span>
              </div>
              <p className="mt-1 text-sm leading-snug text-fg">{e.label}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                {e.tx ? <TxLink tx={e.tx} showChain /> : null}
                {e.blocks ? (
                  <span className="flex flex-wrap items-center gap-1 text-xs text-muted">
                    Blocks
                    <ExternalLink href={blockUrl(e.chain, e.blocks.from)} label={`Block ${e.blocks.from} on ${CHAINS[e.chain].name}`} className="font-mono text-fg/90 tnum">
                      {Number(e.blocks.from).toLocaleString("en-US")}
                    </ExternalLink>
                    to
                    <ExternalLink href={blockUrl(e.chain, e.blocks.to)} label={`Block ${e.blocks.to} on ${CHAINS[e.chain].name}`} className="font-mono text-fg/90 tnum">
                      {Number(e.blocks.to).toLocaleString("en-US")}
                    </ExternalLink>
                    <span className={cn("ml-1 font-mono", e.blocks.matches === 0 ? "text-broken" : "text-conserved")}>{e.blocks.matches} matches</span>
                  </span>
                ) : null}
                {e.kind === "refused_message" && e.messageId ? (
                  <ExternalLink href={ccipMessageUrl(e.messageId)} label={`CCIP message ${e.messageId}`} className="font-mono text-xs text-muted hover:text-fg">
                    <span className="mr-1 font-sans text-subtle">CCIP msg</span>
                    {shortHash(e.messageId)}
                  </ExternalLink>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
