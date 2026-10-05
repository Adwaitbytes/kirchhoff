"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, History, Pause, Play, RotateCcw } from "lucide-react";
import type { Bytes32, EvidenceItem, EvidenceKind, IncidentResponse, TokenStatus } from "@/lib/api/types";
import { useEpochs24h, useIncident } from "@/lib/api/hooks";
import { CHAINS } from "@/lib/chains";
import { ccipMessageUrl, shortHash, txRefUrl } from "@/lib/explorer";
import { formatAmount, parseWei } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Banner } from "@/components/kh/banner";
import { StatusWord } from "@/components/kh/status";
import { Verifiable } from "@/components/kh/links";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<EvidenceKind, string> = {
  offending_credit: "Forged credit lands",
  debit_search: "Junction search",
  breach_report: "BROKEN written",
  quarantine_tx: "Quarantine applied",
  refused_message: "Transfer refused",
  guard_revert: "Guard holds",
  epoch_report: "Loop confirms",
};

const SPEEDS = [1, 4, 16] as const;

/** Status the circuit showed at a point in the replay, derived only from recorded evidence. */
function statusAt(reached: EvidenceItem[]): TokenStatus {
  if (reached.some((e) => e.kind === "quarantine_tx")) return "QUARANTINED";
  if (reached.some((e) => e.kind === "breach_report")) return "BROKEN";
  return "CONSERVED";
}

function ReplayPlayer({ r, decimals }: { r: IncidentResponse; decimals: number }) {
  const { reducedMotion } = usePrefs();
  const items = useMemo(() => [...r.evidence].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), [r.evidence]);
  const t0 = Date.parse(items[0]?.at ?? r.incident.offendingBlockAt);
  const end = Math.max(1, Date.parse(items[items.length - 1]?.at ?? r.incident.brokenAt) - t0);
  const [t, setT] = useState(reducedMotion ? end : 0);
  const [playing, setPlaying] = useState(!reducedMotion);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) {
      last.current = null;
      return;
    }
    let raf = 0;
    const step = (now: number) => {
      const dt = last.current === null ? 0 : now - last.current;
      last.current = now;
      setT((prev) => {
        const next = prev + dt * speed;
        if (next >= end) {
          setPlaying(false);
          return end;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, end]);

  const reached = items.filter((e) => Date.parse(e.at) - t0 <= t);
  const status = statusAt(reached);
  const broken = reached.some((e) => e.kind === "breach_report");
  const delta = parseWei(broken ? r.incident.deltaAfter : r.incident.deltaBefore);
  const restart = useCallback(() => {
    setT(0);
    setPlaying(true);
  }, []);

  return (
    <div className="space-y-5 px-5 py-5" data-testid="incident-replay">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-wire bg-inset px-4 py-3">
          <p className="text-xs text-muted">Circuit at this moment</p>
          <StatusWord status={status} className="mt-1.5 text-base" />
        </div>
        <div className="rounded-lg border border-wire bg-inset px-4 py-3">
          <p className="text-xs text-muted">Δ recorded</p>
          <p className={cn("mt-1 font-mono text-xl font-medium tnum", delta < 0n ? "text-broken" : "text-fg")}>
            {formatAmount(delta, { decimals, maxFraction: 0, signed: true })} <span className="font-sans text-sm text-muted">{r.incident.token}</span>
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Button size="icon-sm" variant="secondary" onClick={() => (t >= end ? restart() : setPlaying((p) => !p))} aria-label={playing ? "Pause replay" : "Play replay"} data-testid="replay-play">
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={restart} aria-label="Restart replay">
            <RotateCcw aria-hidden="true" />
          </Button>
          <div className="ml-1 inline-flex rounded-md border border-wire bg-inset p-0.5" role="group" aria-label="Replay speed">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                aria-pressed={speed === s}
                className={cn("cursor-pointer rounded-[5px] px-2 py-0.5 font-mono text-xs", speed === s ? "bg-raised text-fg" : "text-muted hover:text-fg")}
              >
                {s}×
              </button>
            ))}
          </div>
          <span className="ml-auto font-mono text-xs text-muted tnum">
            +{(t / 1000).toFixed(1)}s / {(end / 1000).toFixed(1)}s
          </span>
        </div>
        <label className="sr-only" htmlFor="replay-scrub">
          Replay position
        </label>
        <input
          id="replay-scrub"
          type="range"
          min={0}
          max={end}
          step={100}
          value={Math.round(t)}
          onChange={(e) => {
            setPlaying(false);
            setT(Number(e.target.value));
          }}
          className="w-full cursor-pointer accent-[var(--status-broken)]"
        />
      </div>

      <ol className="relative space-y-1" aria-live="polite">
        {items.map((e) => {
          const at = Date.parse(e.at) - t0;
          const on = at <= t;
          const latest = on && reached[reached.length - 1]?.id === e.id;
          return (
            <li
              key={e.id}
              className={cn(
                "grid grid-cols-[52px_1fr] gap-3 rounded-md px-2.5 py-2 transition-[opacity,background-color] duration-300",
                on ? "opacity-100" : "opacity-35",
                latest && "bg-raised shadow-[inset_2px_0_0_0_var(--status-broken)]",
              )}
            >
              <span className="pt-0.5 font-mono text-xs text-subtle tnum">+{(at / 1000).toFixed(1)}s</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">
                  {KIND_LABEL[e.kind]} <span className="font-normal text-muted">· {CHAINS[e.chain].short}</span>
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{e.label}</p>
                <p className="mt-1 flex flex-wrap gap-x-3 font-mono text-2xs text-subtle">
                  {e.tx ? (
                    <Verifiable href={txRefUrl(e.tx)} label={`Transaction for ${e.id}`}>
                      {shortHash(e.tx.hash)}
                    </Verifiable>
                  ) : null}
                  {e.blocks ? (
                    <span>
                      blocks {e.blocks.from} to {e.blocks.to} · {e.blocks.matches} matches
                    </span>
                  ) : null}
                  {e.messageId && e.kind === "refused_message" ? (
                    <Verifiable href={ccipMessageUrl(e.messageId)} label="CCIP message">
                      msg {shortHash(e.messageId)}
                    </Verifiable>
                  ) : null}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {reducedMotion ? null : <span className="sr-only">Replay plays recorded evidence in order; nothing is re-executed.</span>}
    </div>
  );
}

/** The last incident id: newest epoch carrying one, else the token's active incident. */
export function useLastIncidentId(token: string, activeIncidentId: Bytes32 | null): Bytes32 | null {
  const epochs = useEpochs24h(token);
  const fromEpochs = epochs.data?.items.find((e) => e.incidentId)?.incidentId ?? null;
  return fromEpochs ?? activeIncidentId;
}

function ReplayBody({ id, decimals }: { id: Bytes32; decimals: number }) {
  const q = useIncident(id);
  if (q.error) return <div className="p-5"><Banner tone="error">Incident {shortHash(id)} unavailable: {q.error.message}</Banner></div>;
  if (!q.data) {
    return (
      <div className="space-y-3 p-5" aria-busy="true">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-8 w-2/3" />
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  return <ReplayPlayer r={q.data} decimals={decimals} />;
}

/**
 * "Replay last incident" (PRD section 15 submission checklist): a read-only timeline that plays
 * the recorded evidence of the most recent incident. Nothing is re-executed and nothing is written.
 */
export function IncidentReplayButton({ token, activeIncidentId, decimals }: { token: string; activeIncidentId: Bytes32 | null; decimals: number }) {
  const id = useLastIncidentId(token, activeIncidentId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" disabled={!id} onClick={() => setOpen(true)} title={id ? undefined : "No incident recorded yet"} data-testid="replay-last-incident" aria-label="Replay last incident">
        <History aria-hidden="true" />
        {/* Sized by the top bar (an @container): beside the Attack Lab the bar is too narrow for the label. */}
        <span className="hidden @min-[1500px]:inline">Replay last incident</span>
      </Button>
      <Sheet open={open && id !== null} onOpenChange={setOpen}>
        {id ? (
          <SheetContent title="Replay last incident" description={`Read-only playback of incident ${shortHash(id)} from recorded onchain evidence`}>
            <ReplayBody id={id} decimals={decimals} />
            <div className="border-t border-wire px-5 py-4">
              <Button asChild variant="outline" size="sm">
                <Link href={`/app/incidents/${id}`}>
                  Open Incident Room <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </SheetContent>
        ) : null}
      </Sheet>
    </>
  );
}

