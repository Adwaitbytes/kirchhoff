"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, FileDown, FileText, RefreshCw, SearchX, Siren } from "lucide-react";
import type { Bytes32, IncidentResponse } from "@/lib/api/types";
import { isApiError } from "@/lib/api/client";
import { useIncident, useTokens } from "@/lib/api/hooks";
import { CHAINS } from "@/lib/chains";
import { readContractUrl, shortHash, txRefUrl } from "@/lib/explorer";
import { formatAmount, formatDateTime, parseWei } from "@/lib/format";
import { isBreached } from "@/lib/status";
import { Banner } from "@/components/kh/banner";
import { EmptyState, Panel, PanelHeader } from "@/components/kh/panel";
import { SimulationLabel } from "@/components/kh/simulation";
import { StatusChip } from "@/components/kh/status";
import { Verifiable } from "@/components/kh/links";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { EvidenceTimeline, evidenceDomId } from "@/components/incident/evidence-timeline";
import { ActionsCard, BlastRadiusCard, HeldMessagesCard, NarrativeCard, NextStepsCard } from "@/components/incident/side-cards";
import { ResolveIncident } from "@/components/incident/resolve-dialog";
import { LOOP_NOTE, isLoopRule, orNa } from "@/components/incident/loop";
import { buildMarkdown, buildPdf, downloadBlob, formatSeconds, incidentHeadline } from "@/components/incident/postmortem";

const BRIDGE_NAME: Readonly<Record<string, string>> = { weakbridge: "WeakBridge", ccip: "CCIP" };

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function isBytes32(v: string): v is Bytes32 {
  return BYTES32.test(v);
}

function TopStrip({ id }: { id: string }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-wire bg-panel/60 px-4 backdrop-blur">
      <Link href="/app" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted transition-colors hover:bg-raised hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Mission Control
      </Link>
      <span className="text-subtle" aria-hidden="true">
        /
      </span>
      <span className="truncate font-mono text-sm text-fg">{shortHash(id, 10, 6)}</span>
      <SimulationLabel className="ml-auto" />
    </div>
  );
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(id).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          },
          (e: unknown) => console.warn("Clipboard write failed", e),
        );
      }}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md font-mono text-lg font-medium text-fg tnum transition-colors hover:text-conserved"
      aria-label={`Copy incident id ${id}`}
      title={id}
    >
      {shortHash(id, 8, 6)}
      {copied ? <Check className="size-4 text-conserved" aria-hidden="true" /> : <Copy className="size-4 text-subtle" aria-hidden="true" />}
    </button>
  );
}

function Stat({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-wire/80 bg-panel/70 px-4 py-3 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.04)] backdrop-blur-sm">
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-1 min-w-0">{children}</div>
      {hint ? <p className="mt-1 truncate text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}

function Header({ r, decimals }: { r: IncidentResponse; decimals: number }) {
  const i = r.incident;
  const live = i.status === "open" && isBreached(r.tokenStatus);
  const delta = parseWei(i.deltaAfter);
  const firstBreach = r.evidence.find((e) => e.kind === "breach_report" && e.tx);
  const ledgerRead = readContractUrl(r.ledger.chain, r.ledger.address);
  const loop = isLoopRule(i);
  return (
    <section
      data-testid="incident-header"
      aria-labelledby="incident-title"
      className={cn(
        "relative overflow-hidden rounded-xl border bg-panel shadow-pop",
        live ? "border-broken/50" : "border-wire",
      )}
    >
      {live ? (
        <>
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-broken to-transparent" />
          <div aria-hidden="true" className="pointer-events-none absolute -left-32 -top-40 size-[520px] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--status-broken)_22%,transparent),transparent)]" />
          <div aria-hidden="true" className="pointer-events-none absolute -right-40 -bottom-56 size-[460px] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--status-quarantined)_12%,transparent),transparent)]" />
        </>
      ) : null}
      <div className="relative px-4 py-5 sm:px-6 sm:py-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-md px-2 font-mono text-xs font-semibold", i.severity === "SEV1" ? "bg-broken text-on-status" : "border border-drift/50 bg-drift/10 text-drift")}>
            <Siren className="size-3.5" aria-hidden="true" />
            {i.severity}
          </span>
          <StatusChip status={r.tokenStatus} />
          <span className="inline-flex h-6 items-center rounded-md border border-wire bg-inset px-2 text-xs text-muted">Incident {i.status}</span>
          <span className="font-mono text-xs text-subtle">{i.reason}</span>
        </div>
        <h1 id="incident-title" className="font-display mt-3 text-xl leading-[1.1] text-fg">
          {i.token} · {incidentHeadline(i.reason)}
        </h1>
        {loop ? (
          <div className="mt-1.5 max-w-[70ch] space-y-1 text-sm text-muted">
            <p>
              Loop Rule deficit · claims exceed backing by{" "}
              <Verifiable href={ledgerRead} label="Deficit, read ConservationLedger onchain" className="font-mono text-fg">
                {formatAmount(parseWei(i.offending.amount), { decimals, maxFraction: 0 })} {i.token}
              </Verifiable>{" "}
              across the circuit. Opened {formatDateTime(i.openedAt)}
            </p>
            <p className="text-xs text-subtle" data-testid="loop-rule-note">{LOOP_NOTE}</p>
          </div>
        ) : (
          <p className="mt-1.5 max-w-[70ch] text-sm text-muted">
            <Verifiable href={txRefUrl(i.offending.tx)} label="Offending credit transaction" className="font-mono text-fg">
              {formatAmount(parseWei(i.offending.amount), { decimals, maxFraction: 0 })} {i.token}
            </Verifiable>{" "}
            credited on {CHAINS[i.offending.chain].name} through {BRIDGE_NAME[i.offending.bridge] ?? i.offending.bridge}, claimed from {CHAINS[i.offending.claimedSrcChain].name}. Opened {formatDateTime(i.openedAt)}
          </p>
        )}
        <div className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Δ after" hint={`Before ${formatAmount(parseWei(i.deltaBefore), { decimals, signed: true, maxFraction: 0 })}`}>
            <Verifiable href={ledgerRead} label="Δ after, read ConservationLedger onchain" className={cn("font-display text-2xl leading-none", delta < 0n ? "text-broken" : "text-fg")}>
              {formatAmount(delta, { decimals, signed: true, maxFraction: 0 })}
            </Verifiable>
            <span className="ml-1.5 text-xs text-muted">{i.token}</span>
          </Stat>
          <Stat label={loop ? "Detection to BROKEN" : "Offending block to BROKEN"} hint={`${formatDateTime(i.offendingBlockAt)}`}>
            {firstBreach?.tx ? (
              <Verifiable href={txRefUrl(firstBreach.tx)} label="First BREACH report transaction" className="font-display text-xl text-fg">
                {formatSeconds(i.timeToBrokenSeconds)}
              </Verifiable>
            ) : (
              <span className="font-display text-xl text-fg tnum">{formatSeconds(i.timeToBrokenSeconds)}</span>
            )}
          </Stat>
          <Stat label={loop ? "Home BREACH report" : "Offending credit"} hint={`Recipient ${orNa(i.offending.recipient, (a) => shortHash(a))}`}>
            <Verifiable href={txRefUrl(i.offending.tx)} label={loop ? "Home BREACH report transaction" : "Offending credit transaction"} className="font-mono text-lg font-medium text-fg/90">
              {shortHash(i.offending.tx.hash)}
            </Verifiable>
          </Stat>
          <Stat label="Incident id" hint={`Evidence ${shortHash(i.evidenceHash)}`}>
            <CopyId id={i.id} />
          </Stat>
        </div>
      </div>
    </section>
  );
}

function ExportPostmortem({ r, decimals }: { r: IncidentResponse; decimals: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `kirchhoff-postmortem-${r.incident.token}-${r.incident.id.slice(2, 10)}`;
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end" data-testid="export-postmortem">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => downloadBlob(new Blob([buildMarkdown(r, decimals)], { type: "text/markdown;charset=utf-8" }), `${base}.md`)} data-testid="export-markdown">
          <FileText aria-hidden="true" />
          Postmortem .md
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          data-testid="export-pdf"
          onClick={() => {
            setBusy(true);
            setError(null);
            buildPdf(r, decimals)
              .then((blob) => downloadBlob(blob, `${base}.pdf`))
              .catch((e: unknown) => {
                console.error("Postmortem PDF failed", e);
                setError("PDF export failed. Markdown still works");
              })
              .finally(() => setBusy(false));
          }}
        >
          <FileDown aria-hidden="true" />
          {busy ? "Rendering PDF" : "Postmortem .pdf"}
        </Button>
      </div>
      {error ? (
        <span role="alert" className="text-xs text-broken">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function LoadingRoom() {
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 p-4 sm:p-6" aria-busy="true" aria-label="Loading incident">
      <div className="rounded-xl border border-wire bg-panel p-6">
        <div className="flex gap-2">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-6 w-28" />
        </div>
        <Skeleton className="mt-4 h-8 w-80 max-w-full" />
        <Skeleton className="mt-2 h-4 w-[34rem] max-w-full" />
        <div className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[86px] rounded-lg" />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="space-y-3 rounded-lg border border-wire bg-panel p-5">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="grid grid-cols-[28px_1fr] gap-3">
              <Skeleton className="size-7 rounded-full" />
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-4">
          <Skeleton className="h-56 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <EmptyState
      icon={<SearchX className="size-6" />}
      title="No incident with this id on the circuit"
      action={
        <Button asChild variant="primary">
          <Link href="/app">Back to Mission Control</Link>
        </Button>
      }
    />
  );
}

function LoadedRoom({ id }: { id: Bytes32 }) {
  const q = useIncident(id);
  const tokens = useTokens();
  const [highlight, setHighlight] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const cite = useCallback((evId: string) => {
    const el = document.getElementById(evidenceDomId(evId));
    el?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    setHighlight(evId);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHighlight(null), 2_400);
  }, []);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  if (isApiError(q.error) && q.error.code === "NOT_FOUND") return <NotFound />;
  const r = q.data;
  if (!r) {
    return (
      <>
        {q.error ? (
          <div className="px-4 pt-4 sm:px-6">
            <Banner
              tone="error"
              action={
                <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>
                  <RefreshCw aria-hidden="true" /> Retry
                </Button>
              }
            >
              Incident read failed: {q.error.message}. Onchain evidence is unaffected
            </Banner>
          </div>
        ) : null}
        <LoadingRoom />
      </>
    );
  }
  const decimals = tokens.data?.items.find((t) => t.symbol === r.incident.token)?.decimals ?? 18;
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 p-4 sm:p-6">
      {q.error ? (
        <Banner tone="error">Live refresh failed: {q.error.message}. Showing the last read from block {r.block.number}</Banner>
      ) : null}
      <Header r={r} decimals={decimals} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <Panel aria-labelledby="evidence-title" className="lg:self-start">
          <PanelHeader id="evidence-title" title="Evidence trail" meta={`${r.evidence.length} facts, oldest first`} />
          <EvidenceTimeline evidence={r.evidence} highlighted={highlight} />
        </Panel>
        <div className="flex min-w-0 flex-col gap-4">
          <NarrativeCard r={r} onCite={cite} />
          <ActionsCard r={r} />
          <HeldMessagesCard r={r} decimals={decimals} />
          <BlastRadiusCard r={r} decimals={decimals} />
          <NextStepsCard r={r} />
        </div>
      </div>
      <footer className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t border-wire bg-canvas/85 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <ResolveIncident r={r} />
        <ExportPostmortem r={r} decimals={decimals} />
      </footer>
    </div>
  );
}

export function IncidentRoom({ id }: { id: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopStrip id={id} />
      <div className="min-h-0 flex-1 overflow-y-auto">{isBytes32(id) ? <LoadedRoom id={id} /> : <NotFound />}</div>
    </div>
  );
}
