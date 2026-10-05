"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { RefreshCw, SearchX } from "lucide-react";
import type { ChainKey, TokenStatusResponse } from "@/lib/api/types";
import { isApiError } from "@/lib/api/client";
import { useEpochs24h, useNow, useTokenStatus, useTokenStream, useVerdicts } from "@/lib/api/hooks";
import { CHAINS } from "@/lib/chains";
import { formatAge, secondsBetween } from "@/lib/format";
import { isBreached } from "@/lib/status";
import { Banner } from "@/components/kh/banner";
import { EmptyState, Panel, PanelHeader } from "@/components/kh/panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MissionTopBar } from "@/components/mission/top-bar";
import { CircuitMap } from "@/components/mission/circuit-map";
import { ConservationMeter } from "@/components/mission/conservation-meter";
import { VerdictStream, VerdictStreamSkeleton } from "@/components/mission/verdict-stream";
import { LedgerTable, LedgerTableSkeleton } from "@/components/mission/ledger-table";
import { DeltaHistory, DeltaHistorySkeleton } from "@/components/mission/delta-history";
import { LedgerDrawer } from "@/components/mission/ledger-drawer";
import { BreachEffects, BreachToast } from "@/components/mission/breach-effects";
import { cn } from "@/lib/utils";
import { ClientGate } from "@/components/kh/client-gate";

function StaleBanner({ status }: { status: TokenStatusResponse }) {
  const now = useNow();
  const age = now === 0 ? 0 : secondsBetween(status.token.updatedAt, now);
  return (
    <Banner tone="stale">
      Last epoch {formatAge(age)} ago. Verdicts follow the token&apos;s stale policy.
    </Banner>
  );
}

function StateBanners({ status, apiError, onRetry }: { status: TokenStatusResponse | undefined; apiError: Error | null; onRetry: () => void }) {
  const failing = status?.chains.filter((c) => !c.read.ok) ?? [];
  const breached = status ? isBreached(status.token.status) : false;
  return (
    <>
      {apiError ? (
        <Banner
          tone="error"
          action={
            <Button size="sm" variant="ghost" onClick={onRetry}>
              <RefreshCw aria-hidden="true" /> Retry
            </Button>
          }
        >
          {isApiError(apiError) && apiError.chain ? `${CHAINS[apiError.chain].name} read failed: ` : "KIRCHHOFF API unreachable: "}
          {apiError.message}. Verdicts are unaffected; the onchain feed still answers.
          {status ? " Showing the last values received." : ""}
        </Banner>
      ) : null}
      {failing.map((c) =>
        c.read.ok ? null : (
          <Banner key={c.chain} tone="error">
            <span className="font-medium">{CHAINS[c.chain].name} RPC error:</span> {c.read.error}.{" "}
            {c.read.lastGoodBlock ? `Its values are from block ${Number(c.read.lastGoodBlock.number).toLocaleString("en-US")}. ` : ""}The other chains stay live.
          </Banner>
        ),
      )}
      {status?.token.stale ? <StaleBanner status={status} /> : null}
      {status && breached ? <BreachToast status={status} /> : null}
    </>
  );
}

function MapSkeleton() {
  return (
    <div className="relative flex-1 schematic-grid" aria-hidden="true">
      <Skeleton className="absolute left-[3%] top-[8%] h-[19%] w-[23%] rounded-lg" />
      <Skeleton className="absolute right-[3%] top-[8%] h-[19%] w-[23%] rounded-lg" />
      <Skeleton className="absolute left-1/2 top-[40%] h-[24%] w-[28%] -translate-x-1/2 rounded-xl" />
      <Skeleton className="absolute bottom-[3%] left-1/2 h-[19%] w-[23%] -translate-x-1/2 rounded-lg" />
    </div>
  );
}

function MeterSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-4 pb-4 pt-3" aria-hidden="true">
      <div className="space-y-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
      </div>
      {/* Δ never shows a spinner: a skeleton the size of the 72px readout. */}
      <Skeleton className="h-[72px] w-3/4" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

function MissionControlLive({ token, variant }: { token: string; variant: "full" | "embedded" }) {
  const status = useTokenStatus(token);
  const verdicts = useVerdicts(token);
  const epochs = useEpochs24h(token);
  const stream = useTokenStream(token);
  const [drawer, setDrawer] = useState<ChainKey | null>(null);
  const [historyView, setHistoryView] = useState<"chart" | "table">("chart");
  const openChain = useCallback((c: ChainKey) => setDrawer(c), []);
  const data = status.data;
  const notFound = isApiError(status.error) && status.error.code === "NOT_FOUND";
  const stale = data?.token.stale ?? false;
  const retry = () => {
    void status.refetch();
    void verdicts.refetch();
    void epochs.refetch();
  };

  if (notFound) {
    return (
      <div className="flex flex-1 flex-col">
        <MissionTopBar token={token} status={undefined} stream={stream} />
        <EmptyState
          icon={<SearchX className="size-6" />}
          title={`${token} is not a protected token. Onboard it to start verifying conservation.`}
          action={
            <Button asChild variant="primary">
              <Link href="/app/onboard">Onboard a token</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const apiError = status.error ?? null;
  const decimals = data?.token.decimals ?? 18;

  const mapPanel = (
    <Panel className={cn("flex-1 overflow-hidden", stale && "is-stale")} aria-labelledby="circuit-title">
      <PanelHeader
        id="circuit-title"
        title="Circuit"
        meta={data ? `${data.chains.length} chains · ${data.bridges.length} bridges · live current` : undefined}
        actions={<span className="hidden text-xs text-subtle xl:inline">Hover a wire for its last 10 transfers · click a chain for its ledger</span>}
      />
      <div className="relative flex min-h-0 flex-1">{data ? <CircuitMap status={data} onOpenChain={openChain} /> : <MapSkeleton />}</div>
    </Panel>
  );

  const meterPanel = (
    <Panel className={cn(stale && "is-stale")} aria-labelledby="meter-title">
      <PanelHeader id="meter-title" title="Balance" meta="Backing vs claims · one scale" />
      {data ? <ConservationMeter status={data} /> : <MeterSkeleton />}
    </Panel>
  );

  const streamPanel = (
    <Panel className={cn("min-h-0 flex-1 overflow-hidden", stale && "is-stale")} aria-labelledby="stream-title">
      <PanelHeader id="stream-title" title="Verdicts" meta="CCV Judge · newest on top" />
      {verdicts.data && data ? <VerdictStream verdicts={verdicts.data.items} decimals={decimals} symbol={data.token.symbol} /> : <VerdictStreamSkeleton />}
    </Panel>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MissionTopBar token={token} status={data} stream={stream} />
      <BreachEffects status={data} />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-4 xl:overflow-hidden">
        <StateBanners status={data} apiError={apiError} onRetry={retry} />
        {variant === "full" ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(380px,1fr)] xl:grid-rows-[minmax(0,1fr)_minmax(240px,30%)]">
            <div className="flex min-h-[540px] flex-col sm:min-h-[560px] xl:min-h-0">{mapPanel}</div>
            <div className="flex min-h-[640px] flex-col gap-3 xl:min-h-0">
              {meterPanel}
              {streamPanel}
            </div>
            <div className="grid min-h-0 grid-cols-1 gap-3 xl:col-span-2 xl:grid-cols-2">
              <Panel className={cn("min-h-[240px] overflow-hidden xl:min-h-0", stale && "is-stale")} aria-labelledby="ledger-title">
                <PanelHeader id="ledger-title" title="Ledger" meta={data?.epoch ? `Epoch ${Number(data.epoch.epochId).toLocaleString("en-US")} pinned blocks` : undefined} />
                {data ? <LedgerTable status={data} onOpenChain={openChain} /> : <LedgerTableSkeleton />}
              </Panel>
              <Panel className={cn("min-h-[240px] overflow-hidden xl:min-h-0", stale && "is-stale")} aria-labelledby="history-title">
                <PanelHeader
                  id="history-title"
                  title="Δ over 24h"
                  meta="Red marks an incident"
                  actions={
                    <Tabs value={historyView} onValueChange={(v) => setHistoryView(v === "table" ? "table" : "chart")}>
                      <TabsList label="Δ history view">
                        <TabsTrigger value="chart">Chart</TabsTrigger>
                        <TabsTrigger value="table">Table</TabsTrigger>
                      </TabsList>
                    </Tabs>
                  }
                />
                {epochs.data && data ? <DeltaHistory epochs={epochs.data.items} decimals={decimals} symbol={data.token.symbol} view={historyView} /> : <DeltaHistorySkeleton />}
              </Panel>
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 gap-3 xl:grid-rows-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <div className="flex min-h-[540px] flex-col xl:min-h-0">{mapPanel}</div>
            <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className="flex min-h-0 flex-col">{meterPanel}</div>
              <div className="flex min-h-[420px] flex-col xl:min-h-0">{streamPanel}</div>
            </div>
          </div>
        )}
      </div>
      {data ? <LedgerDrawer status={data} chain={drawer} onClose={() => setDrawer(null)} /> : null}
    </div>
  );
}

/** Server and hydration markup: static skeleton panels with no generated ids (see ClientGate). */
function MissionControlSkeleton({ token, variant }: { token: string; variant: "full" | "embedded" }) {
  const head = (title: string) => (
    <header className="flex min-h-12 shrink-0 items-center border-b border-wire px-4 py-2.5">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
    </header>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
      <div className="flex min-h-14 shrink-0 items-center gap-4 border-b border-wire px-3 sm:px-4">
        <span className="px-2 text-base font-semibold text-fg">{token}</span>
        <Skeleton className="h-8 w-44 rounded-full sm:w-56" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 sm:p-4">
        <div className={cn("grid min-h-0 flex-1 grid-cols-1 gap-3", variant === "full" ? "xl:grid-cols-[minmax(0,2fr)_minmax(380px,1fr)] xl:grid-rows-[minmax(0,1fr)_minmax(240px,30%)]" : "xl:grid-rows-[minmax(0,1.7fr)_minmax(0,1fr)]")}>
          <section className="panel flex min-h-[540px] flex-col overflow-hidden xl:min-h-0">
            {head("Circuit")}
            <MapSkeleton />
          </section>
          <div className="flex min-h-0 flex-col gap-3">
            <section className="panel flex flex-col">
              {head("Balance")}
              <MeterSkeleton />
            </section>
            <section className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
              {head("Verdicts")}
              <VerdictStreamSkeleton />
            </section>
          </div>
          {variant === "full" ? (
            <div className="grid min-h-0 grid-cols-1 gap-3 xl:col-span-2 xl:grid-cols-2">
              <section className="panel flex min-h-[240px] flex-col overflow-hidden xl:min-h-0">
                {head("Ledger")}
                <LedgerTableSkeleton />
              </section>
              <section className="panel flex min-h-[240px] flex-col overflow-hidden xl:min-h-0">
                {head("Δ over 24h")}
                <DeltaHistorySkeleton />
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function MissionControl({ token, variant = "full" }: { token: string; variant?: "full" | "embedded" }) {
  return (
    <ClientGate fallback={<MissionControlSkeleton token={token} variant={variant} />}>
      <MissionControlLive token={token} variant={variant} />
    </ClientGate>
  );
}
