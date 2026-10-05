"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { OctagonX } from "lucide-react";
import type { EpochPoint } from "@/lib/api/types";
import { formatAmount, formatDateTime, formatTime, parseWei } from "@/lib/format";
import { shortHash, txRefUrl } from "@/lib/explorer";
import { usePrefs } from "@/lib/prefs";
import { StatusWord } from "@/components/kh/status";
import { Skeleton } from "@/components/ui/skeleton";

interface Point {
  t: number;
  delta: number;
  epoch: EpochPoint;
}

export function DeltaHistory({ epochs, decimals, symbol, view }: { epochs: EpochPoint[]; decimals: number; symbol: string; view: "chart" | "table" }) {
  const gid = useId().replace(/:/g, "");
  const { reducedMotion, stage } = usePrefs();
  const tickSize = stage ? 13 : 11;
  const unit = 10n ** BigInt(decimals);
  const data = useMemo<Point[]>(
    () => [...epochs].reverse().map((e) => ({ t: Date.parse(e.evaluatedAt), delta: Number(parseWei(e.delta) / unit), epoch: e })),
    [epochs, unit],
  );
  const incidents = useMemo(() => {
    const seen = new Map<string, Point>();
    for (const p of data) if (p.epoch.incidentId && !seen.has(p.epoch.incidentId)) seen.set(p.epoch.incidentId, p);
    return [...seen.entries()].map(([id, p]) => ({ id, p }));
  }, [data]);

  const min = Math.min(0, ...data.map((d) => d.delta));
  const max = Math.max(0, ...data.map((d) => d.delta));
  const span = max - min;
  const zeroOffset = span === 0 ? 1 : max / span;
  const pad = span === 0 ? 2 : span * 0.12;
  const step = span === 0 ? 1 : 10 ** Math.floor(Math.log10(span)) / 2;
  const lo = span === 0 ? -2 : Math.floor((min - pad) / step) * step;
  const hi = span === 0 ? 2 : Math.ceil((max + pad) / step) * step;
  const [hover, setHover] = useState<Point | null>(null);

  if (view === "table") {
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs tnum">
          <caption className="sr-only">Δ per epoch over the last 24 hours, newest first</caption>
          <thead className="sticky top-0 bg-panel">
            <tr className="border-b border-wire text-subtle">
              <th scope="col" className="py-2 pl-4 pr-3 text-left font-medium">Time (UTC)</th>
              <th scope="col" className="px-3 text-left font-medium">Epoch</th>
              <th scope="col" className="px-3 text-right font-medium">Δ ({symbol})</th>
              <th scope="col" className="py-2 pl-3 pr-4 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {epochs.slice(0, 200).map((e) => {
              const tx = e.reportTxs[0];
              return (
                <tr key={e.epochId} className="border-b border-wire/60">
                  <td className="py-1.5 pl-4 pr-3 font-mono text-muted">{formatTime(e.evaluatedAt)}</td>
                  <td className="px-3 font-mono">
                    {tx ? (
                      <a href={txRefUrl(tx)} target="_blank" rel="noopener noreferrer" className="text-fg hover:underline">
                        {e.epochId}
                      </a>
                    ) : (
                      e.epochId
                    )}
                  </td>
                  <td className={`px-3 text-right font-mono ${parseWei(e.delta) < 0n ? "text-broken" : "text-fg"}`}>{formatAmount(parseWei(e.delta), { decimals, signed: true })}</td>
                  <td className="py-1.5 pl-3 pr-4 text-right">
                    <StatusWord status={e.status} className="text-2xs" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 px-2 pt-2" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            accessibilityLayer={false}
            data={data}
            margin={{ top: 8, right: 28, bottom: 0, left: 4 }}
            onMouseMove={(s) => {
              const i = typeof s.activeTooltipIndex === "number" ? s.activeTooltipIndex : Number(s.activeTooltipIndex);
              setHover(Number.isFinite(i) ? (data[i] ?? null) : null);
            }}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={`fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--status-conserved)" stopOpacity={0.28} />
                <stop offset={zeroOffset} stopColor="var(--status-conserved)" stopOpacity={0.04} />
                <stop offset={zeroOffset} stopColor="var(--status-broken)" stopOpacity={0.06} />
                <stop offset="1" stopColor="var(--status-broken)" stopOpacity={0.32} />
              </linearGradient>
              <linearGradient id={`stroke-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset={zeroOffset} stopColor="var(--status-conserved)" />
                <stop offset={zeroOffset} stopColor="var(--status-broken)" />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--line-wire)" strokeOpacity={0.6} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t: number) => formatTime(new Date(t).toISOString()).slice(0, 5)}
              tick={{ fill: "var(--fg-subtle)", fontSize: tickSize, fontFamily: "var(--font-dm-mono)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--line-wire)" }}
              minTickGap={48}
            />
            <YAxis
              domain={[lo, hi]}
              allowDecimals={false}
              tickCount={5}
              {...(span === 0 ? { ticks: [0] } : {})}
              tickFormatter={(v: number) => {
                const r = Math.round(v);
                return r === 0 ? "0" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(r);
              }}
              tick={{ fill: "var(--fg-subtle)", fontSize: tickSize, fontFamily: "var(--font-dm-mono)" }}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <ReferenceLine y={0} stroke="var(--line-strong)" strokeDasharray="2 4" />
            {incidents.map(({ id, p }) => (
              <ReferenceLine key={id} x={p.t} stroke="var(--status-broken)" strokeWidth={1.5} strokeDasharray="3 3" />
            ))}
            <RTooltip cursor={{ stroke: "var(--line-strong)" }} content={() => null} />
            <Area
              type="stepAfter"
              dataKey="delta"
              stroke={`url(#stroke-${gid})`}
              strokeWidth={1.75}
              fill={`url(#fill-${gid})`}
              baseValue={0}
              isAnimationActive={!reducedMotion}
              animationDuration={500}
              dot={false}
              activeDot={{ r: 3.5, stroke: "var(--bg-panel)", strokeWidth: 2, fill: "var(--fg)" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-3 px-4 text-xs text-muted">
        {hover ? (
          <span className="font-mono tnum">
            {formatDateTime(hover.epoch.evaluatedAt)} · epoch {hover.epoch.epochId} · Δ {formatAmount(parseWei(hover.epoch.delta), { decimals, signed: true })} {symbol}
          </span>
        ) : incidents.length > 0 ? (
          incidents.map(({ id, p }) => (
            <Link key={id} href={`/app/incidents/${id}`} className="inline-flex items-center gap-1.5 text-broken hover:underline">
              <OctagonX className="size-3.5" aria-hidden="true" />
              Incident {shortHash(id)} at {formatTime(p.epoch.evaluatedAt)}
            </Link>
          ))
        ) : (
          <span>No incidents in the last 24 hours.</span>
        )}
      </div>
    </div>
  );
}

export function DeltaHistorySkeleton() {
  return (
    <div className="flex flex-1 flex-col justify-end gap-2 px-4 pb-4" aria-hidden="true">
      <Skeleton className="h-[70%] w-full rounded-md opacity-60" />
      <Skeleton className="h-3 w-1/3" />
    </div>
  );
}
