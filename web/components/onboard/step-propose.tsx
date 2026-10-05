"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import type { Bytes32, ChainKey, SpecProposalResponse } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import { safeQueueUrl, safeTxBuilderUrl } from "@/lib/explorer";
import { formatDateTime } from "@/lib/format";
import { AddressLink, TxLink } from "@/components/kh/links";
import { Banner } from "@/components/kh/banner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
        window.setTimeout(() => setState("idle"), 1800);
      }}
      aria-label={label}
    >
      {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {state === "copied" ? "Copied" : state === "failed" ? "Copy blocked" : "Copy"}
    </Button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-wire/70 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

export function StepPropose({
  specHash,
  chain,
  proposal,
  pending,
  error,
  onCheck,
  checking,
}: {
  specHash: Bytes32;
  chain: ChainKey;
  proposal: SpecProposalResponse | undefined;
  pending: boolean;
  error: string | null;
  onCheck: () => void;
  checking: boolean;
}) {
  const proposed = proposal && proposal.state !== "draft";
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <section aria-labelledby="safe-payload" className="rounded-xl border border-wire bg-panel p-5 shadow-panel">
        <h3 id="safe-payload" className="flex items-center gap-2 text-sm font-semibold text-fg">
          <ShieldCheck className="size-4 text-conserved" aria-hidden="true" /> What the Safe signs
        </h3>
        <dl className="mt-2">
          <Row label="Spec hash">
            <span className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 break-all font-mono text-xs text-fg">{specHash}</code>
              <CopyButton value={specHash} label="Copy spec hash" />
            </span>
          </Row>
          <Row label="KirchhoffRegistry">
            {proposal ? <AddressLink chain={chain} address={proposal.registry} read /> : pending ? <Skeleton className="h-4 w-28" /> : <span className="text-subtle">unavailable</span>}
          </Row>
          <Row label="Issuer Safe">
            {proposal ? <AddressLink chain={chain} address={proposal.issuerSafe} /> : pending ? <Skeleton className="h-4 w-28" /> : <span className="text-subtle">unavailable</span>}
          </Row>
          <Row label="Chain">
            <span className="text-fg">{CHAINS[chain].name}</span>
          </Row>
        </dl>
        <p className="mt-3 rounded-lg bg-inset px-3 py-2.5 text-xs leading-relaxed text-muted">
          Calldata: a KirchhoffRegistry propose call carrying this spec hash, sent by the issuer Safe. Paste the hash into the Safe Transaction Builder. KIRCHHOFF never signs it for you.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {proposal ? (
            <>
              <Button asChild variant="primary">
                <a href={safeTxBuilderUrl(chain, proposal.issuerSafe)} target="_blank" rel="noopener noreferrer">
                  Open Safe Transaction Builder <ExternalLink aria-hidden="true" />
                </a>
              </Button>
              <Button asChild variant="outline">
                <a href={safeQueueUrl(chain, proposal.issuerSafe)} target="_blank" rel="noopener noreferrer">
                  Safe queue <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            </>
          ) : null}
        </div>
      </section>
      <aside className="space-y-4">
        {error ? (
          <Banner
            tone="error"
            action={
              <Button size="sm" variant="ghost" onClick={onCheck}>
                Retry
              </Button>
            }
          >
            Proposal lookup failed: {error}
          </Banner>
        ) : null}
        <section
          aria-live="polite"
          className={cn(
            "relative overflow-hidden rounded-xl border p-5",
            proposed ? "border-conserved/40 bg-conserved/5 shadow-[0_0_40px_-16px_var(--status-conserved)]" : "border-wire bg-inset",
          )}
        >
          <p className="text-xs font-medium text-subtle">Registry state</p>
          {pending && !proposal ? (
            <Skeleton className="mt-2 h-7 w-40" />
          ) : (
            <p className={cn("mt-1 text-lg font-semibold tracking-[-0.01em]", proposed ? "text-conserved" : "text-fg")}>
              {proposed ? "Proposed, timelock armed" : "Waiting for the Safe"}
            </p>
          )}
          {proposal?.proposeTx ? (
            <div className="mt-3 space-y-1 text-sm text-muted">
              <p>{proposal.proposedAt ? `Proposed ${formatDateTime(proposal.proposedAt)}` : null}</p>
              <TxLink tx={proposal.proposeTx} showChain />
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">Sign and execute in the Safe, then check the registry.</p>
          )}
          <Button size="sm" variant="ghost" className="mt-3" onClick={onCheck} disabled={checking}>
            <RefreshCw className={cn(checking && "motion-safe:animate-spin")} aria-hidden="true" /> Check registry
          </Button>
        </section>
      </aside>
    </div>
  );
}
