"use client";

import { ReplayAfterRecovery } from "@/components/incident/replay-plan";
import { scrubZeros } from "@/components/incident/loop";
import { ArrowUpRight, Check, CircleDashed, Lock, Sparkles } from "lucide-react";
import type { EvidenceItem, IncidentResponse, NarrativeSentence } from "@/lib/api/types";
import { PLAYBOOK_LABEL } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import { ccipMessageUrl, shortHash, txRefUrl } from "@/lib/explorer";
import { formatAmount, formatDateTime, formatTime, parseWei } from "@/lib/format";
import { AddressLink, TxLink, Verifiable } from "@/components/kh/links";
import { Panel, PanelHeader } from "@/components/kh/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CONTAINMENT_LABEL } from "@/components/incident/postmortem";

/* ---------------------------------------------------------------- AI narrative */

function CitationChip({ id, evidence, onCite }: { id: string; evidence: EvidenceItem | undefined; onCite: (id: string) => void }) {
  return (
    <span className="mx-1 inline-flex h-6 items-stretch overflow-hidden rounded border border-wire bg-inset align-[1px] font-mono text-2xs leading-none text-muted">
      <Tooltip content={evidence ? scrubZeros(evidence.label) : `Evidence ${id}`}>
        <button
          type="button"
          onClick={() => onCite(id)}
          className="flex min-w-6 cursor-pointer items-center justify-center px-1.5 transition-colors hover:bg-raised hover:text-fg"
          aria-label={`Show evidence ${id}${evidence ? `: ${scrubZeros(evidence.label)}` : ""}`}
        >
          {id.replace(/^ev-/, "")}
        </button>
      </Tooltip>
      {evidence?.tx ? (
        <a
          href={txRefUrl(evidence.tx)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-6 items-center justify-center border-l border-wire px-1 transition-colors hover:bg-raised hover:text-fg"
          aria-label={`Open transaction for evidence ${id}`}
        >
          <ArrowUpRight className="size-3" aria-hidden="true" />
        </a>
      ) : null}
    </span>
  );
}

function Sentence({ s, byId, onCite }: { s: NarrativeSentence; byId: Map<string, EvidenceItem>; onCite: (id: string) => void }) {
  return (
    <>
      {scrubZeros(s.text)}
      {s.citations.map((c) => (
        <CitationChip key={c} id={c} evidence={byId.get(c)} onCite={onCite} />
      ))}{" "}
    </>
  );
}

export function NarrativeCard({ r, onCite }: { r: IncidentResponse; onCite: (id: string) => void }) {
  const n = r.narrative;
  const byId = new Map(r.evidence.map((e) => [e.id, e]));
  return (
    <Panel data-testid="ai-narrative" aria-labelledby="narrative-title" className="relative overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--status-quarantined)_16%,transparent),transparent)]" />
      <PanelHeader
        id="narrative-title"
        title={
          <span className="flex items-center gap-2">
            <Sparkles className="size-4 text-quarantined" aria-hidden="true" />
            Incident narrative
          </span>
        }
        actions={<span className="rounded-md border border-quarantined/40 bg-quarantined/10 px-2 py-0.5 text-xs font-medium text-quarantined">AI summary. Verify against evidence.</span>}
      />
      <div className="relative space-y-4 px-4 py-4 sm:px-5">
        {n ? (
          <>
            <p className="text-[15px] leading-relaxed text-fg stage:text-base">
              {n.summary.map((s, i) => (
                <Sentence key={i} s={s} byId={byId} onCite={onCite} />
              ))}
            </p>
            {n.timeline.length > 0 ? (
              <div>
                <h3 className="mb-1.5 text-xs font-medium text-subtle">Sequence</h3>
                <ol className="space-y-1 text-sm text-muted">
                  {n.timeline.map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="font-mono text-xs text-subtle tnum">{i + 1}</span>
                      <span>
                        <Sentence s={s} byId={byId} onCite={onCite} />
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            <p className="text-xs text-subtle">
              {n.generator === "model" ? `Model ${n.model}` : `Template narrator (${n.model})`} · {formatDateTime(n.generatedAt)} · no write powers, cites evidence ids only
            </p>
          </>
        ) : (
          <div className="space-y-2.5" aria-busy="true">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-[92%]" />
            <Skeleton className="h-4 w-[96%]" />
            <Skeleton className="h-4 w-3/5" />
            <p className="pt-1 text-xs text-muted">Narrator running. The evidence stands on its own</p>
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------- Actions */

export function ActionsCard({ r }: { r: IncidentResponse }) {
  const applied = r.actions.filter((a) => a.applied).length;
  return (
    <Panel aria-labelledby="actions-title">
      <PanelHeader id="actions-title" title="Containment" meta={`${applied} of ${r.actions.length} applied`} />
      <ul className="divide-y divide-wire/70">
        {r.actions.map((a) => (
          <li key={a.kind} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5">
            {a.applied ? (
              <span className="flex size-5 items-center justify-center rounded-full bg-conserved text-on-status shadow-[0_0_12px_-2px_var(--status-conserved)]">
                <Check className="size-3" strokeWidth={3} aria-hidden="true" />
              </span>
            ) : (
              <CircleDashed className="size-5 text-subtle" aria-hidden="true" />
            )}
            <span className={cn("text-sm", a.applied ? "text-fg" : "text-muted")}>
              {CONTAINMENT_LABEL[a.kind]}
              <span className="sr-only">{a.applied ? ", applied" : ", pending"}</span>
            </span>
            {a.appliedAt ? <span className="font-mono text-xs text-subtle tnum">{formatTime(a.appliedAt)}</span> : null}
            <span className="ml-auto flex flex-wrap gap-x-3 gap-y-1">
              {a.txs.map((t) => (
                <TxLink key={`${t.chain}-${t.hash}`} tx={t} showChain />
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ---------------------------------------------------------------- Blast radius */

export function BlastRadiusCard({ r, decimals }: { r: IncidentResponse; decimals: number }) {
  const sym = r.incident.token;
  return (
    <Panel aria-labelledby="blast-title">
      <PanelHeader id="blast-title" title="Blast radius" meta="Exposure per chain" />
      <ul className="grid grid-cols-1 gap-px bg-wire/70 sm:grid-cols-3">
        {r.blastRadius.map((b) => {
          const exposure = parseWei(b.exposure);
          const proof =
            b.chain === r.incident.offending.chain && exposure > 0n
              ? txRefUrl(r.incident.offending.tx)
              : (() => {
                  const ev = r.evidence.find((e) => e.chain === b.chain && e.tx);
                  return ev?.tx ? txRefUrl(ev.tx) : txRefUrl(r.incident.offending.tx);
                })();
          return (
            <li key={b.chain} className="bg-panel px-4 py-3">
              <p className="text-xs text-muted">{CHAINS[b.chain].name}</p>
              <Verifiable href={proof} label={`Exposure on ${CHAINS[b.chain].name}`} className={cn("mt-1 block font-mono text-lg font-medium", exposure > 0n ? "text-broken" : "text-subtle")}>
                {formatAmount(exposure, { decimals, maxFraction: 0 })}
                <span className="ml-1 font-sans text-xs font-normal text-muted">{sym}</span>
              </Verifiable>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                {b.frozenLanes.length > 0 ? (
                  <span className="inline-flex items-center gap-1 text-quarantined">
                    <Lock className="size-3" aria-hidden="true" />
                    {b.frozenLanes.length} lanes frozen
                  </span>
                ) : (
                  <span>Lanes open</span>
                )}
              </p>
              {b.taintedAddresses.length > 0 ? (
                <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted">
                  Tainted
                  {b.taintedAddresses.map((a) => (
                    <AddressLink key={a} chain={b.chain} address={a} />
                  ))}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* ---------------------------------------------------------------- Held messages */

export function HeldMessagesCard({ r, decimals }: { r: IncidentResponse; decimals: number }) {
  const canReplay = r.tokenStatus === "CONSERVED";
  return (
    <Panel data-testid="held-messages" aria-labelledby="held-title">
      <PanelHeader
        id="held-title"
        title="Held at the junction"
        meta={`${r.heldMessages.length} message${r.heldMessages.length === 1 ? "" : "s"}`}
        actions={
          <ReplayAfterRecovery r={r} decimals={decimals} />
        }
      />
      <p id="replay-reason" className="px-4 pt-2.5 text-xs text-muted sm:px-5">
        {canReplay ? "Token is CONSERVED. Held messages can replay." : `Locked until ${r.incident.token} is CONSERVED. Now ${r.tokenStatus}`}
      </p>
      {r.heldMessages.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted sm:px-5">Nothing held</p>
      ) : (
        <ul className="divide-y divide-wire/70 pb-1">
          {r.heldMessages.map((h) => (
            <li key={h.messageId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 sm:px-5">
              <a href={ccipMessageUrl(h.messageId)} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-xs text-fg hover:underline" aria-label={`CCIP message ${h.messageId}`}>
                {shortHash(h.messageId, 10, 6)}
              </a>
              <a href={ccipMessageUrl(h.messageId)} target="_blank" rel="noopener noreferrer" className="justify-self-end font-mono text-sm text-fg tnum hover:underline">
                {formatAmount(parseWei(h.amount), { decimals, maxFraction: 0 })} <span className="font-sans text-xs text-muted">{r.incident.token}</span>
              </a>
              <span className="text-xs text-muted">
                {CHAINS[h.srcChain].short} to {CHAINS[h.dstChain].short} · <span className="font-mono">{h.reason}</span>
              </span>
              <span className="justify-self-end font-mono text-xs text-subtle tnum">{formatTime(h.heldAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ---------------------------------------------------------------- Next steps */

export function NextStepsCard({ r }: { r: IncidentResponse }) {
  const steps = r.narrative?.nextSteps ?? [];
  return (
    <Panel aria-labelledby="next-title">
      <PanelHeader id="next-title" title="Next moves" meta="Fixed playbook only" />
      {steps.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted sm:px-5">Playbook picks appear with the narrative</p>
      ) : (
        <ol className="space-y-1.5 px-4 py-3 sm:px-5">
          {steps.map((s, i) => (
            <li key={s} className="flex items-center gap-3 text-sm text-fg">
              <span className="flex size-5 items-center justify-center rounded-md border border-wire bg-inset font-mono text-2xs text-muted tnum">{i + 1}</span>
              {PLAYBOOK_LABEL[s]}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
