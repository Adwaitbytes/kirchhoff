"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight, RefreshCw, SearchX } from "lucide-react";
import type { TokenStatus, TokenStatusResponse } from "@/lib/api/types";
import { isApiError } from "@/lib/api/client";
import { useNow, useTokenStatus, useTokenStream } from "@/lib/api/hooks";
import { CHAINS } from "@/lib/chains";
import { blockUrl, readContractUrl, tokenUrl, txRefUrl } from "@/lib/explorer";
import { formatAge, formatAgeWords, formatAmount, parseWei, secondsBetween } from "@/lib/format";
import { STATUS_STYLE, isBreached, hasEpoch, NO_EPOCH_BANNER } from "@/lib/status";
import { SpecProposalAlert } from "@/components/kh/spec-proposal-alert";
import { Banner } from "@/components/kh/banner";
import { EmptyState } from "@/components/kh/panel";
import { StatusWord } from "@/components/kh/status";
import { TestnetBadge } from "@/components/kh/simulation";
import { Verifiable } from "@/components/kh/links";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LogoMark, Wordmark } from "@/components/shell/logo";
import { DeltaReadout } from "@/components/mission/conservation-meter";
import { VerifyOnchainButton } from "@/components/mission/ledger-drawer";
import { CopyButton } from "@/components/integrate/copy-button";
import { cn } from "@/lib/utils";

/** Hero line. PRD microcopy: "kETH adds up across 3 chains. Last checked 12 seconds ago." */
export function heroCopy(status: TokenStatusResponse, ageSeconds: number): string {
  const t = status.token;
  const n = status.chains.length;
  if (!hasEpoch(t)) return `${t.symbol} has no epoch recorded yet. Verdicts ${status.onStale === "fail_closed" ? "fail closed" : "fail open"} until the first one lands.`;
  const checked = `Last checked ${formatAgeWords(ageSeconds)} ago.`;
  if (t.stale) return `${t.symbol} has no fresh reading. ${checked}`;
  switch (t.status) {
    case "CONSERVED":
      return `${t.symbol} adds up across ${n} chains. ${checked}`;
    case "DRIFT":
      return `${t.symbol} adds up across ${n} chains, one soft flag raised. ${checked}`;
    case "BROKEN":
    case "QUARANTINED":
      return `${t.symbol} does not add up. Transfers are refused.`;
    case "RECOVERING":
      return `${t.symbol} is recovering. Transfers resume after the timelock and a clean epoch.`;
    case "UNKNOWN":
      return `${t.symbol} has no fresh reading. ${checked}`;
  }
}

function Header({ token }: { token: string }) {
  return (
    <header className="relative z-10 mx-auto flex w-full max-w-[1120px] items-center gap-3 px-4 pt-5 sm:px-8">
      <Link href="/" className="flex items-center gap-2.5 rounded-lg" aria-label="KIRCHHOFF home">
        <LogoMark className="size-7" />
        <Wordmark className="hidden text-[12px] sm:inline" />
      </Link>
      <TestnetBadge />
      <Link
        href={`/app/tokens/${encodeURIComponent(token)}`}
        className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full border border-wire bg-panel/70 px-3.5 text-sm text-muted shadow-panel backdrop-blur transition-colors hover:border-line-strong hover:text-fg"
      >
        Mission Control
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </Link>
    </header>
  );
}

/** Soft mesh glow in the status color behind the badge. Pure CSS, no assets. */
function Glow({ status }: { status: TokenStatus }) {
  const c = STATUS_STYLE[status].cssVar;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[720px] overflow-hidden">
      <div
        className="absolute left-1/2 top-[-180px] h-[640px] w-[min(1100px,140vw)] -translate-x-1/2 rounded-full opacity-70 blur-3xl transition-[background] duration-700"
        style={{ background: `radial-gradient(closest-side, color-mix(in oklab, ${c} 34%, transparent), transparent 72%)` }}
      />
      <div
        className="absolute left-[12%] top-[60px] h-[360px] w-[420px] rounded-full opacity-50 blur-3xl"
        style={{ background: `radial-gradient(closest-side, color-mix(in oklab, ${c} 18%, transparent), transparent)` }}
      />
      <div
        className="absolute right-[8%] top-[140px] h-[300px] w-[380px] rounded-full opacity-40 blur-3xl"
        style={{ background: "radial-gradient(closest-side, color-mix(in oklab, var(--status-recovering) 14%, transparent), transparent)" }}
      />
      <div className="schematic-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_50%_20%,black,transparent_70%)]" />
    </div>
  );
}

function BigBadge({ status }: { status: TokenStatus }) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return (
    <div
      data-testid="status-badge"
      data-status={status}
      className={cn(
        "relative inline-flex items-center gap-3 rounded-2xl border px-5 py-3 sm:gap-4 sm:px-7 sm:py-4",
        s.border,
        "bg-panel/80 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.06),0_1px_2px_rgb(0_0_0/0.3),0_24px_60px_-24px_var(--glow)] backdrop-blur",
      )}
      style={{ ["--glow" as string]: `color-mix(in oklab, ${s.cssVar} 55%, transparent)` }}
    >
      <span className={cn("relative flex size-10 items-center justify-center rounded-full sm:size-12", s.soft)}>
        {status === "BROKEN" || status === "QUARANTINED" ? (
          <span className={cn("absolute inset-0 rounded-full opacity-40 motion-safe:animate-ping", s.bg)} style={{ animationDuration: "2s" }} aria-hidden="true" />
        ) : (
          <span className={cn("absolute inset-1 rounded-full opacity-30", s.bg)} style={{ animation: "junction-breathe 4.8s ease-in-out infinite" }} aria-hidden="true" />
        )}
        <Icon className={cn("relative size-5 sm:size-6", s.text)} strokeWidth={2.25} aria-hidden="true" />
      </span>
      <span className={cn("font-display text-xl tracking-[0.04em] sm:text-2xl", s.text)}>{status}</span>
    </div>
  );
}

function SupplyTable({ status }: { status: TokenStatusResponse }) {
  const d = status.token.decimals;
  const sym = status.token.symbol;
  return (
    <section aria-labelledby="supply-title" data-testid="supply-table" className="panel overflow-hidden">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-wire px-4 py-3 sm:px-5">
        <h2 id="supply-title" className="text-sm font-semibold">
          Supply per chain
        </h2>
        <p className="text-xs text-muted">Every figure one click from its onchain read</p>
      </header>
      {/* Cards below sm */}
      <ul className="divide-y divide-wire/70 sm:hidden">
        {status.chains.map((c) => (
          <li key={c.chain} className="space-y-3 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{CHAINS[c.chain].name}</span>
              <StatusWord status={c.ledgerStatus} className="text-xs" />
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <dt className="text-muted">{c.role === "home" ? "Escrow" : "Supply"}</dt>
              <dd className="text-right">
                <Verifiable href={c.role === "home" ? readContractUrl(c.chain, c.contracts.ledger) : tokenUrl(c.chain, c.contracts.token)} label={`${CHAINS[c.chain].name} ${c.role === "home" ? "escrow" : "supply"}`} className="font-mono text-fg">
                  {formatAmount(parseWei(c.role === "home" ? (c.escrow ?? "0") : c.supply), { decimals: d, maxFraction: 0 })}
                </Verifiable>
              </dd>
              <dt className="text-muted">Pinned block</dt>
              <dd className="text-right">
                <Verifiable href={blockUrl(c.chain, c.pinnedBlock.number)} label="Pinned block" className="font-mono text-muted">
                  {Number(c.pinnedBlock.number).toLocaleString("en-US")}
                </Verifiable>
              </dd>
            </dl>
            <div className="flex flex-wrap items-center gap-3">
              <VerifyOnchainButton status={status} chain={c.chain} />
              <a href={readContractUrl(c.chain, c.contracts.ledger)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                Ledger on explorer <ArrowUpRight className="size-3" aria-hidden="true" />
              </a>
            </div>
          </li>
        ))}
      </ul>
      {/* Table from sm */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm tnum">
          <caption className="sr-only">
            {sym} supply per chain at the latest epoch
          </caption>
          <thead>
            <tr className="border-b border-wire text-xs text-subtle">
              <th scope="col" className="py-2.5 pl-5 pr-3 text-left font-medium">Chain</th>
              <th scope="col" className="px-3 text-right font-medium">Supply</th>
              <th scope="col" className="px-3 text-right font-medium">Escrow</th>
              <th scope="col" className="hidden px-3 text-right font-medium md:table-cell">Pinned block</th>
              <th scope="col" className="px-3 text-right font-medium">Ledger</th>
              <th scope="col" className="py-2.5 pl-3 pr-5 text-right font-medium">
                <span className="sr-only">Verify</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {status.chains.map((c) => (
              <tr key={c.chain} className="border-b border-wire/70 last:border-0 transition-colors hover:bg-raised/40">
                <th scope="row" className="py-3 pl-5 pr-3 text-left font-normal">
                  <span className="font-medium text-fg">{CHAINS[c.chain].name}</span>
                  <span className="ml-2 text-xs text-subtle">{c.role}</span>
                </th>
                <td className="px-3 text-right">
                  <Verifiable href={tokenUrl(c.chain, c.contracts.token)} label={`${CHAINS[c.chain].name} supply`} className="font-mono text-fg">
                    {formatAmount(parseWei(c.supply), { decimals: d, maxFraction: 0 })}
                  </Verifiable>
                </td>
                <td className="px-3 text-right">
                  {c.escrow === null ? (
                    <span className="text-subtle">n/a</span>
                  ) : (
                    <Verifiable href={readContractUrl(c.chain, c.contracts.ledger)} label="Escrow, ledger read" className="font-mono text-fg">
                      {formatAmount(parseWei(c.escrow), { decimals: d, maxFraction: 0 })}
                    </Verifiable>
                  )}
                </td>
                <td className="hidden px-3 text-right md:table-cell">
                  <Verifiable href={blockUrl(c.chain, c.pinnedBlock.number)} label="Pinned block" className="font-mono text-xs text-muted">
                    {Number(c.pinnedBlock.number).toLocaleString("en-US")}
                  </Verifiable>
                </td>
                <td className="px-3 text-right">
                  <StatusWord status={c.ledgerStatus} className="text-xs" />
                </td>
                <td className="py-3 pl-3 pr-5">
                  <div className="flex justify-end">
                    <VerifyOnchainButton status={status} chain={c.chain} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EmbedBadge({ token }: { token: string }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const badge = `${origin}/t/${encodeURIComponent(token)}/badge.svg`;
  const page = `${origin}/t/${encodeURIComponent(token)}`;
  const html = `<a href="${page}"><img src="${badge}" alt="${token} conservation status by KIRCHHOFF" height="22"></a>`;
  const md = `[![${token} conservation status](${badge})](${page})`;
  return (
    <section aria-labelledby="embed-title" className="panel p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="embed-title" className="text-sm font-semibold">
            Embed the live badge
          </h2>
          <p className="mt-0.5 text-xs text-muted">Same reading as this page, refreshed every 30s</p>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- live SVG from our own route, must show exactly what embedders get */}
        <img src={`/t/${encodeURIComponent(token)}/badge.svg`} alt={`${token} conservation status badge`} height={22} className="h-[22px] w-auto" />
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {(
          [
            ["HTML", html],
            ["Markdown", md],
          ] as const
        ).map(([label, code]) => (
          <div key={label} className="min-w-0 rounded-lg border border-wire bg-inset">
            <div className="flex items-center justify-between border-b border-wire px-3 py-1.5">
              <span className="text-xs text-muted">{label}</span>
              <CopyButton value={code} label={`${label} badge snippet`} />
            </div>
            <pre tabIndex={0} className="overflow-x-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-muted">
              <code>{origin ? code : "Loading snippet"}</code>
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}

function Hero({ status }: { status: TokenStatusResponse }) {
  const now = useNow();
  const t = status.token;
  const age = now === 0 ? 0 : secondsBetween(t.updatedAt, now);
  const shown: TokenStatus = t.stale && (t.status === "CONSERVED" || t.status === "DRIFT") ? "UNKNOWN" : t.status;
  const epochTx = status.epoch?.reportTxs[0];
  const breached = isBreached(t.status);
  return (
    <section className="flex flex-col items-center gap-7 pb-4 pt-10 text-center sm:pt-16" aria-labelledby="status-hero-title">
      <BigBadge status={shown} />
      <h1 id="status-hero-title" data-testid="status-hero" className="max-w-[26ch] text-balance text-xl font-medium leading-[1.2] tracking-[-0.02em] sm:text-[28px]" aria-live="polite">
        {heroCopy(status, age)}
      </h1>
      <div className="flex max-w-full justify-center overflow-hidden">
        {hasEpoch(t) ? (
          <DeltaReadout delta={parseWei(t.delta)} decimals={t.decimals} symbol={t.symbol} href={readContractUrl(status.ledger.chain, status.ledger.address)} size="large" />
        ) : (
          <p className="font-mono text-lg text-unknown-text">Δ awaits the first epoch</p>
        )}
      </div>
      <dl className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted">
        <div className="flex items-center gap-1.5">
          <dt>Last epoch</dt>
          <dd className="font-mono text-fg tnum">
            {!hasEpoch(t) ? (
              <span className="font-sans text-unknown-text">No epoch yet</span>
            ) : epochTx ? (
              <Verifiable href={txRefUrl(epochTx)} label="Latest epoch report transaction">
                {formatAge(age)} ago
              </Verifiable>
            ) : (
              `${formatAge(age)} ago`
            )}
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>Epoch</dt>
          <dd className="font-mono text-fg tnum">{status.epoch && hasEpoch(t) ? Number(status.epoch.epochId).toLocaleString("en-US") : "none"}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>Stale policy</dt>
          <dd className="text-fg">{status.onStale === "fail_closed" ? "fail closed" : "fail open"}</dd>
        </div>
      </dl>
      {breached && t.activeIncidentId ? (
        <Button asChild variant="danger">
          <Link href={`/app/incidents/${t.activeIncidentId}`}>
            Read the incident <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      ) : null}
    </section>
  );
}

function HeroSkeleton() {
  return (
    <div className="flex flex-col items-center gap-7 pb-4 pt-10 sm:pt-16" aria-hidden="true">
      <Skeleton className="h-16 w-64 rounded-2xl" />
      <Skeleton className="h-9 w-[min(520px,90%)]" />
      <Skeleton className="h-9 w-[min(360px,80%)]" />
      <Skeleton className="h-[56px] w-48" />
      <Skeleton className="h-4 w-72" />
    </div>
  );
}

export function StatusPage({ token }: { token: string }) {
  const q = useTokenStatus(token);
  useTokenStream(token);
  const data = q.data;
  const now = useNow();
  const notFound = isApiError(q.error) && q.error.code === "NOT_FOUND";
  const breached = data ? isBreached(data.token.status) : false;
  const glowStatus: TokenStatus = data ? (data.token.stale ? "UNKNOWN" : data.token.status) : "UNKNOWN";

  return (
    <div className={cn("relative isolate min-h-dvh overflow-x-clip", breached && "shadow-[inset_0_0_0_2px_var(--status-broken)]")}>
      <Glow status={glowStatus} />
      <Header token={token} />
      <main id="main" className="relative mx-auto w-full max-w-[1120px] px-4 pb-16 sm:px-8">
        {notFound ? (
          <EmptyState
            icon={<SearchX className="size-6" />}
            title={`${token} is not on the circuit. No protected token by that name.`}
            action={
              <Button asChild variant="secondary">
                <Link href="/">Back to KIRCHHOFF</Link>
              </Button>
            }
          />
        ) : (
          <>
            <div className="mt-6 space-y-3">
              {q.error && !notFound ? (
                <Banner
                  tone="error"
                  action={
                    <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>
                      <RefreshCw aria-hidden="true" /> Retry
                    </Button>
                  }
                >
                  Status mirror unreachable: {q.error.message}. The onchain feed still answers; verify below or on the explorer.
                </Banner>
              ) : null}
              {data?.chains.map((c) =>
                c.read.ok ? null : (
                  <Banner key={c.chain} tone="error">
                    <span className="font-medium">{CHAINS[c.chain].name} RPC error:</span> {c.read.error}. The other chains stay live.
                  </Banner>
                ),
              )}
              {data && !hasEpoch(data.token) ? (
                <Banner tone="stale">
                  <span data-testid="no-epoch-banner">
                    {NO_EPOCH_BANNER} ({data.onStale === "fail_closed" ? "fail closed" : "fail open"}).
                  </span>
                </Banner>
              ) : data?.token.stale ? (
                <Banner tone="stale">
                  Last epoch {formatAge(now === 0 ? 0 : secondsBetween(data.token.updatedAt, now))} ago. Verdicts follow the token&apos;s stale policy.
                </Banner>
              ) : null}
              {data ? <SpecProposalAlert token={data.token.symbol} /> : null}
            </div>
            {data ? <Hero status={data} /> : <HeroSkeleton />}
            <div className="mt-10 space-y-5">
              {data ? (
                <SupplyTable status={data} />
              ) : (
                <div className="panel space-y-3 p-5" aria-hidden="true">
                  {Array.from({ length: 4 }, (_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              )}
              <EmbedBadge token={token} />
              <p className="text-center text-xs text-subtle">
                Mirror of onchain state. Source: ConservationLedger on {data ? CHAINS[data.ledger.chain].name : "the home chain"}, block{" "}
                {data ? (
                  <Verifiable href={blockUrl(data.block.chain, data.block.number)} label="Block the mirror read" className="font-mono">
                    {Number(data.block.number).toLocaleString("en-US")}
                  </Verifiable>
                ) : (
                  "pending"
                )}
                .
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
