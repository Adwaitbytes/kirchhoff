"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, CircleDashed, Loader, Play, TerminalSquare, X } from "lucide-react";
import type { LabConsoleLine, LabRun, LabStep, LabStepKey, LabStatusResponse } from "@/lib/api/types";
import { useApi } from "@/lib/api/provider";
import { queryKeys, useLabStatus, useNow } from "@/lib/api/hooks";
import { isApiError } from "@/lib/api/client";
import { ccipMessageUrl, shortHash, txRefUrl } from "@/lib/explorer";
import { CHAINS } from "@/lib/chains";
import { formatTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Banner } from "@/components/kh/banner";
import { SimulationLabel } from "@/components/kh/simulation";
import { TxLink } from "@/components/kh/links";
import { MissionControl } from "@/components/mission/mission-control";
import { cn } from "@/lib/utils";

/** PRD section 5, Flow B: the seven steps of the Kelp Replay. */
const STEP_COPY: Record<LabStepKey, { title: string; detail: string }> = {
  forge_release: {
    title: "Forge a WeakBridge message",
    detail: "Its single verifier key signs a credit. HomeEscrowAdapter releases 116,500 kETH on Ethereum Sepolia.",
  },
  junction_search: {
    title: "W1 searches for the matching debit",
    detail: "The Released log trigger fires. No Burned debit with this message id exists on any remote chain.",
  },
  breach_written: {
    title: "BROKEN written to all three ledgers",
    detail: "Same CRE run. The evidence hash lands in ConservationLedger on every chain.",
  },
  quarantine_applied: {
    title: "W3 applies quarantine",
    detail: "CCIP lanes for kETH freeze, the attacker is tainted, the Conservation Feed answers BROKEN.",
  },
  ccip_refused: {
    title: "The attacker bridges to Base through CCIP",
    detail: "Every cell's Judge returns FAIL TOKEN_BROKEN. The message never executes.",
  },
  guard_and_lending: {
    title: "Guard and lending market hold",
    detail: "KirchhoffGuard blocks the tainted sender. borrow() reverts CollateralBroken().",
  },
  loop_confirmed: {
    title: "W2 confirms the Loop Rule deficit",
    detail: "The next epoch reads every chain at pinned blocks: Δ = −116,500 kETH.",
  },
};

function StepIcon({ state }: { state: LabStep["state"] }) {
  switch (state) {
    case "done":
      return (
        <span className="flex size-6 items-center justify-center rounded-full bg-conserved text-on-status">
          <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
        </span>
      );
    case "running":
      return (
        <span className="flex size-6 items-center justify-center rounded-full border-2 border-drift text-drift">
          <Loader className="size-3.5 motion-safe:animate-spin" style={{ animationDuration: "1.4s" }} aria-hidden="true" />
        </span>
      );
    case "failed":
      return (
        <span className="flex size-6 items-center justify-center rounded-full bg-broken text-on-status">
          <X className="size-3.5" strokeWidth={3} aria-hidden="true" />
        </span>
      );
    case "pending":
      return (
        <span className="flex size-6 items-center justify-center rounded-full border border-wire text-subtle">
          <CircleDashed className="size-3.5" aria-hidden="true" />
        </span>
      );
  }
}

function StepTracker({ run }: { run: LabRun | null }) {
  const steps: LabStep[] =
    run?.steps ??
    (Object.keys(STEP_COPY) as LabStepKey[]).map((key) => ({ key, state: "pending", startedAt: null, finishedAt: null, txs: [], note: null, messageId: null }));
  return (
    <ol className="relative" aria-label="Kelp Replay steps">
      {steps.map((st, i) => {
        const copy = STEP_COPY[st.key];
        const last = i === steps.length - 1;
        return (
          <li key={st.key} data-testid={`lab-step-${st.key}`} data-state={st.state} className="relative grid grid-cols-[24px_1fr] gap-x-3 pb-3.5 last:pb-0">
            {!last ? <span aria-hidden="true" className={cn("absolute left-[11.5px] top-7 bottom-1 w-px", st.state === "done" ? "bg-conserved/50" : "bg-wire")} /> : null}
            <StepIcon state={st.state} />
            <div className="min-w-0 pt-0.5">
              <p className={cn("text-sm font-medium", st.state === "pending" ? "text-muted" : "text-fg")}>
                <span className="mr-2 font-mono text-xs text-subtle">{i + 1}</span>
                {copy.title}
                <span className="sr-only">, {st.state}</span>
              </p>
              {st.state !== "pending" ? <p className="mt-0.5 text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">{st.note ?? copy.detail}</p> : <p className="sr-only">{copy.detail}</p>}
              {st.txs.length > 0 || st.messageId ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {st.txs.map((tx) => (
                    <TxLink key={`${tx.chain}-${tx.hash}`} tx={tx} showChain />
                  ))}
                  {st.key === "ccip_refused" && st.messageId ? (
                    <a href={ccipMessageUrl(st.messageId)} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-muted hover:text-fg hover:underline">
                      <span className="mr-1 font-sans text-subtle">CCIP msg</span>
                      {shortHash(st.messageId)}
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ConsoleLineView({ line }: { line: LabConsoleLine }) {
  const cls =
    line.stream === "cmd" ? "text-fg" : line.stream === "stdout" ? "text-muted" : "text-broken";
  const prefix = line.stream === "cmd" ? "$" : line.stream === "revert" || line.stream === "stderr" ? "✗" : "›";
  return (
    <div className="grid grid-cols-[64px_14px_1fr] gap-x-2 py-[3px]" style={{ animation: "rise-in 220ms cubic-bezier(0.25,1,0.5,1)" }}>
      <span className="text-subtle tnum">{formatTime(line.at)}</span>
      <span className={cn(line.stream === "cmd" ? "text-conserved" : cls)} aria-hidden="true">
        {prefix}
      </span>
      <span className={cn("min-w-0 [overflow-wrap:anywhere]", cls)}>
        {line.text}
        {line.tx ? (
          <a href={txRefUrl(line.tx)} target="_blank" rel="noopener noreferrer" className="ml-2 text-subtle underline decoration-dotted underline-offset-2 hover:text-fg">
            {CHAINS[line.tx.chain].short} {shortHash(line.tx.hash)}
          </a>
        ) : null}
      </span>
    </div>
  );
}

function AttackerConsole({ run }: { run: LabRun | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const count = run?.console.length ?? 0;
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [count]);
  return (
    <section aria-labelledby="console-title" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-wire bg-inset">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-wire px-3">
        <TerminalSquare className="size-4 text-muted" aria-hidden="true" />
        <h2 id="console-title" className="text-xs font-semibold text-fg">
          Attacker console
        </h2>
        {run ? <span className="ml-auto font-mono text-2xs text-subtle">{shortHash(run.attacker)}</span> : null}
      </header>
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed" role="log" aria-live="polite" aria-label="Attacker console output">
        {run && run.console.length > 0 ? (
          run.console.map((l, i) => <ConsoleLineView key={`${l.at}-${i}`} line={l} />)
        ) : (
          <p className="py-2 text-subtle">Idle. Run the Kelp Replay to watch the attacker try.</p>
        )}
      </div>
    </section>
  );
}

function Elapsed({ run }: { run: LabRun }) {
  const now = useNow();
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const s = Math.max(0, (end - Date.parse(run.startedAt)) / 1000);
  return <span className="font-mono text-xs text-muted tnum">{s.toFixed(1)}s</span>;
}

export function AttackLab() {
  const api = useApi();
  const qc = useQueryClient();
  const lab = useLabStatus();
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => api.runKelpReplay(),
    onMutate: () => setError(null),
    onSuccess: (res) => qc.setQueryData<LabStatusResponse>(queryKeys.lab, (prev) => (prev ? { ...prev, enabled: false, disabledReason: "A Kelp Replay is running.", run: res.run } : prev)),
    onError: (e) => setError(isApiError(e) ? e.message : "The Kelp Replay could not start."),
    onSettled: () => void qc.invalidateQueries({ queryKey: queryKeys.lab }),
  });
  const data = lab.data;
  const current = data?.run ?? null;
  const running = current?.state === "running";
  const disabled = !data || !data.enabled || run.isPending || running;
  const reason = running ? "A Kelp Replay is running." : (data?.disabledReason ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <aside className="flex w-full shrink-0 flex-col gap-4 border-b border-wire bg-panel p-4 sm:p-5 lg:w-[460px] lg:overflow-y-auto lg:border-b-0 lg:border-r 2xl:w-[520px]" aria-labelledby="lab-title">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h1 id="lab-title" className="font-display text-xl leading-none">
              Attack Lab
            </h1>
            <SimulationLabel />
          </div>
          <p className="text-sm leading-relaxed text-muted">
            Forges a WeakBridge message with the bridge&apos;s single verifier key and no matching burn. It reproduces the effect of the Kelp forgery, a credit with no debit, across three testnets.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="danger"
            size="lg"
            disabled={disabled}
            onClick={() => run.mutate()}
            data-testid="run-kelp-replay"
            aria-describedby={reason ? "lab-disabled-reason" : undefined}
            className={cn(running && "border border-broken/40 bg-broken/15 text-broken disabled:opacity-100")}
          >
            {running ? <Loader className="motion-safe:animate-spin" aria-hidden="true" /> : <Play className="fill-current" aria-hidden="true" />}
            {running ? "Replay running" : "Run Kelp Replay"}
          </Button>
          {current ? <Elapsed run={current} /> : null}
          {current?.incidentId ? (
            <Button asChild variant="outline" size="md" className="ml-auto">
              <Link href={`/app/incidents/${current.incidentId}`}>
                Incident Room <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </div>
        {lab.isPending ? <Skeleton className="h-4 w-2/3" /> : null}
        {reason && !running ? (
          <p id="lab-disabled-reason" className="text-xs text-muted" data-testid="lab-disabled-reason">
            {reason}
          </p>
        ) : null}
        {error ? <Banner tone="error">{error}</Banner> : null}
        {lab.error ? <Banner tone="error">Attack Lab status unavailable: {lab.error.message}</Banner> : null}
        <div className="rounded-lg border border-wire p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-fg">Flow B, step by step</h2>
            {current ? <span className="text-xs text-subtle">Started {formatTime(current.startedAt)} UTC</span> : null}
          </div>
          <StepTracker run={current} />
        </div>
        <div className="flex min-h-[260px] flex-1 flex-col">
          <AttackerConsole run={current} />
        </div>
      </aside>
      <div className="flex h-[100svh] min-h-0 min-w-0 shrink-0 flex-col lg:h-auto lg:flex-1 lg:shrink">
        <MissionControl token={current?.token ?? "kETH"} variant="embedded" />
      </div>
    </div>
  );
}
