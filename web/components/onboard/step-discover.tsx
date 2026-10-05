"use client";

import { ArrowUpRight, Brain, CircleCheck, CircleX, Loader, RotateCcw, Square } from "lucide-react";
import type { DiscoveryState, TraceItem } from "@/components/onboard/model";
import { Banner } from "@/components/kh/banner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePrefs } from "@/lib/prefs";
import { shortHash } from "@/lib/explorer";
import { cn } from "@/lib/utils";

function formatInput(input: Record<string, string | number | boolean | null>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}=${typeof v === "string" && v.startsWith("0x") && v.length > 14 ? shortHash(v) : String(v)}`)
    .join(" ");
}

function TraceRow({ item, last, running }: { item: TraceItem; last: boolean; running: boolean }) {
  const { reducedMotion } = usePrefs();
  const enter = reducedMotion ? undefined : { animation: "rise-in 260ms cubic-bezier(0.25,1,0.5,1)" };
  if (item.kind === "thinking") {
    return (
      <li className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3 pb-4" style={enter}>
        {!last ? <span aria-hidden="true" className="absolute bottom-0 left-[13.5px] top-7 w-px bg-wire" /> : null}
        <span className="flex size-7 items-center justify-center rounded-full border border-wire bg-inset text-subtle">
          <Brain className="size-3.5" aria-hidden="true" />
        </span>
        <p className="pt-1 text-sm italic text-muted">{item.text}</p>
      </li>
    );
  }
  const r = item.result;
  const pending = r === null;
  return (
    <li className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3 pb-4" style={enter}>
      {!last ? <span aria-hidden="true" className={cn("absolute bottom-0 left-[13.5px] top-7 w-px", pending ? "bg-wire" : "bg-conserved/40")} /> : null}
      <span
        className={cn(
          "flex size-7 items-center justify-center rounded-full border",
          pending ? "border-drift/50 bg-drift/10 text-drift" : r.ok ? "border-transparent bg-conserved text-on-status shadow-[0_0_14px_color-mix(in_oklab,var(--status-conserved)_45%,transparent)]" : "border-transparent bg-broken text-on-status",
        )}
      >
        {pending ? (
          <Loader className={cn("size-3.5", running && "motion-safe:animate-spin")} style={{ animationDuration: "1.4s" }} aria-hidden="true" />
        ) : r.ok ? (
          <CircleCheck className="size-3.5" aria-hidden="true" />
        ) : (
          <CircleX className="size-3.5" aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 rounded-lg border border-wire bg-panel px-3.5 py-2.5 shadow-[0_1px_0_rgb(255_255_255/0.03)_inset,0_6px_18px_-12px_rgb(0_0_0/0.6)]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-xs font-semibold text-fg">{item.tool}</span>
          <span className="min-w-0 truncate font-mono text-2xs text-subtle">{formatInput(item.input)}</span>
          {r ? <span className="ml-auto font-mono text-2xs text-subtle tnum">{r.durationMs}ms</span> : <span className="ml-auto text-2xs text-drift">calling</span>}
        </div>
        {r ? (
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
            <span className="min-w-0">{r.summary}</span>
            {r.href ? (
              <a href={r.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-xs text-fg/80 underline decoration-dotted underline-offset-2 hover:text-fg">
                evidence <ArrowUpRight className="size-3" aria-hidden="true" />
              </a>
            ) : null}
          </p>
        ) : (
          <Skeleton className="mt-2 h-3 w-2/3" />
        )}
      </div>
    </li>
  );
}

export function StepDiscover({ state, onStart, onStop }: { state: DiscoveryState; onStart: () => void; onStop: () => void }) {
  const running = state.phase === "running";
  const tools = state.items.filter((i) => i.kind === "tool");
  const done = tools.filter((i) => i.kind === "tool" && i.result !== null).length;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <section aria-labelledby="trace-title" className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h3 id="trace-title" className="text-sm font-semibold text-fg">
            Tool trace
          </h3>
          <span className="font-mono text-xs text-subtle tnum">
            {done}/{tools.length} calls
          </span>
          <div className="ml-auto flex items-center gap-2">
            {running ? (
              <Button size="sm" variant="outline" onClick={onStop}>
                <Square className="fill-current" aria-hidden="true" /> Stop
              </Button>
            ) : state.phase !== "idle" ? (
              <Button size="sm" variant="ghost" onClick={onStart}>
                <RotateCcw aria-hidden="true" /> Run again
              </Button>
            ) : null}
          </div>
        </div>
        {state.error ? (
          <Banner
            tone="error"
            className="mb-4"
            action={
              <Button size="sm" variant="ghost" onClick={onStart}>
                Retry
              </Button>
            }
          >
            Copilot run failed: {state.error}
          </Banner>
        ) : null}
        {state.phase === "stopped" ? (
          <Banner tone="info" className="mb-4">
            Stopped. Nothing was drafted. Run again to resume discovery.
          </Banner>
        ) : null}
        <ol data-testid="copilot-trace" aria-live="polite" aria-busy={running} className="min-w-0">
          {state.items.length === 0 && running ? (
            <li className="space-y-3" aria-hidden="true">
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-5/6 rounded-lg" />
            </li>
          ) : null}
          {state.items.map((item, i) => (
            <TraceRow key={item.id} item={item} last={i === state.items.length - 1} running={running} />
          ))}
        </ol>
      </section>
      <aside className="space-y-4">
        <div className="relative overflow-hidden rounded-xl border border-wire bg-inset p-5">
          <div aria-hidden="true" className={cn("pointer-events-none absolute -left-10 -top-10 size-40 rounded-full blur-3xl transition-colors duration-700", running ? "bg-drift/15" : state.draft ? "bg-conserved/15" : "bg-wire/30")} />
          <p className="text-xs font-medium text-subtle">Copilot</p>
          <p className="mt-1 text-lg font-semibold tracking-[-0.01em] text-fg">
            {running ? "Tracing the wiring" : state.draft ? "Draft ready" : state.phase === "error" ? "Run failed" : state.phase === "stopped" ? "Stopped" : "Waiting"}
          </p>
          <p className="mt-2 text-sm text-muted">
            {state.draft
              ? `${state.draft.lines.length} lines drafted from ${tools.length} tool calls. Next: check every line against its evidence.`
              : "Reads contracts, role grants, CCIP pools and sample events. No write tools exist."}
          </p>
        </div>
        {state.validation ? (
          <div className={cn("rounded-xl border p-4", state.validation.ok ? "border-conserved/40 bg-conserved/5" : "border-drift/40 bg-drift/5")}>
            <p className="text-sm font-medium text-fg">{state.validation.ok ? "Schema valid" : "Validation flags"}</p>
            <ul className="mt-2 space-y-1.5 text-sm text-muted">
              {state.validation.errors.length === 0 ? <li>No errors.</li> : null}
              {state.validation.errors.map((e, i) => (
                <li key={i}>
                  {e.line !== null ? <span className="mr-1.5 font-mono text-xs text-drift tnum">L{e.line}</span> : null}
                  {e.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-xs text-subtle">Contract names and comments are treated as data, never as instructions.</p>
      </aside>
    </div>
  );
}
