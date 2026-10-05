"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, Position, ReactFlow, useReactFlow, useStore, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { ArrowRight, Lock, Sigma, TriangleAlert } from "lucide-react";
import type { ChainKey, LaneTransfer, TokenStatus, TokenStatusResponse } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import { formatAmount, formatCompact, formatTime, parseWei } from "@/lib/format";
import { shortHash, txRefUrl } from "@/lib/explorer";
import { onTransfer, type TransferEvent } from "@/lib/api/hooks";
import { usePrefs } from "@/lib/prefs";
import { STATUS_STYLE, isBreached } from "@/lib/status";
import { StatusWord } from "@/components/kh/status";
import { cn } from "@/lib/utils";
import { groupLanes, layoutFor, roundedPath, routeWires, type Dims, type Point, type WireGroup } from "@/components/mission/geometry";

/* ----------------------------------------------------------------------------------------------
 * Node and edge data
 * -------------------------------------------------------------------------------------------- */

interface ChainNodeData extends Record<string, unknown> {
  chain: ChainKey;
  role: "home" | "remote";
  supply: bigint;
  symbol: string;
  decimals: number;
  status: TokenStatus;
  frozen: boolean;
  readError: string | null;
  pinnedBlock: string;
  dims: Dims;
  compact: boolean;
  onOpen: (chain: ChainKey) => void;
}

interface EscrowNodeData extends Record<string, unknown> {
  backing: bigint;
  claims: bigint;
  symbol: string;
  decimals: number;
  status: TokenStatus;
  dims: Dims;
  compact: boolean;
  calm: boolean;
  onOpen: () => void;
}

interface FrameNodeData extends Record<string, unknown> {
  dims: Dims;
}

interface Pulse {
  id: string;
  reverse: boolean;
  kind: "settled" | "forged" | "refused";
}

interface WireData extends Record<string, unknown> {
  group: WireGroup;
  points: Point[];
  labelAt: Point;
  label: string;
  pulses: Pulse[];
  durationMs: number;
  reducedMotion: boolean;
  motionScale: number;
  decimals: number;
  hovered: boolean;
  compact: boolean;
  onHover: (id: string | null) => void;
}

type ChainFlowNode = Node<ChainNodeData, "chain">;
type EscrowFlowNode = Node<EscrowNodeData, "escrow">;
type FrameFlowNode = Node<FrameNodeData, "frame">;
type AnyNode = ChainFlowNode | EscrowFlowNode | FrameFlowNode;
type WireEdgeT = Edge<WireData, "wire">;

const hidden = { opacity: 0, pointerEvents: "none" as const };

/* ----------------------------------------------------------------------------------------------
 * Nodes: drawn like IC packages on a schematic, with pin marks where traces attach.
 * -------------------------------------------------------------------------------------------- */

function Pins({ side, count }: { side: "top" | "bottom" | "left" | "right"; count?: number }) {
  const horizontal = side === "top" || side === "bottom";
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute flex justify-around",
        horizontal ? "inset-x-6 h-[5px]" : "inset-y-5 w-[5px] flex-col",
        side === "top" && "-top-[3px]",
        side === "bottom" && "-bottom-[3px]",
        side === "left" && "-left-[3px]",
        side === "right" && "-right-[3px]",
      )}
    >
      {Array.from({ length: count ?? (horizontal ? 7 : 4) }, (_, i) => (
        <span key={i} className={cn("rounded-[1px] bg-line-strong", horizontal ? "h-[5px] w-[3px]" : "h-[3px] w-[5px]")} />
      ))}
    </div>
  );
}

const nodeSurface =
  "bg-[linear-gradient(180deg,var(--panel-top),var(--bg-panel))] shadow-[inset_0_1px_0_0_var(--panel-highlight),0_1px_2px_rgb(0_0_0/0.35),0_16px_32px_-18px_rgb(0_0_0/0.7)]";

const ChainNodeView = memo(function ChainNodeView({ data }: NodeProps<ChainFlowNode>) {
  const meta = CHAINS[data.chain];
  const breached = isBreached(data.status);
  const c = data.compact;
  return (
    <div style={{ width: data.dims.chainW, height: data.dims.chainH }} className="relative">
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
      {!c ? (
        <>
          <Pins side="left" />
          <Pins side="right" />
        </>
      ) : null}
      <Pins side={data.role === "home" ? "top" : "bottom"} count={c ? 5 : 7} />
      <button
        type="button"
        onClick={() => data.onOpen(data.chain)}
        aria-label={`${meta.name}: ${formatAmount(data.supply, { decimals: data.decimals })} ${data.symbol}, ${data.status}. Open ledger`}
        className={cn(
          "nodrag nopan group flex h-full w-full cursor-pointer flex-col rounded-lg border text-left transition-[border-color,box-shadow,transform] duration-200 ease-out hover:-translate-y-px hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
          nodeSurface,
          c ? "px-3 py-2.5" : "px-4 py-3",
          breached ? "border-broken/40" : "border-wire",
          data.readError && "border-drift/60",
        )}
      >
        <span className="flex items-center gap-2">
          <span className={cn("size-1.5 shrink-0 rounded-full", data.readError ? "bg-drift" : STATUS_STYLE[data.status].bg)} aria-hidden="true" />
          <span className={cn("truncate font-semibold text-fg", c ? "text-xs" : "text-sm")}>{c ? meta.short : meta.name}</span>
          {!c ? <span className="ml-auto text-xs text-subtle">{data.role}</span> : null}
          {data.frozen ? <Lock className={cn("size-3.5 shrink-0 text-quarantined", c && "ml-auto")} aria-label="Lanes frozen" /> : null}
        </span>
        <span className={cn("font-mono font-medium leading-none text-fg tnum", c ? "mt-2 text-sm" : "mt-2.5 text-lg")}>
          {formatAmount(data.supply, { decimals: data.decimals, maxFraction: 0 })}
          <span className="ml-1.5 font-sans text-xs font-normal text-muted">{data.symbol}</span>
        </span>
        {!c ? <span className="mt-1 text-xs text-muted">{data.role === "home" ? "Circulating outside escrow" : "Supply on chain"}</span> : null}
        <span className="mt-auto flex items-center gap-2 text-xs">
          {data.readError ? (
            <span className="inline-flex items-center gap-1 font-medium text-drift">
              <TriangleAlert className="size-3.5" aria-hidden="true" />
              RPC down
            </span>
          ) : (
            <StatusWord status={data.status} className={c ? "text-2xs" : "text-xs"} />
          )}
          {!c ? <span className="ml-auto font-mono text-2xs text-subtle tnum">#{Number(data.pinnedBlock).toLocaleString("en-US")}</span> : null}
        </span>
      </button>
    </div>
  );
});

const EscrowNodeView = memo(function EscrowNodeView({ data }: NodeProps<EscrowFlowNode>) {
  const breached = isBreached(data.status);
  const style = STATUS_STYLE[data.status];
  const c = data.compact;
  return (
    <div style={{ width: data.dims.escrowW, height: data.dims.escrowH }} className="relative">
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
      {/* The junction glow: where every current meets. Breathes teal, burns red on breach. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-16 rounded-full"
        style={{
          background: `radial-gradient(closest-side, color-mix(in oklab, ${style.cssVar} ${breached ? 34 : 20}%, transparent), transparent 72%)`,
          animation: data.calm ? undefined : `junction-breathe ${breached ? 1.6 : 4.8}s ease-in-out infinite`,
        }}
      />
      {!c ? (
        <>
          <Pins side="left" />
          <Pins side="right" />
        </>
      ) : (
        <Pins side="top" count={6} />
      )}
      <Pins side="bottom" count={c ? 5 : 7} />
      <button
        type="button"
        onClick={data.onOpen}
        aria-label={`Home escrow on Ethereum Sepolia backing ${formatAmount(data.backing, { decimals: data.decimals })} ${data.symbol}. Open ledger`}
        className={cn(
          "nodrag nopan relative flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-xl border-2 text-left transition-[border-color,box-shadow] duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
          nodeSurface,
          c ? "px-3.5 py-3" : "px-5 py-4",
          breached ? "border-broken shadow-[0_0_0_4px_color-mix(in_oklab,var(--status-broken)_14%,transparent),0_20px_48px_-16px_color-mix(in_oklab,var(--status-broken)_45%,transparent)]" : "border-[color-mix(in_oklab,var(--status-conserved)_38%,var(--line-strong))]",
        )}
      >
        <span className="flex items-center gap-2">
          <span className={cn("flex size-6 items-center justify-center rounded-md", style.soft)}>
            <Sigma className={cn("size-3.5", style.text)} strokeWidth={2.5} aria-hidden="true" />
          </span>
          <span className={cn("font-semibold text-fg", c ? "text-xs" : "text-sm")}>Junction</span>
          <span className="ml-auto text-xs text-subtle">{c ? "escrow" : "Home escrow · Sepolia"}</span>
        </span>
        <span className={cn("font-mono font-medium leading-none text-fg tnum", c ? "mt-2.5 text-base" : "mt-3 text-xl")}>
          {formatAmount(data.backing, { decimals: data.decimals, maxFraction: 0 })}
          <span className="ml-1.5 font-sans text-sm font-normal text-muted">{data.symbol}</span>
        </span>
        <span className="mt-1.5 text-xs text-muted">{c ? "Backing" : "Backing locked in HomeEscrowAdapter"}</span>
        {!c ? (
          <span className="mt-auto flex items-center justify-between text-xs text-subtle">
            <span>Σ in = Σ out</span>
            <span className="font-mono tnum">claims {formatCompact(data.claims, data.decimals)}</span>
          </span>
        ) : null}
      </button>
    </div>
  );
});

/** Invisible node spanning the canvas so fitView frames the whole schematic, bus wires included. */
function FrameNodeView({ data }: NodeProps<FrameFlowNode>) {
  return <div aria-hidden="true" style={{ width: data.dims.canvasW, height: data.dims.canvasH, pointerEvents: "none" }} />;
}

/* ----------------------------------------------------------------------------------------------
 * Wires
 * -------------------------------------------------------------------------------------------- */

function stateLabel(t: LaneTransfer): { text: string; cls: string } {
  switch (t.state) {
    case "settled":
      return { text: "settled", cls: "text-conserved" };
    case "in_flight":
      return { text: "in flight", cls: "text-recovering" };
    case "refused":
      return { text: "refused", cls: "text-broken" };
    case "forged":
      return { text: "forged", cls: "text-broken" };
  }
}

/**
 * SMIL animations inserted after the SVG document started would otherwise resolve against the
 * document timeline and land already finished, so each pulse begins explicitly on mount.
 */
function PulseDot({ pulse, path, durationMs }: { pulse: Pulse; path: string; durationMs: number }) {
  const ref = useRef<SVGGElement>(null);
  useEffect(() => {
    ref.current?.querySelectorAll("animateMotion, animate").forEach((el) => (el as SVGAnimationElement).beginElement());
  }, []);
  const color = pulse.kind === "settled" ? "var(--status-conserved)" : "var(--status-broken)";
  const keyPoints = pulse.kind === "refused" ? (pulse.reverse ? "1;0.5" : "0;0.5") : pulse.reverse ? "1;0" : "0;1";
  const dur = `${durationMs}ms`;
  const motion = <animateMotion begin="indefinite" dur={dur} path={path} keyPoints={keyPoints} keyTimes="0;1" calcMode="linear" fill="freeze" />;
  return (
    <g ref={ref} data-pulse={pulse.kind}>
      <circle r={9} fill={color} opacity={0.18} cx={-1000} cy={-1000}>
        {motion}
        <animate begin="indefinite" attributeName="cx" from="0" to="0" dur={dur} fill="freeze" />
        <animate begin="indefinite" attributeName="cy" from="0" to="0" dur={dur} fill="freeze" />
      </circle>
      <circle r={3} fill={color} cx={-1000} cy={-1000} style={{ filter: `drop-shadow(0 0 4px ${color})` }}>
        {motion}
        <animate begin="indefinite" attributeName="cx" from="0" to="0" dur={dur} fill="freeze" />
        <animate begin="indefinite" attributeName="cy" from="0" to="0" dur={dur} fill="freeze" />
        {pulse.kind === "refused" ? <animate begin="indefinite" attributeName="r" values="3;3;9" keyTimes="0;0.8;1" dur={dur} fill="freeze" /> : null}
      </circle>
      {pulse.kind === "settled" ? null : <animate begin="indefinite" attributeName="opacity" values="1;1;0" keyTimes="0;0.85;1" dur={dur} fill="freeze" />}
    </g>
  );
}

const zoomSelector = (s: { transform: [number, number, number] }) => s.transform[2];

const WireEdge = memo(function WireEdge({ id, data }: EdgeProps<WireEdgeT>) {
  // Chips and their hover cards keep their true size when the schematic is zoomed out to fit,
  // so they stay legible and meet the 24px target size.
  const zoom = useStore(zoomSelector);
  if (!data) return null;
  const chipScale = zoom < 1 ? 1 / zoom : 1;
  const { group, points, pulses, durationMs, reducedMotion, motionScale } = data;
  const path = roundedPath(points, data.compact ? 9 : 12);
  const mid = data.labelAt;
  const offending = group.offending;
  const frozen = group.frozen && !offending;
  const stroke = offending ? "var(--status-broken)" : frozen ? "var(--status-quarantined)" : data.hovered ? "var(--fg-subtle)" : "var(--line-strong)";
  return (
    <>
      {offending ? <path d={path} fill="none" stroke="var(--status-broken)" strokeOpacity={0.3} strokeWidth={12} style={{ filter: "blur(5px)" }} /> : null}
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={22}
        style={{ stroke, strokeWidth: offending ? 2.5 : 2, strokeDasharray: frozen ? "6 6" : undefined, transition: "stroke 300ms ease" }}
      />
      {/* Current: light drifting along live wires. Quiet when conserved, fast and red on the forged wire. */}
      {!reducedMotion && !frozen ? (
        <path
          d={path}
          fill="none"
          stroke={offending ? "var(--status-broken)" : "var(--status-conserved)"}
          strokeOpacity={offending ? 0.9 : 0.4}
          strokeWidth={offending ? 2.5 : 2}
          strokeLinecap="round"
          strokeDasharray={offending ? "3 9" : "1.5 22"}
          style={{ animation: `wire-flow ${(offending ? 0.45 : 1.6) * motionScale}s linear infinite`, pointerEvents: "none" }}
        />
      ) : null}
      {!reducedMotion ? pulses.map((p) => <PulseDot key={p.id} pulse={p} path={path} durationMs={durationMs} />) : null}
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute"
          style={{ transform: `translate(${mid.x}px, ${mid.y}px) scale(${chipScale}) translate(-50%, -50%)`, transformOrigin: "0 0", zIndex: data.hovered ? 30 : 1 }}
          onMouseEnter={() => data.onHover(group.id)}
          onMouseLeave={() => data.onHover(null)}
        >
          <button
            type="button"
            onFocus={() => data.onHover(group.id)}
            onBlur={() => data.onHover(null)}
            onClick={() => data.onHover(data.hovered ? null : group.id)}
            data-testid={`wire-${group.bridge}`}
            aria-expanded={data.hovered}
            aria-label={`${data.label} wire between ${CHAINS[group.a].name} and ${CHAINS[group.b].name}. ${group.transfers.length} recent transfers.${frozen ? " Lanes frozen." : ""}${offending ? " Forged credit on this wire." : ""}`}
            className={cn(
              "flex h-7 min-w-7 cursor-pointer items-center justify-center gap-1 rounded-md border bg-panel px-2 font-mono text-2xs font-medium shadow-panel transition-colors",
              offending ? "border-broken text-broken" : frozen ? "border-quarantined/60 text-quarantined" : "border-wire text-muted hover:border-line-strong hover:text-fg",
            )}
          >
            {frozen ? <Lock className="size-3" aria-hidden="true" /> : null}
            {offending ? <TriangleAlert className="size-3" aria-hidden="true" /> : null}
            {data.label}
          </button>
          {data.hovered ? <WireCard data={data} /> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

function WireCard({ data }: { data: WireData }) {
  const { group } = data;
  return (
    <div
      role="dialog"
      aria-label={`Last ${group.transfers.length} transfers on ${data.label}`}
      className="absolute left-1/2 top-8 z-20 w-[min(360px,86vw)] -translate-x-1/2 rounded-lg border border-wire bg-panel p-1 text-left shadow-pop"
      style={{ animation: "rise-in 160ms cubic-bezier(0.25,1,0.5,1)" }}
    >
      <div className="flex items-center justify-between gap-3 px-2.5 py-2 text-xs">
        <span className="font-semibold text-fg">{data.label}</span>
        <span className="truncate text-muted">
          {CHAINS[group.a].short} and {CHAINS[group.b].short} · last {group.transfers.length}
        </span>
      </div>
      {group.transfers.length === 0 ? (
        <p className="px-2.5 pb-3 pt-1 text-xs text-muted">No current on this wire yet</p>
      ) : (
        <ul className="max-h-[300px] overflow-y-auto">
          {group.transfers.map((t) => {
            const s = stateLabel(t);
            const tx = t.creditTx ?? t.debitTx;
            const amount = formatAmount(parseWei(t.amount), { decimals: data.decimals });
            return (
              <li key={`${t.messageId}-${t.state}`} className="grid grid-cols-[56px_1fr_auto] items-center gap-2 rounded-md px-2.5 py-1.5 text-xs hover:bg-raised">
                <span className="font-mono text-subtle tnum">{tx ? formatTime(tx.timestamp) : "--:--:--"}</span>
                <span className="flex min-w-0 items-center gap-1 text-muted">
                  {CHAINS[t.srcChain].short}
                  <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
                  {CHAINS[t.dstChain].short}
                  <span className={cn("ml-1.5", s.cls)}>{s.text}</span>
                </span>
                {tx ? (
                  <a href={txRefUrl(tx)} target="_blank" rel="noopener noreferrer" className="justify-self-end font-mono text-fg tnum hover:underline" title={`${shortHash(tx.hash)} on ${CHAINS[tx.chain].name}`}>
                    {amount}
                  </a>
                ) : (
                  <span className="justify-self-end font-mono text-fg tnum">{amount}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const nodeTypes = { chain: ChainNodeView, escrow: EscrowNodeView, frame: FrameNodeView };
const edgeTypes = { wire: WireEdge };

/** Keeps the schematic framed when its panel resizes (banners appear, viewport changes). */
function FitOnResize({ target, layoutKey }: { target: React.RefObject<HTMLDivElement | null>; layoutKey: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    let raf = 0;
    const fit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void fitView({ padding: 0.02, duration: 0 }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fitView, target, layoutKey]);
  return null;
}

/* ----------------------------------------------------------------------------------------------
 * Map
 * -------------------------------------------------------------------------------------------- */

const PULSE_MS = 600;
const COMPACT_BELOW_PX = 640;

export function CircuitMap({ status, onOpenChain }: { status: TokenStatusResponse; onOpenChain: (chain: ChainKey) => void }) {
  const { motionScale, reducedMotion } = usePrefs();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const token = status.token;
  const home = token.homeChain;
  const remotes = useMemo(() => status.chains.filter((c) => c.role === "remote").map((c) => c.chain), [status.chains]);
  const order = useMemo(() => [home, ...remotes], [home, remotes]);
  const layout = useMemo(() => layoutFor(home, remotes, compact), [home, remotes, compact]);
  const groups = useMemo(() => groupLanes(status.lanes, order), [status.lanes, order]);
  const routes = useMemo(() => routeWires(groups, home, layout), [groups, home, layout]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pulses, setPulses] = useState<Record<string, Pulse[]>>({});
  const duration = Math.round(PULSE_MS * motionScale);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setCompact(entry.contentRect.width < COMPACT_BELOW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Every settled transfer sends a 6px dot along its wire in 600ms (PRD section 12 motion rules).
  useEffect(() => {
    if (reducedMotion) return;
    const timers = new Set<number>();
    const off = onTransfer(token.symbol, (e: TransferEvent) => {
      if (e.state === "in_flight") return;
      const [a, b] = [e.srcChain, e.dstChain].sort((x, y) => order.indexOf(x) - order.indexOf(y));
      const gid = `${e.bridge}:${a}|${b}`;
      const g = groupsRef.current.find((x) => x.id === gid);
      if (!g) return;
      // Home wires are drawn remote to escrow; bus wires are drawn a to b.
      const involvesHome = g.a === home || g.b === home;
      const drawnFrom = involvesHome ? (g.a === home ? g.b : g.a) : g.a;
      const pulse: Pulse = { id: `${e.messageId}-${e.state}`, reverse: e.srcChain !== drawnFrom, kind: e.state === "settled" ? "settled" : e.state === "refused" ? "refused" : "forged" };
      setPulses((prev) => ({ ...prev, [gid]: [...(prev[gid] ?? []).filter((p) => p.id !== pulse.id), pulse] }));
      const t = window.setTimeout(() => {
        timers.delete(t);
        setPulses((prev) => ({ ...prev, [gid]: (prev[gid] ?? []).filter((p) => p.id !== pulse.id) }));
      }, duration + 400);
      timers.add(t);
    });
    return () => {
      off();
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [token.symbol, order, home, reducedMotion, duration]);

  const openEscrow = useCallback(() => onOpenChain(home), [onOpenChain, home]);
  const backing = parseWei(status.backing);
  const claims = parseWei(status.claims.total);

  const nodes = useMemo<AnyNode[]>(() => {
    const d = layout.dims;
    const out: AnyNode[] = [
      { id: "frame", type: "frame", position: { x: 0, y: 0 }, draggable: false, selectable: false, focusable: false, zIndex: -1, data: { dims: d } },
      {
        id: "escrow",
        type: "escrow",
        position: layout.positions.escrow ?? { x: 0, y: 0 },
        draggable: false,
        selectable: false,
        data: { backing, claims, symbol: token.symbol, decimals: token.decimals, status: token.status, dims: d, compact: layout.compact, calm: reducedMotion, onOpen: openEscrow },
      },
    ];
    for (const c of status.chains) {
      out.push({
        id: c.chain,
        type: "chain",
        position: layout.positions[c.chain] ?? { x: 0, y: 0 },
        draggable: false,
        selectable: false,
        data: {
          chain: c.chain,
          role: c.role,
          supply: parseWei(c.supply),
          symbol: token.symbol,
          decimals: token.decimals,
          status: c.ledgerStatus,
          frozen: c.frozen,
          readError: c.read.ok ? null : c.read.error,
          pinnedBlock: c.pinnedBlock.number,
          dims: d,
          compact: layout.compact,
          onOpen: onOpenChain,
        },
      });
    }
    return out;
  }, [status.chains, layout, backing, claims, token, openEscrow, onOpenChain, reducedMotion]);

  const edges = useMemo<WireEdgeT[]>(
    () =>
      groups.flatMap((g) => {
        const route = routes.get(g.id);
        if (!route) return [];
        const involvesHome = g.a === home || g.b === home;
        const from = involvesHome ? (g.a === home ? g.b : g.a) : g.a;
        const to = involvesHome ? "escrow" : g.b;
        const bridge = status.bridges.find((b) => b.id === g.bridge);
        const edge: WireEdgeT = {
          id: g.id,
          source: from,
          target: to,
          type: "wire",
          selectable: false,
          focusable: false,
          zIndex: hovered === g.id ? 10 : g.offending ? 5 : 0,
          data: {
            group: g,
            points: route.points,
            labelAt: route.label,
            label: bridge?.kind === "ccip_v2" ? "CCIP" : (bridge?.label.split(" ")[0] ?? g.bridge),
            pulses: pulses[g.id] ?? [],
            durationMs: duration,
            reducedMotion,
            motionScale,
            decimals: token.decimals,
            hovered: hovered === g.id,
            compact: layout.compact,
            onHover: setHovered,
          },
        };
        return [edge];
      }),
    [groups, routes, home, status.bridges, pulses, duration, reducedMotion, motionScale, token.decimals, hovered, layout.compact],
  );

  const d = layout.dims;
  const homePos = layout.positions[home];
  const escrowPos = layout.positions.escrow;

  return (
    <div ref={wrapRef} className="relative h-full w-full schematic-grid" aria-label={`Circuit map of ${token.symbol} across ${status.chains.length} chains`} role="group" data-testid="circuit-map">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.02 }}
        minZoom={0.2}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
      >
        <FitOnResize target={wrapRef} layoutKey={`${layout.compact}`} />
        {homePos && escrowPos ? (
          <CustodyLink
            from={{ x: homePos.x + d.chainW / 2, y: homePos.y }}
            to={{ x: escrowPos.x + d.escrowW / 2, y: escrowPos.y + d.escrowH }}
            breached={isBreached(token.status)}
          />
        ) : null}
      </ReactFlow>
    </div>
  );
}

function CustodyLink({ from, to, breached }: { from: Point; to: Point; breached: boolean }) {
  return (
    <EdgeLabelRenderer>
      <div className="pointer-events-none absolute" style={{ transform: `translate(${to.x - 1}px, ${to.y}px)`, width: 2, height: from.y - to.y }}>
        <div className={cn("h-full w-[2px]", breached ? "bg-broken/40" : "bg-line-strong")} />
        <span className="absolute left-3 top-1/2 -translate-y-1/2 whitespace-nowrap text-2xs text-subtle">lock · release</span>
      </div>
    </EdgeLabelRenderer>
  );
}
