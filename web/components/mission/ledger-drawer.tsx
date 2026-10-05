"use client";

import { ArrowRight, CheckCircle2, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ChainKey, TokenStatusResponse } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import { blockUrl, escrowBalanceUrl, readContractUrl, tokenUrl } from "@/lib/explorer";
import { formatAmount, formatDateTime, formatTime, parseWei } from "@/lib/format";
import { useVerifyLedger } from "@/lib/onchain";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AddressLink, TxLink, Verifiable } from "@/components/kh/links";
import { StatusWord } from "@/components/kh/status";
import { Banner } from "@/components/kh/banner";
import { transferTime } from "@/components/mission/geometry";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-right text-sm">{children}</dd>
    </div>
  );
}

export function VerifyOnchainButton({ status, chain }: { status: TokenStatusResponse; chain: ChainKey }) {
  const c = status.chains.find((x) => x.chain === chain);
  const verify = useVerifyLedger(chain);
  if (!c) return null;
  const expected = { status: c.ledgerStatus, delta: parseWei(status.token.delta), updatedAt: Math.floor(Date.parse(status.token.updatedAt) / 1000), stale: status.token.stale };
  const r = verify.data;
  const matches = r ? r.status === expected.status && r.delta === expected.delta : null;
  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" onClick={() => verify.mutate({ ledger: c.contracts.ledger, tokenId: status.token.tokenId, expected })} disabled={verify.isPending}>
        <ShieldCheck aria-hidden="true" />
        {verify.isPending ? "Reading ledger…" : "Verify onchain"}
      </Button>
      {verify.isError ? (
        <p className="text-xs text-drift" role="alert">
          {CHAINS[chain].name} read failed: {verify.error.message}
        </p>
      ) : null}
      {r ? (
        <p className={`flex items-center gap-1.5 text-xs ${matches ? "text-conserved" : "text-drift"}`} role="status">
          {matches ? <CheckCircle2 className="size-3.5" aria-hidden="true" /> : <TriangleAlert className="size-3.5" aria-hidden="true" />}
          statusOf: {r.status}, Δ {formatAmount(r.delta, { decimals: status.token.decimals, signed: true })}
          {r.via === "rpc" ? ` at block ${r.blockNumber.toString()}` : " (fixture read, no live contract)"}
          {matches ? ". Matches the mirror." : ". Differs from the mirror."}
        </p>
      ) : null}
    </div>
  );
}

export function LedgerDrawer({ status, chain, onClose, returnFocusTo }: { status: TokenStatusResponse; chain: ChainKey | null; onClose: () => void; returnFocusTo?: HTMLElement | null }) {
  const c = chain ? status.chains.find((x) => x.chain === chain) : undefined;
  const d = status.token.decimals;
  const sym = status.token.symbol;
  const transfers = c
    ? status.lanes
        .filter((l) => l.srcChain === c.chain || l.dstChain === c.chain)
        .flatMap((l) => l.recentTransfers)
        .sort((a, b) => transferTime(b) - transferTime(a))
        .slice(0, 12)
    : [];
  return (
    <Sheet open={c !== undefined} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      {c ? (
        <SheetContent returnFocusTo={returnFocusTo ?? null} title={`${CHAINS[c.chain].name} ledger`} description={`${c.role === "home" ? "Home chain" : "Remote chain"} · ${c.confidence} confidence · pinned block ${Number(c.pinnedBlock.number).toLocaleString("en-US")}`}>
          <div className="space-y-6 px-5 py-5">
            {!c.read.ok ? (
              <Banner tone="error">
                {CHAINS[c.chain].name} RPC: {c.read.error}.{c.read.lastGoodBlock ? ` Values below are from block ${c.read.lastGoodBlock.number}.` : ""}
              </Banner>
            ) : null}
            <div className="flex items-center justify-between">
              <StatusWord status={c.ledgerStatus} className="text-base" />
              <VerifyOnchainButton status={status} chain={c.chain} />
            </div>
            <dl className="divide-y divide-wire/70 border-y border-wire/70">
              <Field label={c.role === "home" ? "Circulating outside escrow" : "Supply"}>
                <Verifiable href={tokenUrl(c.chain, c.contracts.token)} label="Token contract" className="font-mono">
                  {formatAmount(parseWei(c.supply), { decimals: d })} {sym}
                </Verifiable>
              </Field>
              {c.escrow !== null && c.contracts.escrow ? (
                <Field label="Escrow (backing)">
                  <Verifiable href={escrowBalanceUrl(c.chain, c.contracts.token, c.contracts.escrow)} label="Escrow balance" className="font-mono">
                    {formatAmount(parseWei(c.escrow), { decimals: d })} {sym}
                  </Verifiable>
                </Field>
              ) : null}
              <Field label="In flight out">
                <Verifiable href={readContractUrl(c.chain, c.contracts.ledger)} label="Ledger read" className="font-mono">
                  {formatAmount(parseWei(c.inFlightOut), { decimals: d })}
                </Verifiable>
              </Field>
              <Field label="In flight in">
                <Verifiable href={readContractUrl(c.chain, c.contracts.ledger)} label="Ledger read" className="font-mono">
                  {formatAmount(parseWei(c.inFlightIn), { decimals: d })}
                </Verifiable>
              </Field>
              <Field label="Pinned block">
                <Verifiable href={blockUrl(c.chain, c.pinnedBlock.number)} label="Block" className="font-mono">
                  {Number(c.pinnedBlock.number).toLocaleString("en-US")}
                </Verifiable>
                <span className="ml-2 text-xs text-subtle">{formatDateTime(c.pinnedBlock.timestamp)}</span>
              </Field>
              <Field label="CCIP lanes">{c.frozen ? <span className="text-quarantined">Frozen</span> : <span className="text-muted">Open</span>}</Field>
            </dl>
            <div>
              <h3 className="mb-2 text-xs font-medium text-subtle">Contracts</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                {(
                  [
                    ["Token", c.contracts.token],
                    ["ConservationLedger", c.contracts.ledger],
                    ["ConservationFeed", c.contracts.feed],
                    ["QuarantineController", c.contracts.quarantineController],
                    ["HomeEscrowAdapter", c.contracts.escrow],
                    ["KirchhoffGuard", c.contracts.guard],
                  ] as const
                ).map(([label, addr]) =>
                  addr ? (
                    <div key={label} className="contents">
                      <dt className="text-muted">{label}</dt>
                      <dd className="text-right">
                        <AddressLink chain={c.chain} address={addr} read={label !== "Token"} />
                      </dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-medium text-subtle">Recent transfers touching {CHAINS[c.chain].short}</h3>
              {transfers.length === 0 ? (
                <p className="text-sm text-muted">No transfers yet.</p>
              ) : (
                <ul className="divide-y divide-wire/70 rounded-lg border border-wire">
                  {transfers.map((t) => {
                    const tx = t.creditTx ?? t.debitTx;
                    return (
                      <li key={`${t.messageId}-${t.state}`} className="flex items-center gap-3 px-3 py-2 text-xs">
                        <span className="w-14 font-mono text-subtle">{tx ? formatTime(tx.timestamp) : ""}</span>
                        <span className="flex items-center gap-1 text-muted">
                          {CHAINS[t.srcChain].short}
                          <ArrowRight className="size-3" aria-hidden="true" />
                          {CHAINS[t.dstChain].short}
                        </span>
                        <span className={t.state === "forged" || t.state === "refused" ? "text-broken" : "text-subtle"}>{t.state.replace("_", " ")}</span>
                        <span className="ml-auto font-mono text-fg">{formatAmount(parseWei(t.amount), { decimals: d })}</span>
                        {tx ? <TxLink tx={tx} /> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}
