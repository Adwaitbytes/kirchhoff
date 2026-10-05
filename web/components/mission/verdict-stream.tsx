"use client";

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRight, Inbox } from "lucide-react";
import type { Verdict } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import { ccipMessageUrl, shortHash, txRefUrl } from "@/lib/explorer";
import { formatAmount, formatTime, parseWei } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { DecisionWord } from "@/components/kh/status";
import { EmptyState } from "@/components/kh/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const ROW_H = 60;
const FAIL_ROW_H = 82;

/** PRD microcopy: "Refused · TOKEN_BROKEN · attacker transfer to Base Sepolia". */
export function refusedCopy(v: Verdict): string {
  return `Refused · ${v.reason} · ${v.note}`;
}

function announce(v: Verdict, decimals: number, symbol: string): string {
  const amount = `${formatAmount(parseWei(v.amount), { decimals })} ${symbol}`;
  const lane = `${CHAINS[v.srcChain].name} to ${CHAINS[v.dstChain].name}`;
  return v.decision === "PASS" ? `PASS. ${amount}, ${lane}.` : `FAIL. ${refusedCopy(v)}. ${amount}.`;
}

function Row({ v, decimals, symbol, fresh }: { v: Verdict; decimals: number; symbol: string; fresh: boolean }) {
  const fail = v.decision === "FAIL";
  const agreeing = v.cells.filter((c) => c.decision === v.decision).length;
  const p50 = v.cells.length ? [...v.cells].sort((a, b) => a.latencyMs - b.latencyMs)[Math.floor(v.cells.length / 2)]?.latencyMs : null;
  return (
    <div
      data-testid="verdict-row"
      data-decision={v.decision}
      className={cn(
        "grid h-full grid-cols-[5.5em_minmax(0,1fr)_auto] items-center gap-3 border-b border-wire/70 px-4",
        "transition-colors hover:bg-raised/60",
        fail && "bg-[linear-gradient(90deg,color-mix(in_oklab,var(--status-broken)_14%,transparent),transparent_70%)] shadow-[inset_2px_0_0_0_var(--status-broken)] hover:bg-broken/10",
      )}
      style={fresh ? { animation: `rise-in 360ms cubic-bezier(0.25,1,0.5,1)${fail ? "" : ""}` } : undefined}
    >
      <time dateTime={v.evaluatedAt} className="font-mono text-xs text-subtle tnum">
        {formatTime(v.evaluatedAt)}
      </time>
      <div className="min-w-0">
        {fail ? (
          <p className="line-clamp-2 text-sm font-medium leading-snug text-broken">{refusedCopy(v)}</p>
        ) : (
          <p className="flex min-w-0 items-center gap-1.5 truncate text-sm text-fg">
            {CHAINS[v.srcChain].name}
            <ArrowRight className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
            {CHAINS[v.dstChain].name}
          </p>
        )}
        <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">
          <a href={txRefUrl(v.sourceTx)} target="_blank" rel="noopener noreferrer" className="font-mono text-fg/90 tnum hover:underline" title="Source debit transaction">
            {formatAmount(parseWei(v.amount), { decimals })} {symbol}
          </a>
          <span className="text-subtle">·</span>
          {fail ? (
            <span className="truncate">
              {CHAINS[v.srcChain].short} to {CHAINS[v.dstChain].short}, never executed
            </span>
          ) : (
            <span className="truncate">
              <span className="font-mono">{v.reason}</span> · {agreeing} of {v.cells.length} cells{p50 !== null && p50 !== undefined ? ` · ${p50}ms` : ""}
            </span>
          )}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <DecisionWord decision={v.decision} />
        <a
          href={ccipMessageUrl(v.messageId)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-2xs text-subtle tnum hover:text-fg hover:underline"
          aria-label={`CCIP message ${v.messageId} on the CCIP explorer`}
        >
          {shortHash(v.messageId, 6, 4)}
        </a>
      </div>
    </div>
  );
}

export function VerdictStream({ verdicts, decimals, symbol }: { verdicts: Verdict[]; decimals: number; symbol: string }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const { reducedMotion } = usePrefs();

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(verdicts.map((v) => v.id));
      return;
    }
    const added = verdicts.filter((v) => !seen.current!.has(v.id));
    if (added.length === 0) return;
    added.forEach((v) => seen.current!.add(v.id));
    if (!reducedMotion) setFresh(new Set(added.map((v) => v.id)));
    const fail = added.find((v) => v.decision === "FAIL");
    if (fail) setAssertive(announce(fail, decimals, symbol));
    else if (added[0]) setPolite(announce(added[0], decimals, symbol));
    parentRef.current?.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }, [verdicts, decimals, symbol, reducedMotion]);

  const virtualizer = useVirtualizer({ count: verdicts.length, getScrollElement: () => parentRef.current, estimateSize: (i) => (verdicts[i]?.decision === "FAIL" ? FAIL_ROW_H : ROW_H), overscan: 8, getItemKey: (i) => verdicts[i]?.id ?? i });

  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
      {verdicts.length === 0 ? (
        <EmptyState icon={<Inbox className="size-5" />} title="No verdicts yet. The first CCIP transfer of this token will appear here." />
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label="Verdict stream, newest first" tabIndex={0}>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const v = verdicts[item.index];
              if (!v) return null;
              return (
                <div key={item.key} role="listitem" style={{ position: "absolute", top: 0, left: 0, right: 0, height: item.size, transform: `translateY(${item.start}px)` }}>
                  <Row v={v} decimals={decimals} symbol={symbol} fresh={fresh.has(v.id)} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

export function VerdictStreamSkeleton() {
  return (
    <div className="flex-1 overflow-hidden" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="grid h-[60px] grid-cols-[5.5em_1fr_auto] items-center gap-3 border-b border-wire/70 px-4">
          <Skeleton className="h-3 w-14" />
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Skeleton className="h-3.5 w-10" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}
