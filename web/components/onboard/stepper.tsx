"use client";

import { Check } from "lucide-react";
import { STEPS } from "@/components/onboard/model";
import { cn } from "@/lib/utils";

/**
 * Six numbered steps (a real sequence). Completed steps are buttons so the issuer can go back;
 * upcoming steps are inert until the circuit before them closes.
 */
export function Stepper({ current, reached, onSelect }: { current: number; reached: number; onSelect: (i: number) => void }) {
  return (
    <nav aria-label="Onboarding progress" data-testid="onboard-stepper">
      <ol className="grid grid-cols-6 gap-1.5 sm:gap-2">
        {STEPS.map((s, i) => {
          const done = i < reached && i !== current;
          const active = i === current;
          const reachable = i <= reached;
          return (
            <li key={s.key} className="min-w-0">
              <button
                type="button"
                disabled={!reachable || active}
                onClick={() => onSelect(i)}
                aria-current={active ? "step" : undefined}
                aria-label={`Step ${i + 1} of ${STEPS.length}: ${s.label}${done ? ", done" : active ? ", current" : reachable ? "" : ", locked"}`}
                className={cn(
                  "group relative flex w-full flex-col items-start gap-2 rounded-lg pt-3 text-left transition-colors disabled:cursor-default",
                  reachable && !active && "cursor-pointer",
                )}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-[3px] overflow-hidden rounded-full bg-wire"
                >
                  <span
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-[cubic-bezier(0.25,1,0.5,1)]",
                      done ? "w-full bg-conserved" : active ? "w-1/2 bg-conserved shadow-[0_0_12px_var(--status-conserved)]" : "w-0",
                    )}
                  />
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-2xs font-semibold tnum transition-[background-color,border-color,box-shadow] duration-300",
                      done && "border-transparent bg-conserved text-on-status",
                      active && "border-conserved bg-conserved/10 text-conserved shadow-[0_0_0_4px_color-mix(in_oklab,var(--status-conserved)_14%,transparent)]",
                      !done && !active && "border-wire bg-inset text-subtle",
                      reachable && !active && "group-hover:border-line-strong",
                    )}
                  >
                    {done ? <Check className="size-3.5" strokeWidth={3} aria-hidden="true" /> : i + 1}
                  </span>
                  <span className={cn("hidden truncate text-sm font-medium md:inline", active ? "text-fg" : done ? "text-muted group-hover:text-fg" : "text-subtle")}>{s.label}</span>
                </span>
                <span className="hidden truncate text-xs text-subtle xl:block">{s.hint}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-sm font-medium text-fg md:hidden">
        <span className="font-mono text-subtle tnum">
          {current + 1}/{STEPS.length}
        </span>{" "}
        {STEPS[current]?.label}
      </p>
    </nav>
  );
}
