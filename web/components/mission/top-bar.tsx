"use client";

import Link from "next/link";
import { DropdownMenu as M } from "radix-ui";
import { Bell, BellOff, Check, ChevronsUpDown, Sparkles } from "lucide-react";
import type { StreamConnectionState } from "@/lib/api/client";
import type { TokenStatusResponse } from "@/lib/api/types";
import { useNow, useTokens } from "@/lib/api/hooks";
import { formatAge, formatAmount, parseWei, secondsBetween } from "@/lib/format";
import { readContractUrl, txRefUrl } from "@/lib/explorer";
import { usePrefs } from "@/lib/prefs";
import { STATUS_STYLE } from "@/lib/status";
import { TestnetBadge } from "@/components/kh/simulation";
import { IncidentReplayButton } from "@/components/mission/incident-replay";
import { Verifiable } from "@/components/kh/links";
import { Tooltip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function TokenSwitcher({ current, basePath }: { current: string; basePath: string }) {
  const tokens = useTokens();
  return (
    <M.Root>
      <M.Trigger className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-base font-semibold tracking-[-0.01em] text-fg hover:bg-raised" aria-label={`Token: ${current}. Switch token`}>
        {current}
        <ChevronsUpDown className="size-3.5 text-subtle" aria-hidden="true" />
      </M.Trigger>
      <M.Portal>
        <M.Content align="start" sideOffset={6} className="z-50 min-w-56 rounded-lg border border-wire bg-panel p-1 shadow-pop">
          <M.Label className="px-2.5 pb-1 pt-1.5 text-xs text-subtle">Protected tokens</M.Label>
          {(tokens.data?.items ?? []).map((t) => {
            const s = STATUS_STYLE[t.status];
            return (
              <M.Item key={t.symbol} asChild>
                <Link href={`${basePath}/${t.symbol}`} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-raised">
                  <span className={cn("size-1.5 rounded-full", s.bg)} aria-hidden="true" />
                  <span className="font-medium text-fg">{t.symbol}</span>
                  <span className={cn("text-xs", s.text)}>{t.status}</span>
                  {t.symbol === current ? <Check className="ml-auto size-3.5 text-muted" aria-hidden="true" /> : null}
                </Link>
              </M.Item>
            );
          })}
          <M.Separator className="my-1 h-px bg-wire" />
          <M.Item asChild>
            <Link href="/app/onboard" className="flex cursor-pointer rounded-md px-2.5 py-2 text-sm text-muted outline-none data-[highlighted]:bg-raised data-[highlighted]:text-fg">
              Onboard a token
            </Link>
          </M.Item>
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

/** "CONSERVED · Δ 0 kETH" (PRD section 12, top bar). */
export function StatusPill({ status }: { status: TokenStatusResponse }) {
  const t = status.token;
  const s = STATUS_STYLE[t.status];
  const Icon = s.icon;
  const delta = parseWei(t.delta);
  return (
    <Verifiable href={readContractUrl(status.ledger.chain, status.ledger.address)} label={`${t.status}, Δ ${formatAmount(delta, { decimals: t.decimals })} ${t.symbol}. Read the ledger onchain.`}>
      <span data-testid="status-pill" data-status={t.status} className={cn("inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm font-semibold transition-colors duration-300", s.border, s.soft, s.text)}>
        <Icon className="size-4" strokeWidth={2.25} aria-hidden="true" />
        <span className="tracking-[0.02em]">{t.status}</span>
        <span className="opacity-60" aria-hidden="true">
          ·
        </span>
        <span className="font-mono font-medium tnum">
          Δ {formatAmount(delta, { decimals: t.decimals, maxFraction: 0, signed: true })} {t.symbol}
        </span>
      </span>
    </Verifiable>
  );
}

function StalenessTimer({ status }: { status: TokenStatusResponse }) {
  const now = useNow();
  const age = now === 0 ? 0 : secondsBetween(status.token.updatedAt, now);
  const limit = status.stalenessSeconds;
  const frac = Math.min(1, age / limit);
  const stale = status.token.stale || age > limit;
  const r = 7;
  const circ = 2 * Math.PI * r;
  return (
    <Tooltip content={`Staleness window ${limit}s. Policy when stale: ${status.onStale === "fail_closed" ? "fail closed" : "fail open"}.`}>
      <span className="flex items-center gap-2 text-sm" data-testid="staleness">
        <svg viewBox="0 0 18 18" className="size-[18px] -rotate-90" aria-hidden="true">
          <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line-wire)" strokeWidth="2" />
          <circle cx="9" cy="9" r={r} fill="none" stroke={stale ? "var(--status-unknown)" : frac > 0.75 ? "var(--status-drift)" : "var(--status-conserved)"} strokeWidth="2" strokeDasharray={circ} strokeDashoffset={circ * (1 - frac)} strokeLinecap="round" style={{ transition: "stroke-dashoffset 1s linear" }} />
        </svg>
        <span className={cn("tnum", stale ? "text-unknown-text" : "text-muted")}>
          <span className="font-mono text-fg">{formatAge(age)}</span> ago
        </span>
      </span>
    </Tooltip>
  );
}

function ConnectionDot({ state }: { state: StreamConnectionState }) {
  const label = state === "live" ? "Live" : state === "offline" ? "Offline" : "Connecting";
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted" role="status">
      <span className={cn("relative size-2 rounded-full", state === "live" ? "bg-conserved" : state === "offline" ? "bg-broken" : "bg-drift")} aria-hidden="true">
        {state === "live" ? <span className="absolute inset-0 rounded-full bg-conserved opacity-60 motion-safe:animate-ping" style={{ animationDuration: "2.4s" }} /> : null}
      </span>
      {label}
    </span>
  );
}

export function MissionTopBar({ token, status, stream }: { token: string; status: TokenStatusResponse | undefined; stream: StreamConnectionState }) {
  const { sound, setSound } = usePrefs();
  const epochTx = status?.epoch?.reportTxs[0];
  return (
    <header className="surface-glass sticky top-0 z-30 flex min-h-14 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-wire px-3 py-2 sm:px-4">
      <div className="flex items-center gap-2">
        <TokenSwitcher current={token} basePath="/app/tokens" />
        <TestnetBadge />
      </div>
      <div className="hidden h-5 w-px bg-wire sm:block" aria-hidden="true" />
      {status ? (
        <div className="order-last flex w-full flex-wrap items-center gap-x-4 gap-y-2 sm:order-none sm:w-auto">
          <StatusPill status={status} />
          <span className="hidden text-sm text-muted sm:inline">
            Epoch{" "}
            {epochTx ? (
              <Verifiable href={txRefUrl(epochTx)} label={`Epoch ${status.epoch?.epochId} report transaction`} className="font-mono text-fg">
                {Number(status.epoch?.epochId).toLocaleString("en-US")}
              </Verifiable>
            ) : (
              <span className="font-mono text-subtle">none</span>
            )}
          </span>
          <StalenessTimer status={status} />
        </div>
      ) : (
        <div className="order-last flex w-full min-w-0 items-center gap-4 sm:order-none sm:w-auto" aria-hidden="true">
          <Skeleton className="h-8 w-44 rounded-full sm:w-56" />
          <Skeleton className="hidden h-4 w-24 sm:block" />
          <Skeleton className="hidden h-4 w-20 sm:block" />
        </div>
      )}
      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        <span className="hidden sm:inline-flex">
          <ConnectionDot state={stream} />
        </span>
        {status ? <IncidentReplayButton token={token} activeIncidentId={status.token.activeIncidentId} decimals={status.token.decimals} /> : null}
        <Tooltip content={sound ? "Breach alert sound on" : "Breach alert sound off"}>
          <button
            type="button"
            data-dev-control=""
            onClick={() => setSound(!sound)}
            aria-pressed={sound}
            aria-label="Breach alert sound"
            className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"
          >
            {sound ? <Bell className="size-4" /> : <BellOff className="size-4" />}
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("kh:ask"))}
          aria-label="Ask KIRCHHOFF"
          className="group flex h-8 cursor-pointer items-center gap-2 rounded-md border border-wire bg-raised px-2 text-sm text-muted shadow-[inset_0_1px_0_0_var(--panel-highlight)] transition-[border-color,color,box-shadow] hover:border-[color-mix(in_oklab,var(--status-conserved)_50%,var(--line-wire))] hover:text-fg hover:shadow-[0_0_0_3px_color-mix(in_oklab,var(--status-conserved)_12%,transparent)] sm:pl-2.5 sm:pr-1.5"
        >
          <Sparkles className="size-3.5 text-conserved transition-transform group-hover:rotate-12" aria-hidden="true" />
          <span className="hidden sm:inline">Ask KIRCHHOFF</span>
          <kbd className="hidden rounded border border-wire bg-panel px-1.5 py-px font-mono text-2xs text-subtle sm:inline">⌘K</kbd>
        </button>
      </div>
    </header>
  );
}
