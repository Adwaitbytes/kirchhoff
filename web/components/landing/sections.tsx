"use client";

import Link from "next/link";
import { ArrowRight, Check, Lock, ShieldCheck, X } from "lucide-react";
import type { ChainSupply, TokenStatusResponse } from "@/lib/api/types";
import { useNow, useTokenStatus } from "@/lib/api/hooks";
import { CHAINS } from "@/lib/chains";
import { blockUrl, escrowBalanceUrl, readContractUrl, tokenUrl } from "@/lib/explorer";
import { formatAge, formatAmount, parseWei, secondsBetween } from "@/lib/format";
import { STATUS_STYLE, hasEpoch } from "@/lib/status";
import { StatusWord } from "@/components/kh/status";
import { Verifiable } from "@/components/kh/links";
import { SimulationLabel } from "@/components/kh/simulation";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------------------------
 * Junction Rule: a real transfer flows; a forged credit searches for its debit and is stopped.
 * -------------------------------------------------------------------------------------------- */

export function JunctionVisual() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(56px,1.2fr)_minmax(0,1fr)] items-center gap-2 rounded-xl border border-wire bg-inset p-3">
        <span className="truncate rounded-md border border-wire bg-panel px-2 py-1.5 text-center font-mono text-2xs text-fg">
          Burn<span className="block text-subtle sm:ml-1 sm:inline">Arbitrum</span>
        </span>
        <span className="relative h-[2px] rounded-full bg-[color-mix(in_oklab,var(--status-conserved)_35%,var(--line-wire))]">
          <span className="absolute inset-0 rounded-full bg-[repeating-linear-gradient(90deg,var(--status-conserved)_0_6px,transparent_6px_18px)] opacity-60 motion-safe:animate-[dash-flow_1.2s_linear_infinite]" />
          <span className="absolute -top-[4px] size-2.5 rounded-full bg-conserved shadow-[0_0_12px_var(--status-conserved)] motion-safe:animate-[travel_2.4s_cubic-bezier(0.45,0,0.55,1)_infinite]" />
        </span>
        <span className="flex items-center justify-center gap-1 truncate rounded-md border border-conserved/50 bg-panel px-2 py-1.5 font-mono text-2xs text-conserved motion-safe:animate-[ok-glow_2.4s_ease-in-out_infinite]">
          <Check className="size-3 shrink-0" strokeWidth={3} />
          <span className="truncate">
            Mint<span className="block sm:ml-1 sm:inline">Base</span>
          </span>
        </span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(56px,1.2fr)_minmax(0,1fr)] items-center gap-2 rounded-xl border border-broken/35 bg-broken/[0.05] p-3">
        <span className="truncate rounded-md border border-dashed border-broken/50 px-2 py-1.5 text-center font-mono text-2xs text-broken/80">
          no debit<span className="block opacity-0 sm:hidden">.</span>
        </span>
        <span className="relative h-[2px] rounded-full bg-broken/30">
          <span className="absolute -top-[4px] right-0 size-2.5 rounded-full bg-broken shadow-[0_0_12px_var(--status-broken)] motion-safe:animate-[search-back_3.2s_cubic-bezier(0.22,1,0.36,1)_infinite]" />
          <span className="absolute left-1/2 top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-broken text-on-status shadow-[0_0_0_4px_color-mix(in_oklab,var(--status-broken)_20%,transparent)] motion-safe:animate-[stop-pop_3.2s_cubic-bezier(0.34,1.56,0.64,1)_infinite]">
            <X className="size-3.5" strokeWidth={3} />
          </span>
        </span>
        <span className="truncate rounded-md border border-broken/60 bg-panel px-2 py-1.5 text-center font-mono text-2xs text-broken">
          Release<span className="block sm:ml-1 sm:inline">Sepolia</span>
        </span>
      </div>
      <p className="pt-1 font-mono text-2xs text-broken">DEBIT_NOT_FOUND · BROKEN on every ledger, same run</p>
    </div>
  );
}

/* ----------------------------------------------------------------------------------------------
 * Loop Rule: claims swell past backing, the readout flips, then the circuit settles.
 * -------------------------------------------------------------------------------------------- */

export function LoopVisual() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="rounded-xl border border-wire bg-inset p-3">
        <div className="mb-1.5 flex justify-between text-xs text-muted">
          <span>Backing</span>
          <span className="font-mono text-2xs">escrow on the home chain</span>
        </div>
        <div className="relative h-3 rounded-[3px] bg-panel">
          <div className="absolute inset-y-0 left-0 w-[64%] rounded-[3px] bg-conserved/80 shadow-[0_0_14px_-2px_var(--status-conserved)]" />
          <div className="absolute -bottom-1 -top-1 left-[64%] w-px bg-fg/60" />
        </div>
        <div className="mb-1.5 mt-3 flex justify-between text-xs text-muted">
          <span>Claims</span>
          <span className="font-mono text-2xs">remote supply + in flight</span>
        </div>
        <div className="relative h-3 rounded-[3px] bg-panel">
          <div className="absolute inset-y-0 left-0 w-[64%] rounded-[3px] bg-[color-mix(in_oklab,var(--status-conserved)_45%,var(--line-strong))]" />
          <div
            className="absolute inset-y-[-2px] left-[64%] w-0 rounded-r-[3px] bg-broken opacity-0 motion-safe:animate-[overflow-swell_6s_cubic-bezier(0.65,0,0.35,1)_infinite]"
            style={{ backgroundImage: "repeating-linear-gradient(135deg, transparent 0 4px, rgb(0 0 0 / 0.2) 4px 7px)" }}
          />
          <div className="absolute -bottom-1 -top-1 left-[64%] w-px bg-fg/60" />
        </div>
        <div className="relative mt-4 h-10 whitespace-nowrap font-mono text-[clamp(26px,6vw,40px)] font-medium leading-10 tracking-[-0.03em] tnum">
          <span className="absolute inset-0 text-fg motion-safe:animate-[readout-calm_6s_linear_infinite]">Δ 0</span>
          <span className="absolute inset-0 text-broken opacity-0 motion-safe:animate-[readout-break_6s_linear_infinite]">Δ −116,500</span>
        </div>
      </div>
      <p className="pt-1 font-mono text-2xs text-muted">
        Δ = E<sub>H</sub> − (ΣS<sub>i</sub> + F<sub>out</sub> + F<sub>in</sub>) · BROKEN when Δ &lt; −τ
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------------------------------------
 * Kelp Replay strip: the forged pulse runs in, the circuit breaks, contains and refuses.
 * -------------------------------------------------------------------------------------------- */

const STATIONS = [
  { label: "Forge", tone: "broken" },
  { label: "Detect", tone: "drift" },
  { label: "Break", tone: "broken" },
  { label: "Contain", tone: "quarantined" },
  { label: "Refuse", tone: "conserved" },
] as const;

export function ReplayStrip() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-wire bg-[linear-gradient(180deg,var(--panel-top),var(--bg-panel))] px-4 pb-6 pt-10 shadow-[inset_0_1px_0_0_var(--panel-highlight),var(--shadow-panel)] sm:px-10" aria-hidden="true">
      <div className="absolute inset-0 schematic-grid opacity-60" />
      <div className="relative">
        <div className="relative mx-[10%] h-[3px] rounded-full bg-wire">
          {/* Forged current running in from the left. */}
          <div className="absolute inset-y-0 left-0 w-0 rounded-full bg-[linear-gradient(90deg,transparent,var(--status-broken))] shadow-[0_0_14px_var(--status-broken)] motion-safe:animate-[strip-forge_10s_cubic-bezier(0.45,0,0.55,1)_infinite]" />
          {/* Containment: the rest of the wire turns violet and dashed. */}
          <div className="absolute inset-y-0 left-1/2 right-0 origin-left scale-x-0 bg-[repeating-linear-gradient(90deg,var(--status-quarantined)_0_8px,transparent_8px_14px)] motion-safe:animate-[strip-contain_10s_linear_infinite]" />
          {/* The escape attempt from the right, refused at the barrier. */}
          <div className="absolute -top-[5px] right-0 size-3.5 rounded-full bg-broken opacity-0 shadow-[0_0_14px_var(--status-broken)] motion-safe:animate-[strip-escape_10s_cubic-bezier(0.22,1,0.36,1)_infinite]" />
          <div className="absolute -top-[13px] left-[87.5%] h-7 w-[3px] rounded-full bg-conserved opacity-0 shadow-[0_0_14px_var(--status-conserved)] motion-safe:animate-[strip-barrier_10s_linear_infinite]" />
          {STATIONS.map((s, i) => (
            <span
              key={s.label}
              className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-line-strong bg-panel"
              style={{ left: `${i * 25}%` }}
            >
              <span
                className={cn(
                  "absolute -inset-[2px] rounded-full opacity-0 motion-safe:animate-[station-on_10s_linear_infinite]",
                  s.tone === "broken" && "bg-broken shadow-[0_0_12px_var(--status-broken)]",
                  s.tone === "drift" && "bg-drift shadow-[0_0_12px_var(--status-drift)]",
                  s.tone === "quarantined" && "bg-quarantined shadow-[0_0_12px_var(--status-quarantined)]",
                  s.tone === "conserved" && "bg-conserved shadow-[0_0_12px_var(--status-conserved)]",
                )}
                style={{ animationDelay: `${[0, 1.6, 3, 4.2, 7][i] ?? 0}s` }}
              />
            </span>
          ))}
        </div>
        <div className="relative mx-[10%] mt-5 h-5">
          {STATIONS.map((s, i) => (
            <span key={s.label} className="absolute -translate-x-1/2 whitespace-nowrap font-mono text-2xs text-muted sm:text-xs" style={{ left: `${i * 25}%` }}>
              {s.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------------------------
 * Inside CCIP: the architecture as a live circuit.
 * -------------------------------------------------------------------------------------------- */

function Wire({ d, tone = "conserved", speed = 1.4, delay = 0 }: { d: string; tone?: "conserved" | "broken" | "muted"; speed?: number; delay?: number }) {
  const color = tone === "broken" ? "var(--status-broken)" : tone === "muted" ? "var(--line-strong)" : "var(--status-conserved)";
  return (
    <g>
      <path d={d} fill="none" stroke="var(--line-strong)" strokeWidth={1.5} />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray="2 16"
        className="motion-safe:animate-[wire-flow-svg_var(--s)_linear_infinite]"
        style={{ ["--s" as string]: `${speed}s`, animationDelay: `${delay}s`, filter: `drop-shadow(0 0 3px ${color})` }}
      />
    </g>
  );
}

function Box({ x, y, w, h, title, sub, accent = false }: { x: number; y: number; w: number; h: number; title: string; sub?: string; accent?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} fill="var(--bg-panel)" stroke={accent ? "color-mix(in oklab, var(--status-conserved) 55%, var(--line-strong))" : "var(--line-wire)"} strokeWidth={accent ? 1.5 : 1} />
      <text x={x + 14} y={y + 24} fill="var(--fg)" fontSize={14} fontWeight={600} fontFamily="var(--font-inter)">
        {title}
      </text>
      {sub ? (
        <text x={x + 14} y={y + 43} fill="var(--fg-muted)" fontSize={11.5} fontFamily="var(--font-dm-mono)">
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Tag({ x, y, children, tone = "muted" }: { x: number; y: number; children: string; tone?: "muted" | "broken" | "conserved" }) {
  const fill = tone === "broken" ? "var(--status-broken)" : tone === "conserved" ? "var(--status-conserved)" : "var(--fg-subtle)";
  return (
    <text x={x} y={y} fill={fill} fontSize={11} fontFamily="var(--font-dm-mono)" textAnchor="middle">
      {children}
    </text>
  );
}

export function ArchitectureDiagram() {
  const chains = ["Ethereum Sepolia", "Arbitrum Sepolia", "Base Sepolia"];
  return (
    <figure className="overflow-hidden rounded-2xl border border-wire bg-inset shadow-pop">
      <figcaption className="flex items-center justify-between gap-3 border-b border-wire px-4 py-3 text-xs text-muted">
        <span className="font-mono">kirchhoff · live circuit</span>
        <span className="hidden sm:inline">Current flows left to right · red is refused</span>
      </figcaption>
      <div className="relative">
        <div className="absolute inset-0 schematic-grid opacity-50" aria-hidden="true" />
        {/* Wide schematic */}
        <svg viewBox="0 0 1100 470" className="relative hidden w-full md:block" role="img" aria-label="Architecture: three chains read by the CRE Conservation Engine, which writes signed reports to the ConservationLedger on every chain. CCIP messages need both the Committee Verifier and the KIRCHHOFF CCV cells to sign; the cells' Judge reads the ledger and refuses when the token is broken.">
          {chains.map((c, i) => (
            <Box key={c} x={30} y={40 + i * 92} w={210} h={64} title={c} sub={i === 0 ? "home · escrow" : "remote · supply"} />
          ))}
          {chains.map((_, i) => (
            <Wire key={i} d={`M240 ${72 + i * 92} H300 V176 H340`} delay={i * 0.25} />
          ))}
          <Tag x={292} y={30}>DON consensus reads</Tag>
          <Box x={340} y={120} w={250} h={112} title="CRE Conservation Engine" sub="W1 Junction · W2 Loop" accent />
          <text x={354} y={208} fill="var(--fg-muted)" fontSize={11.5} fontFamily="var(--font-dm-mono)">
            W3 Responder · W4 Topology
          </text>
          <Wire d="M465 232 V300" speed={1.1} />
          <Tag x={530} y={272}>signed reports</Tag>
          <Box x={340} y={300} w={250} h={64} title="ConservationLedger" sub="+ Feed on every chain" accent />
          <Wire d="M590 332 H660" speed={1.6} />
          <Tag x={625} y={322}>statusOf()</Tag>
          <Box x={660} y={300} w={200} h={64} title="CCV cells × 4" sub="Judge · POST /v1/evaluate" accent />
          <Box x={660} y={60} w={200} h={64} title="CCIP 2.0 message" sub="lockOrBurn on source" />
          <Box x={660} y={180} w={200} h={64} title="Committee Verifier" sub="Chainlink signs" />
          <Wire d="M760 124 V180" speed={1.2} />
          <Wire d="M860 92 H900 V316 H860" speed={1.8} delay={0.4} />
          <Wire d="M860 212 H940" speed={1.2} />
          <Wire d="M860 348 H1010 V244" speed={1.2} tone="broken" />
          <Box x={940} y={180} w={140} h={64} title="Executor" sub="both must sign" />
          <Tag x={1010} y={378} tone="broken">FAIL TOKEN_BROKEN</Tag>
          <Tag x={1010} y={394} tone="broken">never executes</Tag>
          <Box x={340} y={400} w={520} h={50} title="DemoLendingMarket · KirchhoffGuard" sub="" />
          <text x={354} y={442} fill="var(--fg-muted)" fontSize={11.5} fontFamily="var(--font-dm-mono)">
            read the feed · borrow() reverts CollateralBroken()
          </text>
          <Wire d="M465 364 V400" speed={1.6} tone="muted" />
        </svg>
        {/* Portrait schematic */}
        <svg viewBox="0 0 360 700" className="relative w-full md:hidden" role="img" aria-label="Architecture: chains, CRE Conservation Engine, ConservationLedger, CCV cells and Committee Verifier, then the Executor, which needs both signatures.">
          <Box x={20} y={20} w={320} h={60} title="3 chains" sub="Sepolia · Arbitrum · Base" />
          <Wire d="M180 80 V120" />
          <Tag x={262} y={104}>DON consensus reads</Tag>
          <Box x={20} y={120} w={320} h={64} title="CRE Conservation Engine" sub="W1 · W2 · W3 · W4" accent />
          <Wire d="M180 184 V224" speed={1.1} />
          <Tag x={250} y={208}>signed reports</Tag>
          <Box x={20} y={224} w={320} h={60} title="ConservationLedger + Feed" sub="every chain" accent />
          <Wire d="M180 284 V324" speed={1.6} />
          <Tag x={234} y={308}>statusOf()</Tag>
          <Box x={20} y={324} w={320} h={60} title="CCV cells × 4" sub="Judge · PASS or FAIL" accent />
          <Box x={20} y={424} w={320} h={60} title="Committee Verifier" sub="Chainlink signs" />
          <Wire d="M180 384 V424" speed={1.2} tone="broken" />
          <Tag x={262} y={408} tone="broken">FAIL when broken</Tag>
          <Wire d="M180 484 V524" speed={1.2} />
          <Box x={20} y={524} w={320} h={60} title="Executor" sub="both must sign" />
          <Wire d="M180 584 V624" speed={1.6} tone="muted" />
          <Box x={20} y={624} w={320} h={56} title="Lending market · Guard" sub="borrow() reverts" />
        </svg>
      </div>
    </figure>
  );
}

/* ----------------------------------------------------------------------------------------------
 * Live: the real per-chain read model, every number one click from its onchain read.
 * -------------------------------------------------------------------------------------------- */

function ChainCard({ c, status }: { c: ChainSupply; status: TokenStatusResponse }) {
  const t = status.token;
  const s = STATUS_STYLE[c.ledgerStatus];
  return (
    <div className={cn("group relative overflow-hidden rounded-2xl border bg-[linear-gradient(180deg,var(--panel-top),var(--bg-panel))] p-5 shadow-[inset_0_1px_0_0_var(--panel-highlight),var(--shadow-panel)] transition-[border-color,transform] duration-300 hover:-translate-y-0.5", c.read.ok ? "border-wire hover:border-line-strong" : "border-drift/50")}>
      <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-16 size-44 rounded-full opacity-70" style={{ background: `radial-gradient(closest-side, color-mix(in oklab, ${s.cssVar} 18%, transparent), transparent)` }} />
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-fg">{CHAINS[c.chain].name}</span>
        <StatusWord status={c.ledgerStatus} className="text-xs" />
      </div>
      <p className="mt-5 text-xs text-muted">{c.role === "home" ? "Backing in escrow" : "Supply on chain"}</p>
      <Verifiable href={c.role === "home" && c.contracts.escrow ? escrowBalanceUrl(c.chain, c.contracts.token, c.contracts.escrow) : tokenUrl(c.chain, c.contracts.token)} label={`${CHAINS[c.chain].name} ${c.role === "home" ? "escrow" : "supply"}`} className="mt-1 block font-mono text-xl font-medium text-fg">
        {formatAmount(parseWei(c.role === "home" && c.escrow !== null ? c.escrow : c.supply), { decimals: t.decimals, maxFraction: 0 })}
        <span className="ml-1.5 font-sans text-sm font-normal text-muted">{t.symbol}</span>
      </Verifiable>
      <div className="mt-4 flex items-center justify-between text-xs text-subtle">
        <span>
          pinned{" "}
          <Verifiable href={blockUrl(c.chain, c.pinnedBlock.number)} label="Pinned block" className="font-mono text-muted">
            #{Number(c.pinnedBlock.number).toLocaleString("en-US")}
          </Verifiable>
        </span>
        <span>{c.frozen ? <span className="inline-flex items-center gap-1 text-quarantined"><Lock className="size-3" aria-hidden="true" /> lanes frozen</span> : c.read.ok ? c.confidence : <span className="text-drift">RPC down</span>}</span>
      </div>
    </div>
  );
}

export function LiveCircuit({ token = "kETH" }: { token?: string }) {
  const q = useTokenStatus(token);
  const now = useNow();
  const st = q.data;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <SimulationLabel />
        {st && !hasEpoch(st.token) ? (
          <span className="text-sm text-unknown-text">No epoch yet</span>
        ) : st ? (
          <span className="text-sm text-muted">
            Epoch <span className="font-mono text-fg">{Number(st.token.epochId).toLocaleString("en-US")}</span> · checked{" "}
            <span className="font-mono text-fg">{now === 0 ? "just now" : `${formatAge(secondsBetween(st.token.updatedAt, now))} ago`}</span>
          </span>
        ) : null}
      </div>
      {q.error ? (
        <p className="mt-6 rounded-xl border border-drift/40 bg-drift/10 px-4 py-3 text-sm text-fg">Live read offline. The onchain feed still answers on every chain.</p>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {st
            ? st.chains.map((c) => <ChainCard key={c.chain} c={c} status={st} />)
            : Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[164px] rounded-2xl" />)}
        </div>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        {st ? (
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-lg text-subtle">Δ</span>
            <Verifiable href={readContractUrl(st.ledger.chain, st.ledger.address)} label="Δ, read the ledger onchain" className={cn("font-mono text-xl font-medium tnum", parseWei(st.token.delta) < 0n ? "text-broken" : "text-fg")}>
              {formatAmount(parseWei(st.token.delta), { decimals: st.token.decimals, maxFraction: 0, signed: true })}
            </Verifiable>
            <span className="text-sm text-muted">{st.token.symbol}</span>
          </span>
        ) : (
          <Skeleton className="h-7 w-40" />
        )}
        <Link href={`/t/${token}`} className="group inline-flex items-center gap-1.5 text-sm font-medium text-fg hover:underline">
          Public status page <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </Link>
        <Link href={`/app/tokens/${token}`} className="group inline-flex items-center gap-1.5 text-sm font-medium text-fg hover:underline">
          <ShieldCheck className="size-4 text-conserved" aria-hidden="true" /> Mission Control
        </Link>
      </div>
    </div>
  );
}

