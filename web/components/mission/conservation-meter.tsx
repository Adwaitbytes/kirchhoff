"use client";

import { useEffect, useRef, useState } from "react";
import { animate } from "motion/react";
import type { TokenStatusResponse } from "@/lib/api/types";
import { formatAmount, parseWei } from "@/lib/format";
import { escrowBalanceUrl, readContractUrl } from "@/lib/explorer";
import { useDuration } from "@/lib/prefs";
import { Verifiable } from "@/components/kh/links";
import { cn } from "@/lib/utils";
import { DeltaGlyph } from "@/components/kh/delta-glyph";
import { hasEpoch } from "@/lib/status";

const COUNT_MS = 800;

/**
 * The Δ readout. On a change it counts to the new value over 800ms (PRD motion rules); under
 * reduced motion it jumps. The animated frames are display only: the resting value is the exact
 * bigint from the ledger, and the link goes to the ledger read that proves it.
 */
export function DeltaReadout({ delta, decimals, symbol, href, size = "hero" }: { delta: bigint; decimals: number; symbol: string; href: string; size?: "hero" | "large" }) {
  const dur = useDuration();
  const [shown, setShown] = useState<string>(() => formatAmount(delta, { decimals, maxFraction: 0, signed: true }));
  // Reserve the widest of the old and new value so the count never shifts the layout.
  const [reserve, setReserve] = useState<number>(() => formatAmount(delta, { decimals, maxFraction: 0, signed: true }).length);
  const prev = useRef(delta);

  useEffect(() => {
    const from = prev.current;
    prev.current = delta;
    const exact = formatAmount(delta, { decimals, maxFraction: 0, signed: true });
    setReserve(Math.max(exact.length, formatAmount(from, { decimals, maxFraction: 0, signed: true }).length));
    const ms = dur(COUNT_MS);
    if (from === delta || ms === 0) {
      setShown(exact);
      return;
    }
    const unit = 10n ** BigInt(decimals);
    const a = Number(from / unit);
    const b = Number(delta / unit);
    const controls = animate(a, b, {
      duration: ms / 1000,
      ease: [0.25, 1, 0.5, 1],
      onUpdate: (v) => setShown(formatAmount(BigInt(Math.round(v)) * unit, { decimals, maxFraction: 0, signed: true })),
      onComplete: () => setShown(exact),
    });
    return () => controls.stop();
  }, [delta, decimals, dur]);

  const negative = delta < 0n;
  return (
    <div className="flex items-baseline gap-3">
      <span className={cn("font-mono font-light text-subtle", size === "hero" ? "text-2xl" : "text-xl")} aria-hidden="true">
        <DeltaGlyph />
      </span>
      <Verifiable href={href} label={`Δ ${shown} ${symbol}, read ConservationLedger.statusOf onchain`} className="min-w-0">
        <span
          data-testid="delta-readout"
          style={{ minWidth: `${reserve}ch`, display: "inline-block" }}
          className={cn(
            "font-num transition-colors duration-300",
            size === "hero" ? "text-3xl" : "text-2xl",
            negative ? "text-broken" : "text-fg",
          )}
        >
          {shown}
        </span>
      </Verifiable>
      <span className={cn("font-medium text-muted", size === "hero" ? "text-lg" : "text-base")}>{symbol}</span>
    </div>
  );
}

function Bar({ label, value, scale, backing, kind, decimals, symbol, href }: { label: string; value: bigint; scale: bigint; backing: bigint; kind: "backing" | "claims"; decimals: number; symbol: string; href: string }) {
  const pct = (v: bigint) => (scale === 0n ? 0 : Number((v * 10_000n) / scale) / 100);
  const within = kind === "claims" && value > backing ? backing : value;
  const overflow = kind === "claims" && value > backing ? value - backing : 0n;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-muted">{label}</span>
        <Verifiable href={href} label={`${label}: ${formatAmount(value, { decimals })} ${symbol}`} className="font-mono text-sm text-fg">
          {formatAmount(value, { decimals, maxFraction: 0 })}
        </Verifiable>
      </div>
      <div className="relative h-3 overflow-visible rounded-[3px] bg-inset" role="presentation">
        <div
          className={cn("absolute inset-y-0 left-0 rounded-[3px] transition-[width] duration-700 ease-out", kind === "backing" ? "bg-conserved/80" : "bg-[color-mix(in_oklab,var(--status-conserved)_45%,var(--line-strong))]")}
          style={{ width: `${pct(within)}%` }}
        />
        {overflow > 0n ? (
          <div
            data-testid="claims-overflow"
            className="absolute inset-y-[-2px] rounded-r-[3px] bg-broken transition-[width] duration-700 ease-out"
            style={{
              left: `${pct(backing)}%`,
              width: `${pct(overflow)}%`,
              backgroundImage: "repeating-linear-gradient(135deg, transparent 0 4px, rgb(0 0 0 / 0.18) 4px 7px)",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Backing and Claims on the same scale; Claims overflows in red on breach (PRD section 12). */
export function ConservationMeter({ status }: { status: TokenStatusResponse }) {
  const { token } = status;
  const backing = parseWei(status.backing);
  const claims = parseWei(status.claims.total);
  const delta = parseWei(token.delta);
  const scale = backing > claims ? backing : claims;
  const home = status.chains.find((c) => c.role === "home");
  const ledgerHref = readContractUrl(status.ledger.chain, status.ledger.address);
  const escrowHref = home?.contracts.escrow ? escrowBalanceUrl(home.chain, home.contracts.token, home.contracts.escrow) : ledgerHref;
  const markerPct = scale === 0n ? 0 : Number((backing * 10_000n) / scale) / 100;
  const surplus = parseWei(status.unclaimedSurplus);
  return (
    <div className="flex flex-col gap-4 px-4 pb-4 pt-3">
      <div className="relative flex flex-col gap-3">
        <Bar label="Backing" value={backing} scale={scale} backing={backing} kind="backing" decimals={token.decimals} symbol={token.symbol} href={escrowHref} />
        <Bar label="Claims" value={claims} scale={scale} backing={backing} kind="claims" decimals={token.decimals} symbol={token.symbol} href={ledgerHref} />
        <div aria-hidden="true" className="pointer-events-none absolute bottom-0 top-5 w-px bg-fg/50 transition-[left] duration-700" style={{ left: `${markerPct}%` }} />
      </div>
      {hasEpoch(token) ? (
        <DeltaReadout delta={delta} decimals={token.decimals} symbol={token.symbol} href={ledgerHref} />
      ) : (
        <p className="flex h-[72px] items-center font-mono text-xl text-unknown-text" data-testid="delta-pending">
          Δ awaits the first epoch
        </p>
      )}
      <p className="text-xs text-muted">
        {delta < 0n && claims <= backing
          ? "Δ is the last value recorded onchain. Live backing covers claims again; transfers resume after the timelock and a clean epoch."
          : delta < 0n
          ? "Claims exceed backing. Value was created with no matching debit."
          : surplus > 0n
            ? `Backing exceeds claims by ${formatAmount(surplus, { decimals: token.decimals })} ${token.symbol}: unclaimed surplus (escrow donation).`
            : "Backing covers remote supply plus everything in flight."}
      </p>
    </div>
  );
}
