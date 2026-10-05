"use client";

import { ArrowRight, CircleCheck, Loader, OctagonX, RotateCcw, TriangleAlert } from "lucide-react";
import type { BacktestResponse } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import { blockUrl, shortHash } from "@/lib/explorer";
import { formatAmount, parseWei } from "@/lib/format";
import { Banner } from "@/components/kh/banner";
import { TxLink, Verifiable } from "@/components/kh/links";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-wire bg-inset px-4 py-3 shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]">
      <p className="text-xs text-subtle">{label}</p>
      <p className="mt-1 font-mono text-xl font-medium text-fg tnum">{value}</p>
    </div>
  );
}

export function StepBacktest({ result, pending, error, onRun }: { result: BacktestResponse | undefined; pending: boolean; error: string | null; onRun: () => void }) {
  if (error) {
    return (
      <Banner
        tone="error"
        action={
          <Button size="sm" variant="ghost" onClick={onRun}>
            <RotateCcw aria-hidden="true" /> Retry
          </Button>
        }
      >
        Backtest failed: {error}
      </Banner>
    );
  }
  if (pending || !result) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Replaying history">
        <p className="text-sm text-muted">Replaying every debit and credit through the engine. Same code as the Judge and the CRE workflows.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[74px] rounded-xl" />
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }
  const blocked = !result.ok || result.breaches.length > 0;
  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={onRun}>
          <RotateCcw aria-hidden="true" /> Replay again
        </Button>
      </div>
      {blocked ? (
        <Banner tone="breach">
          <span className="font-medium">Activation blocked.</span> {result.breaches.length} BROKEN on real history. Fix the spec or the bridge before proposing.
        </Banner>
      ) : (
        <div className="flex items-center gap-3 rounded-xl border border-conserved/40 bg-conserved/5 px-4 py-3 shadow-[0_0_32px_-12px_var(--status-conserved)]">
          <CircleCheck className="size-5 shrink-0 text-conserved" aria-hidden="true" />
          <p className="text-sm text-fg">
            <span className="font-semibold">History conserves.</span> <span className="text-muted">Zero breaches across every chain in range.</span>
          </p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Events replayed" value={result.eventsReplayed.toLocaleString("en-US")} />
        <Stat label="Breaches" value={String(result.breaches.length)} />
        <Stat label="Replay time" value={`${(result.durationMs / 1000).toFixed(2)}s`} />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {result.coverage.map((c) => {
          const unmatched = Math.max(0, c.credits - c.matched);
          const pct = c.credits === 0 ? 100 : Math.round((c.matched / c.credits) * 1000) / 10;
          return (
            <section key={c.chain} aria-label={`${CHAINS[c.chain].name} coverage`} className="rounded-xl border border-wire bg-panel p-4 shadow-panel">
              <h4 className="text-sm font-semibold text-fg">{CHAINS[c.chain].name}</h4>
              <p className="mt-0.5 text-xs text-subtle">
                Blocks{" "}
                <Verifiable href={blockUrl(c.chain, c.fromBlock)} label={`From block ${c.fromBlock}`} className="font-mono">
                  {Number(c.fromBlock).toLocaleString("en-US")}
                </Verifiable>{" "}
                to{" "}
                <Verifiable href={blockUrl(c.chain, c.toBlock)} label={`To block ${c.toBlock}`} className="font-mono">
                  {Number(c.toBlock).toLocaleString("en-US")}
                </Verifiable>
              </p>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                {(
                  [
                    ["Debits", c.debits],
                    ["Credits", c.credits],
                    ["Matched", c.matched],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-inset py-2">
                    <dt className="text-2xs text-subtle">{k}</dt>
                    <dd className="font-mono text-base text-fg tnum">{v.toLocaleString("en-US")}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-inset" role="img" aria-label={`${pct}% of credits matched to a debit`}>
                <div className={cn("h-full rounded-full", unmatched ? "bg-drift" : "bg-conserved")} style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-muted">{unmatched ? `${unmatched} credits still in their match window` : "Every credit has its debit"}</p>
            </section>
          );
        })}
      </div>
      {result.breaches.length > 0 ? (
        <section className="rounded-xl border border-broken/40 bg-broken/5 p-4">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-broken">
            <OctagonX className="size-4" aria-hidden="true" /> Breaches
          </h4>
          <ul className="mt-2 space-y-2 text-sm">
            {result.breaches.map((b, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-xs text-broken">{b.reason}</span>
                <span className="font-mono text-fg tnum">{formatAmount(parseWei(b.amount), { decimals: 18 })}</span>
                <span className="text-muted">{b.note}</span>
                <TxLink tx={b.tx} showChain />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {result.driftEvents.length > 0 ? (
        <section className="rounded-xl border border-drift/40 bg-drift/5 p-4">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-drift">
            <TriangleAlert className="size-4" aria-hidden="true" /> Drift events
          </h4>
          <ul className="mt-2 space-y-2 text-sm">
            {result.driftEvents.map((d, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-xs text-drift">{d.reason}</span>
                <span className="text-muted">{d.note}</span>
                <TxLink tx={d.tx} showChain />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="font-mono text-xs text-subtle">spec {shortHash(result.specHash, 10, 8)}</p>
    </div>
  );
}

/** Inline result of the automatic backtest, shown in the review step. */
export function AutoBacktestSummary({
  result,
  pending,
  error,
  waitingOn,
  onOpen,
}: {
  result: BacktestResponse | undefined;
  pending: boolean;
  error: string | null;
  /** Why the backtest has not run yet, e.g. red lines still present. */
  waitingOn: string | null;
  onOpen: () => void;
}) {
  const blocked = result ? !result.ok || result.breaches.length > 0 : false;
  const tone = error || blocked ? "border-broken/45 bg-broken/5" : result ? "border-conserved/40 bg-conserved/5" : "border-wire bg-panel";
  return (
    <section data-testid="auto-backtest" aria-live="polite" aria-labelledby="auto-backtest-title" className={cn("flex flex-col gap-3 rounded-xl border p-4 shadow-panel sm:flex-row sm:items-center", tone)}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-wire bg-inset" aria-hidden="true">
        {pending ? (
          <Loader className="size-4 text-muted motion-safe:animate-spin" />
        ) : error || blocked ? (
          <OctagonX className="size-4 text-broken" />
        ) : result ? (
          <CircleCheck className="size-4 text-conserved" />
        ) : (
          <RotateCcw className="size-4 text-subtle" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <h3 id="auto-backtest-title" className="text-sm font-medium text-fg">
          Automatic backtest
        </h3>
        <p className={cn("text-sm", error || blocked ? "text-broken" : "text-muted")}>
          {pending
            ? "Replaying real history through the engine"
            : error
              ? `Backtest failed: ${error}`
              : result
                ? blocked
                  ? `Blocked: ${result.breaches.length} BROKEN on real history`
                  : `History conserves: ${result.eventsReplayed.toLocaleString("en-US")} events, zero breaches`
                : (waitingOn ?? "Runs as soon as every line carries evidence")}
        </p>
      </div>
      {result || error ? (
        <Button size="sm" variant="outline" onClick={onOpen}>
          Full backtest <ArrowRight aria-hidden="true" />
        </Button>
      ) : null}
    </section>
  );
}
