"use client";

import { useState } from "react";
import { DATA_SOURCE } from "@/lib/api/client";
import { getIssuerKey, setIssuerKey } from "@/lib/issuer-key";

import { isAddress } from "viem";
import { CHAIN_KEYS, type ChainKey } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import type { DescribeInput } from "@/components/onboard/model";
import { cn } from "@/lib/utils";

const field =
  "w-full rounded-lg border border-wire bg-inset px-3.5 text-sm text-fg shadow-[inset_0_1px_2px_rgb(0_0_0/0.25)] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-subtle hover:border-line-strong focus-visible:border-conserved focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--status-conserved)_22%,transparent)]";

export function describeErrors(v: DescribeInput): { description: string | null; address: string | null } {
  return {
    description: v.description.trim().length < 12 ? "A sentence or two. Name the token, its home chain and its bridges." : null,
    address: v.address.trim().length === 0 ? "Paste the canonical token address." : !isAddress(v.address.trim(), { strict: false }) ? "Not a valid EVM address." : null,
  };
}

function IssuerKeyField() {
  const [key, setKey] = useState(() => getIssuerKey() ?? "");
  if (DATA_SOURCE !== "api") return null;
  return (
    <div className="space-y-2">
      <label htmlFor="onboard-issuer-key" className="text-sm font-medium text-fg">
        Issuer API key
      </label>
      <input
        id="onboard-issuer-key"
        type="password"
        autoComplete="off"
        value={key}
        onChange={(e) => {
          setKey(e.target.value);
          setIssuerKey(e.target.value);
        }}
        placeholder="kh_live_..."
        className="h-10 w-full rounded-md border border-wire bg-inset px-3 font-mono text-sm text-fg outline-none placeholder:text-subtle focus-visible:border-line-strong"
      />
      <p className="text-xs text-subtle">Kept in this tab only. The Copilot and the backtest run under it</p>
    </div>
  );
}

export function StepDescribe({ value, onChange, showErrors }: { value: DescribeInput; onChange: (v: DescribeInput) => void; showErrors: boolean }) {
  const errors = describeErrors(value);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <IssuerKeyField />
        <div className="space-y-2">
          <label htmlFor="onboard-description" className="flex items-baseline justify-between text-sm font-medium text-fg">
            The token, in plain words
            <span className="font-mono text-xs font-normal text-subtle tnum">{value.description.length}/600</span>
          </label>
          <textarea
            id="onboard-description"
            rows={4}
            maxLength={600}
            value={value.description}
            onChange={(e) => onChange({ ...value, description: e.target.value })}
            aria-invalid={showErrors && errors.description !== null}
            aria-describedby="onboard-description-hint"
            className={cn(field, "min-h-28 resize-y py-3 leading-relaxed")}
          />
          <p id="onboard-description-hint" className={cn("text-xs", showErrors && errors.description ? "text-broken" : "text-subtle")}>
            {showErrors && errors.description ? errors.description : "Home chain, remote chains, every bridge that can mint it."}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
          <div className="space-y-2">
            <label htmlFor="onboard-chain" className="text-sm font-medium text-fg">
              Home chain
            </label>
            <select id="onboard-chain" value={value.chain} onChange={(e) => onChange({ ...value, chain: e.target.value as ChainKey })} className={cn(field, "h-11 cursor-pointer")}>
              {CHAIN_KEYS.map((c) => (
                <option key={c} value={c}>
                  {CHAINS[c].name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label htmlFor="onboard-address" className="text-sm font-medium text-fg">
              Canonical token address
            </label>
            <input
              id="onboard-address"
              value={value.address}
              onChange={(e) => onChange({ ...value, address: e.target.value })}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={showErrors && errors.address !== null}
              aria-describedby="onboard-address-hint"
              className={cn(field, "h-11 font-mono tnum")}
            />
            <p id="onboard-address-hint" className={cn("text-xs", showErrors && errors.address ? "text-broken" : "text-subtle")}>
              {showErrors && errors.address ? errors.address : `The ERC-20 on ${CHAINS[value.chain].name} that the escrow backs.`}
            </p>
          </div>
        </div>
      </div>
      <aside className="relative overflow-hidden rounded-xl border border-wire bg-inset p-5 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-conserved/10 blur-3xl" />
        <h3 className="text-sm font-semibold text-fg">What happens next</h3>
        <ol className="mt-3 space-y-3 text-sm text-muted">
          <li className="flex gap-3">
            <span className="font-mono text-xs text-subtle tnum">2</span>
            <span>Copilot reads explorers and contracts. Read-only tools, every result cited.</span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs text-subtle tnum">3</span>
            <span>You review a KIRCH-SPEC draft. Lines without evidence stay red.</span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs text-subtle tnum">4</span>
            <span>The engine replays real history. One BROKEN blocks activation.</span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-xs text-subtle tnum">5</span>
            <span>Your Safe proposes the spec hash. A timelock runs before it goes live.</span>
          </li>
        </ol>
        <p className="mt-4 border-t border-wire pt-3 text-xs text-subtle">AI drafts. Humans approve. The Copilot cannot sign or propose anything.</p>
      </aside>
    </div>
  );
}
