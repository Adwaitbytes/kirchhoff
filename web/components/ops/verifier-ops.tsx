"use client";

import { useState } from "react";
import { Activity, Cpu, RefreshCw, Server, ShieldCheck, Workflow } from "lucide-react";
import type { CreRun, OpsResponse, ReasonCode } from "@/lib/api/types";
import { useNow, useOps } from "@/lib/api/hooks";
import { CHAINS } from "@/lib/chains";
import { blockUrl } from "@/lib/explorer";
import { formatAge, formatTime, secondsBetween } from "@/lib/format";
import { Banner } from "@/components/kh/banner";
import { EmptyState, Panel, PanelHeader } from "@/components/kh/panel";
import { TxLink, Verifiable } from "@/components/kh/links";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const WORKFLOW_LABEL: Record<CreRun["workflow"], string> = {
  "w1-junction": "W1 Junction Watch",
  "w2-loop": "W2 Loop Ledger",
  "w3-responder": "W3 Responder",
  "w4-topology": "W4 Topology Watch",
};

const OUTCOME_STYLE: Record<CreRun["outcome"], string> = {
  ok: "text-conserved",
  breach: "text-broken",
  error: "text-drift",
  noop: "text-muted",
};

function Stat({ label, value, unit, hint, testId, tone = "fg" }: { label: string; value: string; unit?: string; hint?: string; testId?: string; tone?: "fg" | "conserved" | "broken" }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-wire bg-inset px-4 py-3.5 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.03)]" data-testid={testId}>
      <p className="text-xs text-muted">{label}</p>
      <p className={cn("mt-1.5 font-mono text-2xl font-medium leading-none tracking-[-0.03em] tnum", tone === "conserved" ? "text-conserved" : tone === "broken" ? "text-broken" : "text-fg")}>
        {value}
        {unit ? <span className="ml-1 font-sans text-base font-normal tracking-normal text-muted">{unit}</span> : null}
      </p>
      {hint ? <p className="mt-2 text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}

function Enforcement({ ops }: { ops: OpsResponse }) {
  const cell = ops.enforcement === "ccv_cell";
  return (
    <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium", cell ? "border-conserved/40 bg-conserved/10 text-conserved" : "border-drift/40 bg-drift/10 text-drift")}>
      <ShieldCheck className="size-3.5" aria-hidden="true" />
      {cell ? "Live CCV cells sign every kETH message" : "Fallback B: KirchhoffTokenPool enforces inside CCIP pools"}
    </div>
  );
}

function Cells({ ops }: { ops: OpsResponse }) {
  const now = useNow();
  const healthy = ops.cells.filter((c) => c.healthy).length;
  return (
    <Panel aria-labelledby="cells-title">
      <PanelHeader id="cells-title" title="Cells" meta={`${healthy} of ${ops.cells.length} healthy · identical Judge in each`} />
      {ops.cells.length === 0 ? (
        <EmptyState icon={<Server className="size-5" />} title="No cells reporting. Deploy a cell from the CCV Starter Kit to sign verdicts." />
      ) : (
        <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {ops.cells.map((c) => (
            <li
              key={c.id}
              className={cn(
                "group relative overflow-hidden rounded-lg border bg-inset p-3.5 transition-[border-color,box-shadow] duration-200 hover:shadow-pop",
                c.healthy ? "border-wire hover:border-conserved/40" : "border-broken/50",
              )}
            >
              <span aria-hidden="true" className={cn("absolute inset-x-0 top-0 h-px", c.healthy ? "bg-gradient-to-r from-transparent via-conserved/60 to-transparent" : "bg-broken")} />
              <div className="flex items-center gap-2">
                <span className={cn("relative size-2 rounded-full", c.healthy ? "bg-conserved" : "bg-broken")} aria-hidden="true">
                  {c.healthy ? <span className="absolute inset-0 rounded-full bg-conserved opacity-60 motion-safe:animate-ping" style={{ animationDuration: "2.6s" }} /> : null}
                </span>
                <span className="font-mono text-sm font-medium text-fg">{c.name}</span>
                <span className={cn("ml-auto text-xs font-medium", c.healthy ? "text-conserved" : "text-broken")}>{c.healthy ? "Healthy" : "Down"}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
                <dt className="text-muted">Region</dt>
                <dd className="text-right font-mono text-fg">{c.region}</dd>
                <dt className="text-muted">Heartbeat</dt>
                <dd className="text-right font-mono text-fg tnum">{now === 0 ? "" : `${formatAge(secondsBetween(c.lastHeartbeatAt, now))} ago`}</dd>
                <dt className="text-muted">Policy transitions</dt>
                <dd className="text-right font-mono text-fg tnum">{c.policyTransitions.toLocaleString("en-US")}</dd>
                <dt className="text-muted">Version</dt>
                <dd className="text-right font-mono text-subtle">{c.version}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Verdicts({ ops }: { ops: OpsResponse }) {
  const [view, setView] = useState<"bars" | "table">("bars");
  const entries = (Object.entries(ops.verdictCounts.byReason) as [ReasonCode, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  const total = ops.verdictCounts.pass + ops.verdictCounts.fail;
  return (
    <Panel aria-labelledby="verdicts-title">
      <PanelHeader
        id="verdicts-title"
        title="Verdicts"
        meta={`Last ${Math.round(ops.windowSeconds / 60)} min`}
        actions={
          <Tabs value={view} onValueChange={(v) => setView(v === "table" ? "table" : "bars")}>
            <TabsList label="Verdict breakdown view">
              <TabsTrigger value="bars">Bars</TabsTrigger>
              <TabsTrigger value="table">Table</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />
      <div className="grid grid-cols-2 gap-3 p-4 pb-2">
        <Stat label="PASS" value={ops.verdictCounts.pass.toLocaleString("en-US")} tone="conserved" />
        <Stat label="FAIL" value={ops.verdictCounts.fail.toLocaleString("en-US")} tone={ops.verdictCounts.fail > 0 ? "broken" : "fg"} />
      </div>
      {total === 0 ? (
        <EmptyState title="No verdicts in this window yet." />
      ) : view === "bars" ? (
        <ul className="space-y-2.5 px-4 pb-4 pt-2" aria-label="Verdicts by reason code">
          {entries.map(([reason, n]) => (
            <li key={reason} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-xs">
              <span className="truncate font-mono text-muted">{reason}</span>
              <span className="h-2 overflow-hidden rounded-full bg-inset" aria-hidden="true">
                <span className={cn("block h-full rounded-full", reason === "OK" ? "bg-conserved/80" : "bg-broken/80")} style={{ width: `${Math.max(2, (n / max) * 100)}%` }} />
              </span>
              <span className="font-mono text-fg tnum">{n.toLocaleString("en-US")}</span>
            </li>
          ))}
        </ul>
      ) : (
        <table className="w-full text-xs tnum">
          <caption className="sr-only">Verdicts by reason code</caption>
          <thead>
            <tr className="border-y border-wire text-subtle">
              <th scope="col" className="py-2 pl-4 text-left font-medium">Reason</th>
              <th scope="col" className="px-3 text-right font-medium">Count</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([reason, n]) => (
              <tr key={reason} className="border-b border-wire/60 last:border-0">
                <td className="py-2 pl-4 font-mono text-muted">{reason}</td>
                <td className="px-3 text-right font-mono text-fg">{n.toLocaleString("en-US")}</td>
                <td className="py-2 pr-4 text-right font-mono text-muted">{((n / total) * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Rpc({ ops }: { ops: OpsResponse }) {
  return (
    <Panel aria-labelledby="rpc-title">
      <PanelHeader id="rpc-title" title="RPC agreement" meta="Two independent providers per chain. Disagreement fails closed" />
      <ul className="divide-y divide-wire/70">
        {ops.rpc.map((r) => {
          const pct = r.agreementRate * 100;
          const full = r.agreementRate >= 1;
          return (
            <li key={r.chain} className="space-y-2.5 px-4 py-3.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-fg">{CHAINS[r.chain].name}</span>
                <span className={cn("ml-auto font-mono text-sm tnum", full ? "text-conserved" : "text-drift")}>{pct.toFixed(pct === 100 ? 0 : 1)}%</span>
                <span className="text-xs text-muted">agree</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-inset" aria-hidden="true">
                <div className={cn("h-full rounded-full", full ? "bg-conserved/80" : "bg-drift/80")} style={{ width: `${pct}%` }} />
              </div>
              <ul className="grid gap-2 sm:grid-cols-2">
                {r.providers.map((p) => (
                  <li key={p.name} className="flex items-center gap-2 rounded-md border border-wire bg-inset px-2.5 py-1.5 text-xs">
                    <span className={cn("size-1.5 shrink-0 rounded-full", p.healthy ? "bg-conserved" : "bg-broken")} aria-hidden="true" />
                    <span className="font-medium text-fg">{p.name}</span>
                    <span className="sr-only">{p.healthy ? "healthy" : "unhealthy"}</span>
                    <Verifiable href={blockUrl(r.chain, p.head)} label={`${p.name} head block on ${CHAINS[r.chain].name}`} className="ml-auto font-mono text-muted">
                      #{Number(p.head).toLocaleString("en-US")}
                    </Verifiable>
                    <span className="font-mono text-subtle tnum">{p.latencyMs}ms</span>
                  </li>
                ))}
              </ul>
              {r.lastDisagreementAt ? <p className="text-xs text-drift">Last disagreement {formatTime(r.lastDisagreementAt)} UTC</p> : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Runs({ ops }: { ops: OpsResponse }) {
  return (
    <Panel aria-labelledby="runs-title">
      <PanelHeader id="runs-title" title="CRE run history" meta="Four workflows, DON consensus reads, signed reports" />
      {ops.creRuns.length === 0 ? (
        <EmptyState icon={<Workflow className="size-5" />} title="No workflow runs yet. Simulate or deploy W1 to W4 to start the engine." />
      ) : (
        <>
          <ul className="divide-y divide-wire/70 md:hidden">
            {ops.creRuns.map((r) => (
              <li key={r.runId} className="space-y-1.5 px-4 py-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{WORKFLOW_LABEL[r.workflow]}</span>
                  <span className={cn("ml-auto font-mono font-medium", OUTCOME_STYLE[r.outcome])}>{r.outcome}</span>
                </div>
                <p className="flex flex-wrap gap-x-3 text-muted">
                  <span className="font-mono">{formatTime(r.triggeredAt)}</span>
                  <span>{r.trigger}</span>
                  <span className="font-mono tnum">{r.durationMs.toLocaleString("en-US")}ms</span>
                </p>
                {r.reportTxs.length ? (
                  <div className="flex flex-wrap gap-2">
                    {r.reportTxs.map((tx) => (
                      <TxLink key={tx.hash} tx={tx} showChain />
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-xs tnum">
              <caption className="sr-only">CRE workflow runs, newest first</caption>
              <thead>
                <tr className="border-b border-wire text-subtle">
                  <th scope="col" className="py-2 pl-4 text-left font-medium">Time (UTC)</th>
                  <th scope="col" className="px-3 text-left font-medium">Workflow</th>
                  <th scope="col" className="px-3 text-left font-medium">Trigger</th>
                  <th scope="col" className="px-3 text-right font-medium">Duration</th>
                  <th scope="col" className="px-3 text-left font-medium">Outcome</th>
                  <th scope="col" className="py-2 pr-4 text-left font-medium">Report</th>
                </tr>
              </thead>
              <tbody>
                {ops.creRuns.map((r) => (
                  <tr key={r.runId} className="border-b border-wire/60 transition-colors last:border-0 hover:bg-raised/40">
                    <td className="py-2.5 pl-4 font-mono text-muted">{formatTime(r.triggeredAt)}</td>
                    <td className="px-3 text-fg">
                      {WORKFLOW_LABEL[r.workflow]}
                      <span className="ml-2 font-mono text-subtle">{r.runId.slice(0, 12)}</span>
                    </td>
                    <td className="px-3 text-muted">{r.trigger}</td>
                    <td className="px-3 text-right font-mono text-fg">{r.durationMs.toLocaleString("en-US")}ms</td>
                    <td className={cn("px-3 font-mono font-medium", OUTCOME_STYLE[r.outcome])}>{r.outcome}</td>
                    <td className="py-2.5 pr-4">
                      {r.reportTxs.length ? (
                        <span className="flex flex-wrap gap-2">
                          {r.reportTxs.map((tx) => (
                            <TxLink key={tx.hash} tx={tx} showChain />
                          ))}
                        </span>
                      ) : (
                        <span className="text-subtle">no write</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

function OpsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3" aria-hidden="true">
      <Skeleton className="h-36 rounded-lg xl:col-span-3" />
      <Skeleton className="h-72 rounded-lg" />
      <Skeleton className="h-72 rounded-lg" />
      <Skeleton className="h-72 rounded-lg" />
      <Skeleton className="h-64 rounded-lg xl:col-span-3" />
    </div>
  );
}

export function VerifierOps() {
  const ops = useOps();
  const data = ops.data;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-wire bg-panel/60 px-4 py-4 backdrop-blur sm:px-6">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg border border-wire bg-raised shadow-[inset_0_1px_0_0_rgb(255_255_255/0.05)]">
            <Cpu className="size-4 text-conserved" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.01em]">Verifier Ops</h1>
            <p className="text-xs text-muted">The cells that sign, the Judge that decides, the engine that measures</p>
          </div>
        </div>
        {data ? <Enforcement ops={data} /> : <Skeleton className="h-7 w-64 rounded-full" />}
      </header>
      <div className="space-y-4 p-4 sm:p-6">
        {ops.error ? (
          <Banner
            tone="error"
            action={
              <Button size="sm" variant="ghost" onClick={() => void ops.refetch()}>
                <RefreshCw aria-hidden="true" /> Retry
              </Button>
            }
          >
            Ops telemetry unreachable: {ops.error.message}. Cells keep signing; this view only mirrors them.
          </Banner>
        ) : null}
        {data
          ? data.rpc
              .filter((r) => r.providers.some((p) => !p.healthy))
              .map((r) => (
                <Banner key={r.chain} tone="error">
                  <span className="font-medium">{CHAINS[r.chain].name} RPC:</span> {r.providers.filter((p) => !p.healthy).map((p) => p.name).join(", ")} unhealthy. Judge reads on this chain fail closed with PENDING_ATTESTATION until both providers agree.
                </Banner>
              ))
          : null}
        {!data ? (
          ops.error ? null : <OpsSkeleton />
        ) : (
          <>
            <section aria-label="Judge latency" className="panel p-4" data-testid="ops-latency">
              <div className="mb-3 flex items-center gap-2">
                <Activity className="size-4 text-muted" aria-hidden="true" />
                <h2 className="text-sm font-semibold">Judge latency</h2>
                <span className="text-xs text-muted">POST /v1/evaluate · budget 2,000ms · target p99 under 300ms</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="p50" value={data.judge.samples === 0 ? "n/a" : data.judge.p50Ms.toLocaleString("en-US")} unit={data.judge.samples === 0 ? "" : "ms"} {...(data.judge.samples === 0 ? { hint: "No Judge samples yet" } : {})} />
                <Stat label="p99" value={data.judge.samples === 0 ? "n/a" : data.judge.p99Ms.toLocaleString("en-US")} unit={data.judge.samples === 0 ? "" : "ms"} tone={data.judge.samples === 0 ? "fg" : data.judge.p99Ms < 300 ? "conserved" : "broken"} hint={data.judge.samples === 0 ? "No Judge samples yet" : data.judge.p99Ms < 300 ? "Inside target" : "Over target"} />
                <Stat label="Samples" value={data.judge.samples.toLocaleString("en-US")} hint={`Last ${Math.round(data.windowSeconds / 60)} min`} />
              </div>
            </section>
            <Cells ops={data} />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Verdicts ops={data} />
              <Rpc ops={data} />
            </div>
            <Runs ops={data} />
          </>
        )}
      </div>
    </div>
  );
}
