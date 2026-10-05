"use client";

import { useState } from "react";
import { Database, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useFixtures } from "@/lib/api/provider";
import { FIXTURE_SCENARIOS } from "@/lib/api/fixtures";

/**
 * Persistent marker shown whenever the app runs on fixture data. It is never hidden, including
 * in stage mode, so fixture numbers can never pass for onchain data. The scenario controls are
 * dev controls and hide in stage mode.
 */
export function FixtureBar() {
  const fixtures = useFixtures();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  if (!fixtures) return null;

  const go = (scenario: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("scenario", scenario);
    window.location.assign(url.toString());
  };

  return (
    <div className="pointer-events-none fixed bottom-[72px] right-3 z-[60] flex flex-col items-end gap-2 md:bottom-3">
      {open ? (
        <div data-dev-control="" className="pointer-events-auto w-64 rounded-lg border border-wire bg-panel p-2 shadow-pop">
          <p className="px-2 pb-1.5 pt-1 text-xs font-medium text-muted">Fixture scenario</p>
          <div className="grid grid-cols-2 gap-1">
            {FIXTURE_SCENARIOS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => go(s)}
                className={`cursor-pointer rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-raised ${s === fixtures.scenario ? "bg-raised text-fg" : "text-muted"}`}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              fixtures.world.reset();
              void qc.invalidateQueries();
            }}
            className="mt-1.5 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-raised hover:text-fg"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Reset fixture world (demo/reset)
          </button>
        </div>
      ) : null}
      <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-drift/40 bg-panel/95 py-1 pl-2.5 pr-1 text-xs shadow-pop backdrop-blur">
        <Database className="size-3.5 text-drift" aria-hidden="true" />
        <span className="font-medium text-fg">Fixture data</span>
        <span className="hidden text-muted sm:inline">· dev mode, not onchain</span>
        <button
          type="button"
          data-dev-control=""
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label="Fixture scenarios"
          className="ml-1 cursor-pointer rounded p-1 text-muted hover:bg-raised hover:text-fg"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
