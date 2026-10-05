"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import type { Address, SpecDraftEvent } from "@/lib/api/types";
import { useApi } from "@/lib/api/provider";
import { DATA_SOURCE, isApiError } from "@/lib/api/client";
import { fxAddress } from "@/lib/api/fixtures/ids";
import { usePrefs } from "@/lib/prefs";
import { Button } from "@/components/ui/button";
import { EMPTY_DISCOVERY, STEPS, type DescribeInput, type DiscoveryState } from "@/components/onboard/model";
import { Stepper } from "@/components/onboard/stepper";
import { StepDescribe, describeErrors } from "@/components/onboard/step-describe";
import { StepDiscover } from "@/components/onboard/step-discover";
import { SpecReview } from "@/components/onboard/spec-review";
import { StepBacktest } from "@/components/onboard/step-backtest";
import { StepPropose } from "@/components/onboard/step-propose";
import { StepTimelock } from "@/components/onboard/step-timelock";

const HEADINGS: readonly { title: string; sub: string }[] = [
  { title: "Describe the circuit", sub: "Where it lives, how it moves" },
  { title: "Copilot traces the wiring", sub: "Read-only tools, every result cited" },
  { title: "Every line needs evidence", sub: "Red lines block approval" },
  { title: "Replay real history", sub: "One BROKEN blocks activation" },
  { title: "Propose from the issuer Safe", sub: "Your signature, your spec" },
  { title: "Timelock", sub: "Then the circuit closes" },
];

const EXAMPLE = "kETH, home on Ethereum Sepolia, on Arbitrum Sepolia and Base Sepolia, bridged with CCIP and a custom WeakBridge";

function errorMessage(e: unknown, fallback: string): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

function reduceDiscovery(prev: DiscoveryState, e: SpecDraftEvent): DiscoveryState {
  switch (e.type) {
    case "thinking":
      return { ...prev, items: [...prev.items, { kind: "thinking", id: `th-${prev.items.length}`, text: e.text }] };
    case "tool_call":
      return { ...prev, items: [...prev.items, { kind: "tool", id: e.id, tool: e.tool, input: e.input, at: e.at, result: null }] };
    case "tool_result":
      return {
        ...prev,
        items: prev.items.map((it) => (it.kind === "tool" && it.id === e.id ? { ...it, result: { ok: e.ok, summary: e.summary, href: e.href, durationMs: e.durationMs } } : it)),
      };
    case "draft":
      return { ...prev, draft: { yaml: e.yaml, lines: e.lines, specHash: e.specHash } };
    case "validation":
      return { ...prev, validation: { ok: e.ok, errors: e.errors } };
    case "done":
      return prev.draft ? { ...prev, phase: "done" } : { ...prev, phase: "error", error: "Copilot finished without a draft." };
    case "error":
      return { ...prev, phase: "error", error: e.message };
  }
}

export function OnboardWizard() {
  const api = useApi();
  const { reducedMotion } = usePrefs();
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [input, setInput] = useState<DescribeInput>(() => ({
    description: EXAMPLE,
    chain: "ethereum-testnet-sepolia",
    address: DATA_SOURCE === "fixtures" ? fxAddress("kETH:ethereum-testnet-sepolia:token") : "",
  }));
  const [showErrors, setShowErrors] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryState>(EMPTY_DISCOVERY);
  const [yaml, setYaml] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, [step, reducedMotion]);

  const go = useCallback((i: number) => {
    setStep(i);
    setReached((r) => Math.max(r, i));
  }, []);

  const startDiscovery = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setDiscovery({ ...EMPTY_DISCOVERY, phase: "running" });
    setReached((r) => Math.min(r, 1));
    api
      .draftSpec(
        { description: input.description.trim(), canonical: { chain: input.chain, address: input.address.trim() as Address } },
        (e) => {
          setDiscovery((prev) => reduceDiscovery(prev, e));
          if (e.type === "draft") setYaml(e.yaml);
        },
        ctrl.signal,
      )
      .then(() => setDiscovery((p) => (p.phase === "running" ? (p.draft ? { ...p, phase: "done" } : { ...p, phase: "error", error: "Copilot stream ended without a draft." }) : p)))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) {
          setDiscovery((p) => (p.phase === "running" ? { ...p, phase: "stopped" } : p));
          return;
        }
        setDiscovery((p) => ({ ...p, phase: "error", error: errorMessage(err, "Copilot is unreachable.") }));
      });
  }, [api, input]);

  const backtest = useMutation({ mutationFn: (y: string) => api.backtestSpec({ yaml: y }) });
  const specHash = backtest.data?.specHash ?? null;
  const proposal = useQuery({
    queryKey: ["spec-proposal", specHash],
    queryFn: ({ signal }) => api.getSpecProposal(specHash as NonNullable<typeof specHash>, signal),
    enabled: specHash !== null && step >= 4,
    refetchInterval: (q) => (q.state.data?.state === "active" ? false : 15_000),
  });

  const onYamlChange = (v: string) => {
    setYaml(v);
    if (reached > 2) {
      setReached(2);
      backtest.reset();
    }
  };

  const approve = () => {
    backtest.mutate(yaml);
    go(3);
  };

  const describeOk = (() => {
    const e = describeErrors(input);
    return e.description === null && e.address === null;
  })();
  const backtestOk = backtest.data ? backtest.data.ok && backtest.data.breaches.length === 0 : false;
  const proposed = proposal.data ? proposal.data.state !== "draft" : false;

  const next: { label: string; enabled: boolean; action: () => void } | null = (() => {
    switch (step) {
      case 0:
        return {
          label: "Trace the wiring",
          enabled: true,
          action: () => {
            setShowErrors(true);
            if (!describeOk) return;
            if (discovery.phase === "idle" || discovery.phase === "error" || discovery.phase === "stopped" || reached <= 1) startDiscovery();
            go(1);
          },
        };
      case 1:
        return { label: "Review the draft", enabled: discovery.phase === "done" && discovery.draft !== null, action: () => go(2) };
      case 2:
        return null;
      case 3:
        return { label: "Propose", enabled: backtestOk, action: () => go(4) };
      case 4:
        return { label: "Watch the timelock", enabled: proposed, action: () => go(5) };
      default:
        return null;
    }
  })();

  const heading = HEADINGS[step] ?? HEADINGS[0]!;
  const token = /^token:\s*(\S+)/m.exec(yaml)?.[1] ?? null;
  const motionProps = reducedMotion
    ? { initial: false as const, animate: { opacity: 1 }, exit: { opacity: 1 } }
    : { initial: { opacity: 0, y: 8, filter: "blur(4px)" }, animate: { opacity: 1, y: 0, filter: "blur(0px)" }, exit: { opacity: 0, y: -6, filter: "blur(4px)" } };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[1320px] px-4 pb-16 pt-6 sm:px-6 lg:px-8 lg:pt-10">
        <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-medium text-conserved">
              <Sparkles className="size-3.5" aria-hidden="true" /> Spec Copilot
            </p>
            <h1 className="mt-1.5 text-xl font-semibold tracking-[-0.02em] text-fg">Wire a token into the circuit</h1>
            <p className="mt-1 text-sm text-muted">Six steps. One Safe signature. AI drafts, you decide.</p>
          </div>
        </header>

        <Stepper current={step} reached={reached} onSelect={(i) => setStep(i)} />

        <section aria-labelledby="onboard-step-title" className="relative mt-6 overflow-hidden rounded-2xl border border-wire bg-panel shadow-[0_1px_0_rgb(255_255_255/0.04)_inset,0_1px_2px_rgb(0_0_0/0.3),0_24px_60px_-32px_rgb(0_0_0/0.7)]">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--status-conserved)_55%,transparent),transparent)]" />
          <div className="border-b border-wire px-5 py-4 sm:px-6">
            <p className="font-mono text-xs text-subtle tnum">
              {String(step + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
            </p>
            <h2 id="onboard-step-title" ref={headingRef} tabIndex={-1} className="mt-0.5 text-lg font-semibold tracking-[-0.01em] text-fg outline-none">
              {heading.title}
            </h2>
            <p className="text-sm text-muted">{heading.sub}</p>
          </div>
          <div className="px-5 py-6 sm:px-6">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={step} {...motionProps} transition={{ duration: reducedMotion ? 0 : 0.24, ease: [0.25, 1, 0.5, 1] }}>
                {step === 0 ? <StepDescribe value={input} onChange={setInput} showErrors={showErrors} /> : null}
                {step === 1 ? <StepDiscover state={discovery} onStart={startDiscovery} onStop={() => abortRef.current?.abort()} /> : null}
                {step === 2 ? (
                  discovery.draft ? (
                    <SpecReview draft={discovery.draft} yaml={yaml} onYamlChange={onYamlChange} validation={discovery.validation} onApprove={approve} />
                  ) : (
                    <p className="text-sm text-muted">No draft yet. Run the Copilot first.</p>
                  )
                ) : null}
                {step === 3 ? (
                  <StepBacktest result={backtest.data} pending={backtest.isPending} error={backtest.error ? errorMessage(backtest.error, "Backtest failed.") : null} onRun={() => backtest.mutate(yaml)} />
                ) : null}
                {step === 4 && specHash ? (
                  <StepPropose
                    specHash={specHash}
                    chain={input.chain}
                    proposal={proposal.data}
                    pending={proposal.isPending}
                    error={proposal.error ? errorMessage(proposal.error, "Lookup failed.") : null}
                    onCheck={() => void proposal.refetch()}
                    checking={proposal.isFetching}
                  />
                ) : null}
                {step === 5 ? <StepTimelock proposal={proposal.data} chain={input.chain} /> : null}
              </motion.div>
            </AnimatePresence>
          </div>
          <footer className="flex flex-col-reverse gap-3 border-t border-wire bg-inset/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
              <ArrowLeft aria-hidden="true" /> Back
            </Button>
            {next ? (
              <Button variant="primary" size="lg" onClick={next.action} disabled={!next.enabled} className="w-full sm:w-auto">
                {next.label} <ArrowRight aria-hidden="true" />
              </Button>
            ) : step === 5 && token ? (
              <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
                <Link href={`/app/tokens/${encodeURIComponent(token)}`}>
                  Open {token} Mission Control <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
          </footer>
        </section>
      </div>
    </div>
  );
}
