"use client";

import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import type { IncidentResponse, ReplayPlanResponse } from "@/lib/api/types";
import { isApiError } from "@/lib/api/client";
import { useApi } from "@/lib/api/provider";
import { CHAINS } from "@/lib/chains";
import { ccipMessageUrl, safeTxBuilderUrl, shortHash } from "@/lib/explorer";
import { formatAmount, parseWei } from "@/lib/format";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Banner } from "@/components/kh/banner";
import { AddressLink } from "@/components/kh/links";
import { CopyButton } from "@/components/incident/resolve-dialog";
import { cn } from "@/lib/utils";

function planError(e: unknown): string {
  if (isApiError(e) && e.code === "NOT_FOUND") return "This API has no replay planner yet. Held messages stay held";
  return isApiError(e) ? e.message : "The replay plan could not be prepared";
}

function PlanBody({ plan, decimals, token }: { plan: ReplayPlanResponse; decimals: number; token: string }) {
  const firstCall = plan.calls[0];
  return (
    <div className="space-y-5 px-5 py-4" data-testid="replay-plan">
      {!plan.allowed ? <Banner tone="info">{plan.reason ?? `${token} is ${plan.tokenStatus}. Replay waits for CONSERVED`}</Banner> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted">Signer</dt>
        <dd className="text-right">
          {firstCall ? <AddressLink chain={firstCall.chain} address={plan.issuerSafe} /> : <span className="font-mono text-xs text-fg">{shortHash(plan.issuerSafe)}</span>}
          <span className="ml-1.5 text-xs text-subtle">issuer Safe</span>
        </dd>
        <dt className="text-muted">Token now</dt>
        <dd className="text-right font-mono text-xs text-fg">{plan.tokenStatus}</dd>
      </dl>

      <section aria-labelledby="plan-messages">
        <h3 id="plan-messages" className="mb-2 text-xs font-medium text-subtle">
          Held messages
        </h3>
        {plan.messages.length === 0 ? (
          <p className="text-sm text-muted">Nothing held</p>
        ) : (
          <ul className="divide-y divide-wire/70 rounded-lg border border-wire">
            {plan.messages.map((m) => (
              <li key={m.messageId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-3 py-2 text-xs">
                <a href={ccipMessageUrl(m.messageId)} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-fg hover:underline">
                  {shortHash(m.messageId, 10, 6)}
                </a>
                <span className={cn("justify-self-end rounded px-1.5 py-0.5 font-mono font-semibold", m.action === "replay" ? "bg-conserved/12 text-conserved" : "bg-quarantined/12 text-quarantined")}>
                  {m.action}
                </span>
                <span className="text-muted">
                  {formatAmount(parseWei(m.amount), { decimals, maxFraction: 0 })} {token} · {CHAINS[m.srcChain].short} to {CHAINS[m.dstChain].short}
                </span>
                <span className="justify-self-end text-subtle">{m.note}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {plan.allowed ? (
        <section aria-labelledby="plan-calls">
          <h3 id="plan-calls" className="mb-2 text-xs font-medium text-subtle">
            Safe calls to sign ({plan.calls.length})
          </h3>
          {plan.calls.length === 0 ? (
            <p className="text-sm text-muted">No call needed: every held message stays held</p>
          ) : (
            <ol className="space-y-3">
              {plan.calls.map((c, i) => (
                <li key={`${c.chain}-${i}`} data-testid="replay-plan-call" className="rounded-lg border border-wire bg-inset p-3">
                  <p className="text-sm font-medium text-fg">{c.description}</p>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    <dt className="text-muted">Chain</dt>
                    <dd className="text-right text-fg">{CHAINS[c.chain].name}</dd>
                    <dt className="text-muted">To</dt>
                    <dd className="text-right">
                      <AddressLink chain={c.chain} address={c.to} />
                    </dd>
                    <dt className="text-muted">Value</dt>
                    <dd className="text-right font-mono text-fg">{formatAmount(parseWei(c.value), { decimals: 18 })} ETH</dd>
                  </dl>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <code className="min-w-0 truncate font-mono text-2xs text-muted">{c.data}</code>
                    <CopyButton value={c.data} label={`Copy calldata for call ${i + 1}`} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      {plan.allowed && firstCall ? (
        <Button asChild variant="primary">
          <a href={safeTxBuilderUrl(firstCall.chain, plan.issuerSafe)} target="_blank" rel="noopener noreferrer">
            Open in Safe <ArrowUpRight aria-hidden="true" />
          </a>
        </Button>
      ) : null}
      <p className="text-xs text-subtle">Prepared only. Nothing replays until the issuer Safe signs</p>
    </div>
  );
}

/** "Replay after recovery": fetches the Safe-gated replay plan once the token is CONSERVED again. */
export function ReplayAfterRecovery({ r, decimals }: { r: IncidentResponse; decimals: number }) {
  const api = useApi();
  const canReplay = r.tokenStatus === "CONSERVED";
  const plan = useMutation({ mutationFn: () => api.getReplayPlan(r.incident.id) });
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) plan.mutate();
        else plan.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={!canReplay} aria-describedby="replay-reason" data-testid="replay-after-recovery">
          <RotateCcw aria-hidden="true" />
          Replay after recovery
        </Button>
      </DialogTrigger>
      <DialogContent title="Replay after recovery" description="Safe-gated plan for the messages held during the incident" className="max-h-[80vh] overflow-y-auto">
        {plan.isPending ? (
          <div className="space-y-3 px-5 py-4" aria-busy="true">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : plan.error ? (
          <div className="px-5 py-4">
            <Banner tone="error">{planError(plan.error)}</Banner>
          </div>
        ) : plan.data ? (
          <PlanBody plan={plan.data} decimals={decimals} token={r.incident.token} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
