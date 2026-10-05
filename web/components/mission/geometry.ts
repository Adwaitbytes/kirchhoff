import type { ChainKey, Lane, LaneTransfer } from "@/lib/api/types";

export interface Point {
  x: number;
  y: number;
}

/** Orthogonal polyline with rounded corners, like a PCB trace. */
export function roundedPath(points: readonly Point[], radius = 12): string {
  const first = points[0];
  if (!first) return "";
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i]!;
    const prev = points[i - 1]!;
    const next = points[i + 1];
    if (!next) {
      d += ` L ${p.x} ${p.y}`;
      break;
    }
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLen = Math.hypot(next.x - p.x, next.y - p.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const a = { x: p.x - ((p.x - prev.x) / inLen) * r, y: p.y - ((p.y - prev.y) / inLen) * r };
    const b = { x: p.x + ((next.x - p.x) / outLen) * r, y: p.y + ((next.y - p.y) / outLen) * r };
    d += ` L ${a.x} ${a.y} Q ${p.x} ${p.y} ${b.x} ${b.y}`;
  }
  return d;
}

/** Point at the middle of the longest segment, where the wire label sits. */
export function labelPoint(points: readonly Point[]): Point {
  let best = { len: -1, p: points[0] ?? { x: 0, y: 0 } };
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best.len) best = { len, p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  return best.p;
}

export interface Dims {
  chainW: number;
  chainH: number;
  escrowW: number;
  escrowH: number;
  canvasW: number;
  canvasH: number;
}

/** Wide schematic for desktop and stage. */
export const WIDE: Dims = { chainW: 264, chainH: 128, escrowW: 320, escrowH: 160, canvasW: 1140, canvasH: 668 };
/** Portrait schematic for phones: remotes on top, escrow below, home at the bottom. */
export const COMPACT: Dims = { chainW: 164, chainH: 104, escrowW: 228, escrowH: 128, canvasW: 368, canvasH: 600 };

export interface Layout {
  dims: Dims;
  compact: boolean;
  positions: Record<string, Point>;
  escrow: Point;
}

/** Remotes along the top, escrow in the center, home chain below it. */
export function layoutFor(home: ChainKey, remotes: readonly ChainKey[], compact = false): Layout {
  const d = compact ? COMPACT : WIDE;
  const positions: Record<string, Point> = {};
  const escrow = { x: (d.canvasW - d.escrowW) / 2, y: compact ? 252 : 270 };
  positions.escrow = escrow;
  positions[home] = { x: (d.canvasW - d.chainW) / 2, y: d.canvasH - d.chainH - 8 };
  const n = remotes.length;
  const margin = compact ? 8 : 24;
  remotes.forEach((r, i) => {
    const x = n === 1 ? (d.canvasW - d.chainW) / 2 : margin + (i * (d.canvasW - d.chainW - margin * 2)) / (n - 1);
    positions[r] = { x, y: compact ? 52 : 64 };
  });
  return { dims: d, compact, positions, escrow };
}

/** One wire per bridge per chain pair. Lanes are directional; a wire carries both directions. */
export interface WireGroup {
  id: string;
  bridge: string;
  a: ChainKey;
  b: ChainKey;
  lanes: Lane[];
  frozen: boolean;
  offending: boolean;
  transfers: LaneTransfer[];
}

export function groupLanes(lanes: readonly Lane[], order: readonly ChainKey[]): WireGroup[] {
  const groups = new Map<string, WireGroup>();
  for (const lane of lanes) {
    const [a, b] = [lane.srcChain, lane.dstChain].sort((x, y) => order.indexOf(x) - order.indexOf(y)) as [ChainKey, ChainKey];
    const id = `${lane.bridge}:${a}|${b}`;
    const g = groups.get(id) ?? { id, bridge: lane.bridge, a, b, lanes: [], frozen: false, offending: false, transfers: [] };
    g.lanes.push(lane);
    g.frozen ||= lane.frozen;
    g.offending ||= lane.offending;
    g.transfers.push(...lane.recentTransfers);
    groups.set(id, g);
  }
  for (const g of groups.values()) {
    g.transfers.sort((x, y) => transferTime(y) - transferTime(x));
    g.transfers = g.transfers.slice(0, 10);
  }
  return [...groups.values()];
}

export function transferTime(t: LaneTransfer): number {
  return Date.parse((t.creditTx ?? t.debitTx)?.timestamp ?? "1970-01-01T00:00:00Z");
}

/**
 * Routes every wire group. Wires between the home chain and a remote attach to the escrow
 * (that is where lock and release happen); remote to remote wires run along a top bus.
 */
export interface Route {
  points: Point[];
  label: Point;
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function routeWires(groups: readonly WireGroup[], home: ChainKey, layout: Layout): Map<string, Route> {
  const routes = new Map<string, Route>();
  const set = (id: string, points: Point[], label?: Point) => routes.set(id, { points, label: label ?? labelPoint(points) });
  const { positions, escrow, dims: NODE, compact } = layout;
  const escCy = escrow.y + NODE.escrowH / 2;
  const escCx = escrow.x + NODE.escrowW / 2;

  // Parallel wires to the same remote fan out: index 0 is the outer (upper) trace.
  const perRemote = new Map<ChainKey, WireGroup[]>();
  for (const g of groups) {
    if (g.a !== home && g.b !== home) continue;
    const remote = g.a === home ? g.b : g.a;
    perRemote.set(remote, [...(perRemote.get(remote) ?? []), g]);
  }
  let busLevel = 0;
  for (const g of groups) {
    const involvesHome = g.a === home || g.b === home;
    if (involvesHome) {
      const remote = g.a === home ? g.b : g.a;
      const siblings = (perRemote.get(remote) ?? []).sort((x, y) => (x.bridge === "ccip" ? -1 : y.bridge === "ccip" ? 1 : x.bridge.localeCompare(y.bridge)));
      const k = siblings.indexOf(g);
      const spread = (k - (siblings.length - 1) / 2) * 26;
      const p = positions[remote];
      if (!p) continue;
      const leftSide = p.x + NODE.chainW / 2 < escCx;
      if (compact) {
        // Portrait: drop from the remote's bottom edge, then run into the escrow's top edge.
        const sx = p.x + NODE.chainW / 2 + spread * (leftSide ? 1 : -1);
        const ex = escrow.x + NODE.escrowW * (leftSide ? 0.3 : 0.7) + spread * (leftSide ? 1 : -1) * 0.6;
        const yBend = p.y + NODE.chainH + 26 - spread * 0.6;
        const pts = [{ x: sx, y: p.y + NODE.chainH }, { x: sx, y: yBend }, { x: ex, y: yBend }, { x: ex, y: escrow.y }];
        // Parallel wires label on different segments so chips never stack.
        set(g.id, pts, k % 2 === 0 ? mid(pts[0]!, pts[1]!) : mid(pts[2]!, pts[3]!));
        continue;
      }
      const yStart = p.y + NODE.chainH / 2 + spread;
      const yEnd = escCy + spread;
      if (leftSide) {
        const xStart = p.x + NODE.chainW;
        const xm = xStart + 52 - spread;
        set(g.id, [{ x: xStart, y: yStart }, { x: xm, y: yStart }, { x: xm, y: yEnd }, { x: escrow.x, y: yEnd }]);
      } else {
        const xStart = p.x;
        const xm = xStart - 52 + spread;
        set(g.id, [{ x: xStart, y: yStart }, { x: xm, y: yStart }, { x: xm, y: yEnd }, { x: escrow.x + NODE.escrowW, y: yEnd }]);
      }
    } else {
      const pa = positions[g.a];
      const pb = positions[g.b];
      if (!pa || !pb) continue;
      const y = 22 - busLevel * 10;
      busLevel += 1;
      const xa = pa.x + NODE.chainW / 2;
      const xb = pb.x + NODE.chainW / 2;
      // Stacked bus wires label at different points along the bus so chips never overlap.
      const f = [0.5, 0.3, 0.7][(busLevel - 1) % 3] ?? 0.5;
      set(g.id, [{ x: xa, y: pa.y }, { x: xa, y }, { x: xb, y }, { x: xb, y: pb.y }], { x: xa + (xb - xa) * f, y });
    }
  }
  return routes;
}
