"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Lock, OctagonX, X } from "lucide-react";
import type { TokenStatusResponse } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import { formatAmount, parseWei } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { isBreached } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const FRESH_MS = 10_000;

/** One-line breach cause, built from mirrored onchain facts only (PRD section 12 microcopy). */
export function breachCause(status: TokenStatusResponse): string {
  const t = status.token;
  const frozen = status.chains.some((c) => c.frozen);
  const tail = frozen ? "CCIP lanes frozen." : "Quarantine in progress.";
  const forged = status.lanes.flatMap((l) => (l.offending ? l.recentTransfers : [])).find((x) => x.state === "forged");
  if (forged) {
    return `Forged credit on ${CHAINS[forged.dstChain].name}: ${formatAmount(parseWei(forged.amount), { decimals: t.decimals, maxFraction: 0 })} ${t.symbol} released with no matching burn. ${tail}`;
  }
  const deficit = parseWei(t.delta);
  if (deficit < 0n) return `Loop Rule deficit: claims exceed backing by ${formatAmount(-deficit, { decimals: t.decimals, maxFraction: 0 })} ${t.symbol}. ${tail}`;
  return `${t.symbol} is ${t.status} (${t.reason}). ${tail}`;
}

function incidentKey(status: TokenStatusResponse): string {
  return status.token.activeIncidentId ?? `${status.token.symbol}:${status.token.epochId}`;
}

/** When each incident was first seen in this tab, shared by the alert and the sound. */
const firstSeen = new Map<string, number>();

function playAlert(): void {
  try {
    const ctx = new AudioContext();
    const tone = (freq: number, at: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.28);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.3);
    };
    tone(880, 0);
    tone(660, 0.32);
    window.setTimeout(() => void ctx.close(), 1000);
  } catch (e) {
    console.warn("Breach alert sound unavailable", e);
  }
}

/**
 * Breach chrome (PRD section 12): 2px red app frame, tab title "BROKEN · kETH" and an optional
 * alert sound, off by default.
 */
export function BreachEffects({ status }: { status: TokenStatusResponse | undefined }) {
  const { sound } = usePrefs();
  const played = useRef<Set<string>>(new Set());
  const breached = status ? isBreached(status.token.status) : false;
  const symbol = status?.token.symbol;
  const key = status && breached ? incidentKey(status) : null;

  useEffect(() => {
    if (!symbol) return;
    const original = document.title;
    const root = document.documentElement;
    const broken = `BROKEN · ${symbol}`;
    if (breached) {
      document.title = broken;
      root.setAttribute("data-breach", "1");
    }
    return () => {
      // Restore only our own title; after a route change the new page owns document.title.
      if (document.title === broken) document.title = original;
      root.removeAttribute("data-breach");
    };
  }, [breached, symbol]);

  useEffect(() => {
    if (!key || played.current.has(key)) return;
    played.current.add(key);
    if (sound) playAlert();
  }, [key, sound]);

  if (!breached) return null;
  return <div aria-hidden="true" data-testid="breach-frame" className="pointer-events-none fixed inset-0 z-[70] border-2 border-broken" style={{ animation: "fade-in 200ms ease-out" }} />;
}

/**
 * The breach toast, docked in the banner row instead of floating, so on stage it can never cover
 * the ledger, the verdicts or the meter. For its first 10 seconds it announces assertively and
 * carries the one-line cause; then it settles into the standing breach banner.
 */
export function BreachToast({ status }: { status: TokenStatusResponse }) {
  const { reducedMotion } = usePrefs();
  const key = incidentKey(status);
  const [fresh, setFresh] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    const seen = firstSeen.get(key) ?? Date.now();
    firstSeen.set(key, seen);
    const left = FRESH_MS - (Date.now() - seen);
    if (left <= 0) {
      setFresh(false);
      return;
    }
    setFresh(true);
    const t = window.setTimeout(() => setFresh(false), left);
    return () => window.clearTimeout(t);
  }, [key]);

  const quarantined = status.token.status === "QUARANTINED";
  const loud = fresh && dismissed !== key;
  const Icon = quarantined ? Lock : OctagonX;
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid={loud ? "breach-toast" : "breach-banner"}
      className={cn(
        "relative flex flex-wrap items-center gap-x-4 gap-y-2 overflow-hidden rounded-lg border px-3.5 py-2.5 text-sm transition-[border-color,background-color,box-shadow] duration-500",
        quarantined ? "border-quarantined/45 bg-quarantined/10" : "border-broken/50 bg-broken/10",
        loud && "border-broken/70 bg-broken/15 shadow-[0_0_0_4px_color-mix(in_oklab,var(--status-broken)_14%,transparent),0_16px_40px_-20px_var(--status-broken)]",
      )}
      style={loud && !reducedMotion ? { animation: "rise-in 320ms cubic-bezier(0.25,1,0.5,1)" } : undefined}
    >
      {loud && !reducedMotion ? (
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--status-broken)_22%,transparent),transparent)]" style={{ animation: "sweep 1.6s cubic-bezier(0.45,0,0.55,1) 2" }} />
      ) : null}
      <Icon className={cn("size-4 shrink-0", loud || !quarantined ? "text-broken" : "text-quarantined")} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">{breachCause(status)}</p>
        <p className="text-xs text-muted">
          {status.token.symbol} is {status.token.status} ({status.token.reason}) · every CCIP transfer refused until the issuer resolves
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {status.token.activeIncidentId ? (
          <Button asChild size="sm" variant="danger">
            <Link href={`/app/incidents/${status.token.activeIncidentId}`}>
              Open Incident Room <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
        {loud ? (
          <button type="button" onClick={() => setDismissed(key)} aria-label="Quiet this alert" className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg">
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
