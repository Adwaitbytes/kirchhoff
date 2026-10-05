"use client";

import { TriangleAlert } from "lucide-react";
import type { ChainKey, ChainSupply, TokenStatusResponse } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import { blockUrl, escrowBalanceUrl, readContractUrl, tokenUrl } from "@/lib/explorer";
import { formatAmount, parseWei } from "@/lib/format";
import { Verifiable } from "@/components/kh/links";
import { StatusWord } from "@/components/kh/status";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function Amount({ value, decimals, href, label }: { value: string | null; decimals: number; href: string; label: string }) {
  if (value === null) return <span className="text-subtle">n/a</span>;
  const v = parseWei(value);
  return (
    <Verifiable href={href} label={label} className={cn("font-mono", v === 0n ? "text-subtle" : "text-fg")}>
      {formatAmount(v, { decimals, maxFraction: 2 })}
    </Verifiable>
  );
}

export function LedgerTable({ status, onOpenChain }: { status: TokenStatusResponse; onOpenChain: (c: ChainKey) => void }) {
  const { token } = status;
  const d = token.decimals;
  const row = (c: ChainSupply) => {
    const ledgerRead = readContractUrl(c.chain, c.contracts.ledger);
    const inFlight = (parseWei(c.inFlightOut) + parseWei(c.inFlightIn)).toString();
    return (
      <tr key={c.chain} className={cn("group border-b border-wire/70 last:border-0", !c.read.ok && "bg-drift/[0.06]")}>
        <th scope="row" className="py-2 pl-4 pr-3 text-left font-normal">
          <span className="flex items-baseline gap-2 whitespace-nowrap">
            <button type="button" onClick={() => onOpenChain(c.chain)} className="flex cursor-pointer items-center gap-1.5 rounded-sm text-sm font-medium text-fg hover:underline">
              {CHAINS[c.chain].name}
              {!c.read.ok ? <TriangleAlert className="size-3.5 text-drift" aria-label="RPC error" /> : null}
            </button>
            <span className="hidden text-xs text-subtle 2xl:inline">{c.role === "home" ? "home" : "remote"} · {c.confidence}</span>
          </span>
        </th>
        <td className="px-3 text-right">
          <Amount value={c.supply} decimals={d} href={tokenUrl(c.chain, c.contracts.token)} label={`${CHAINS[c.chain].name} supply, token contract`} />
        </td>
        <td className="px-3 text-right">
          <Amount value={c.escrow} decimals={d} href={c.contracts.escrow ? escrowBalanceUrl(c.chain, c.contracts.token, c.contracts.escrow) : ledgerRead} label={`${CHAINS[c.chain].name} escrow balance`} />
        </td>
        <td className="px-3 text-right">
          <Amount value={inFlight} decimals={d} href={ledgerRead} label={`${CHAINS[c.chain].name} in flight, ledger read`} />
        </td>
        <td className="px-3 text-right">
          <Verifiable href={blockUrl(c.chain, c.pinnedBlock.number)} label={`Pinned block ${c.pinnedBlock.number} on ${CHAINS[c.chain].name}`} className="font-mono text-xs text-muted">
            {Number(c.pinnedBlock.number).toLocaleString("en-US")}
          </Verifiable>
        </td>
        <td className="py-2 pl-3 pr-4 text-right">
          <StatusWord status={c.ledgerStatus} className="text-xs" />
        </td>
      </tr>
    );
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <ul className="divide-y divide-wire/70 sm:hidden" aria-label={`Per-chain ledger for ${token.symbol}`}>
        {status.chains.map((c) => {
          const ledgerRead = readContractUrl(c.chain, c.contracts.ledger);
          const inFlight = (parseWei(c.inFlightOut) + parseWei(c.inFlightIn)).toString();
          return (
            <li key={c.chain} className={cn("px-4 py-3", !c.read.ok && "bg-drift/[0.06]")}>
              <div className="flex items-center justify-between gap-3">
                <button type="button" onClick={() => onOpenChain(c.chain)} className="flex cursor-pointer items-center gap-1.5 text-sm font-medium text-fg hover:underline">
                  {CHAINS[c.chain].name}
                  {!c.read.ok ? <TriangleAlert className="size-3.5 text-drift" aria-label="RPC error" /> : null}
                </button>
                <StatusWord status={c.ledgerStatus} className="text-xs" />
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <dt className="text-subtle">Supply</dt>
                <dd className="text-right">
                  <Amount value={c.supply} decimals={d} href={tokenUrl(c.chain, c.contracts.token)} label={`${CHAINS[c.chain].name} supply`} />
                </dd>
                {c.escrow !== null ? (
                  <>
                    <dt className="text-subtle">Escrow</dt>
                    <dd className="text-right">
                      <Amount value={c.escrow} decimals={d} href={c.contracts.escrow ? escrowBalanceUrl(c.chain, c.contracts.token, c.contracts.escrow) : ledgerRead} label="Escrow balance" />
                    </dd>
                  </>
                ) : null}
                <dt className="text-subtle">In flight</dt>
                <dd className="text-right">
                  <Amount value={inFlight} decimals={d} href={ledgerRead} label="In flight, ledger read" />
                </dd>
                <dt className="text-subtle">Pinned block</dt>
                <dd className="text-right">
                  <Verifiable href={blockUrl(c.chain, c.pinnedBlock.number)} label="Pinned block" className="font-mono text-muted">
                    {Number(c.pinnedBlock.number).toLocaleString("en-US")}
                  </Verifiable>
                </dd>
              </dl>
            </li>
          );
        })}
      </ul>
      <table className="hidden w-full text-sm tnum sm:table">
        <caption className="sr-only">Per-chain ledger for {token.symbol} at the latest epoch</caption>
        <thead>
          <tr className="whitespace-nowrap border-b border-wire font-mono text-2xs uppercase tracking-[0.12em] text-subtle">
            <th scope="col" className="py-2 pl-4 pr-3 text-left font-medium">Chain</th>
            <th scope="col" className="px-3 text-right font-medium">Supply</th>
            <th scope="col" className="px-3 text-right font-medium">Escrow</th>
            <th scope="col" className="px-3 text-right font-medium">In flight</th>
            <th scope="col" className="px-3 text-right font-medium">Pinned block</th>
            <th scope="col" className="py-2 pl-3 pr-4 text-right font-medium">Ledger</th>
          </tr>
        </thead>
        <tbody>{status.chains.map(row)}</tbody>
      </table>
    </div>
  );
}

export function LedgerTableSkeleton() {
  return (
    <div className="flex-1 space-y-0 px-4 py-2" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="grid h-12 grid-cols-[1.4fr_1fr_1fr_1fr_1fr_0.8fr] items-center gap-4 border-b border-wire/70">
          <Skeleton className="h-3.5 w-28" />
          {Array.from({ length: 5 }, (_, j) => (
            <Skeleton key={j} className="ml-auto h-3.5 w-16" />
          ))}
        </div>
      ))}
    </div>
  );
}
