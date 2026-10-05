"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Check, Plus, Radar, RotateCcw, X } from "lucide-react";
import type { ChainKey, ScoutFindingKind, ScoutProposal } from "@/lib/api/types";
import { CHAIN_KEYS } from "@/lib/api/types";
import { useApi } from "@/lib/api/provider";
import { isApiError } from "@/lib/api/client";
import { addressUrl, shortHash } from "@/lib/explorer";
import { Banner } from "@/components/kh/banner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<ScoutFindingKind, string> = {
  new_chain: "New chain",
  bridged_variant: "Bridged variant",
  oft_peer: "OFT peer",
  unlisted_minter: "Unlisted minter",
  same_symbol: "Same symbol",
};

const CONFIDENCE: Record<ScoutProposal["confidence"], string> = {
  high: "border-broken/45 bg-broken/10 text-broken",
  medium: "border-drift/45 bg-drift/10 text-drift",
  low: "border-wire bg-inset text-muted",
};

function isOurChain(chain: string): chain is ChainKey {
  return (CHAIN_KEYS as readonly string[]).includes(chain);
}

function addressHref(p: ScoutProposal): string | null {
  if (isOurChain(p.chain)) return addressUrl(p.chain, p.address);
  return p.evidence[0]?.href ?? null;
}

function scoutError(e: unknown): { message: string; unauthorized: boolean } {
  if (isApiError(e) && e.code === "UNAUTHORIZED") return { message: "Issuer key required", unauthorized: true };
  if (isApiError(e)) return { message: e.message, unauthorized: false };
  return { message: "Scout is unreachable", unauthorized: false };
}

function Finding({ p, added, onAdd, onDismiss }: { p: ScoutProposal; added: boolean; onAdd: () => void; onDismiss: () => void }) {
  const href = addressHref(p);
  return (
    <li data-testid="scout-proposal" className="rounded-xl border border-wire bg-panel p-4 shadow-panel transition-colors hover:border-line-strong">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-wire bg-inset px-2 py-0.5 text-xs font-medium text-fg">{KIND_LABEL[p.kind]}</span>
        <span className="text-xs text-muted">{p.chainName}</span>
        <span className={cn("ml-auto rounded-md border px-2 py-0.5 font-mono text-2xs", CONFIDENCE[p.confidence])}>{p.confidence} confidence</span>
      </div>
      <p className="mt-2.5 text-sm text-fg">{p.summary}</p>
      <p className="mt-1.5 font-mono text-xs text-muted">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 rounded-sm hover:text-fg hover:underline">
            {shortHash(p.address)}
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </a>
        ) : (
          shortHash(p.address)
        )}
      </p>
      {p.evidence.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Evidence">
          {p.evidence.map((e) => (
            <li key={e.href}>
              <a href={e.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 rounded-sm text-conserved hover:underline">
                {e.label}
                <ArrowUpRight className="size-3" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {p.specPatch ? <pre tabIndex={0} className="mt-3 overflow-x-auto rounded-md border border-wire bg-inset px-3 py-2 font-mono text-xs text-fg">{p.specPatch}</pre> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {p.specPatch ? (
          <Button size="sm" variant={added ? "ghost" : "secondary"} onClick={onAdd} disabled={added}>
            {added ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
            {added ? "Added as issuer lines" : "Add to draft"}
          </Button>
        ) : (
          <span className="text-xs text-muted">Needs human judgment. No spec patch</span>
        )}
        <Button size="sm" variant="ghost" onClick={onDismiss} aria-label={`Dismiss ${KIND_LABEL[p.kind]} finding on ${p.chainName}`}>
          <X aria-hidden="true" /> Dismiss
        </Button>
      </div>
    </li>
  );
}

/**
 * Topology Scout (PRD section 11, feature 3): finds supply paths the spec forgot. Findings are
 * drafts with cited evidence; the issuer decides. The Scout has no write powers.
 */
export function ScoutPanel({ token, onAddPatch }: { token: string; onAddPatch: (p: ScoutProposal) => void }) {
  const api = useApi();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const list = useQuery({ queryKey: ["scout-proposals", token], queryFn: ({ signal }) => api.listScoutProposals(token, signal), retry: false });
  const run = useMutation({ mutationFn: () => api.scout({ token }) });
  const items = (run.data?.proposals ?? list.data?.items ?? []).filter((p) => !dismissed.has(p.id) && p.status === "open");
  const err = run.error ? scoutError(run.error) : list.error ? scoutError(list.error) : null;
  const loading = list.isPending && !run.data;

  return (
    <section data-testid="scout-panel" aria-labelledby="scout-title" className="rounded-2xl border border-wire bg-[linear-gradient(180deg,var(--panel-top),var(--bg-panel))] p-4 shadow-[inset_0_1px_0_0_var(--panel-highlight),var(--shadow-panel)] sm:p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-wire bg-inset text-conserved">
          <Radar className="size-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="scout-title" className="text-sm font-semibold text-fg">
            Topology Scout
          </h3>
          <p className="text-sm text-muted">Paths into {token} the spec does not cover yet</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => run.mutate()} disabled={run.isPending} data-testid="scout-run">
          <RotateCcw className={cn(run.isPending && "motion-safe:animate-spin")} aria-hidden="true" />
          {run.isPending ? "Scouting" : "Run Scout"}
        </Button>
      </div>
      <p className="mt-3 inline-flex items-center rounded-md border border-drift/40 bg-drift/10 px-2 py-1 text-xs font-medium text-drift">Scout finding. Verify the evidence.</p>

      <div className="mt-4" aria-live="polite" aria-busy={loading || run.isPending}>
        {err ? (
          <Banner tone="error">
            {err.message}.{" "}
            {err.unauthorized ? (
              <>
                Add your issuer API key in <span className="font-medium">step 1, Describe</span>, then run the Scout again.
              </>
            ) : null}
          </Banner>
        ) : loading || run.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-wire px-4 py-6 text-center text-sm text-muted">No open findings. Run the Scout to crawl for new paths</p>
        ) : (
          <ul className="space-y-3">
            {items.map((p) => (
              <Finding
                key={p.id}
                p={p}
                added={added.has(p.id)}
                onAdd={() => {
                  onAddPatch(p);
                  setAdded((s) => new Set(s).add(p.id));
                }}
                onDismiss={() => setDismissed((s) => new Set(s).add(p.id))}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
