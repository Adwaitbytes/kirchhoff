"use client";

import { useMemo, useState } from "react";
import { encodeFunctionData } from "viem";
import { ArrowUpRight, Check, Copy, ShieldCheck } from "lucide-react";
import type { IncidentResponse } from "@/lib/api/types";
import { quarantineControllerAbi } from "@/lib/abi";
import { CHAINS } from "@/lib/chains";
import { safeQueueUrl, safeTxBuilderUrl } from "@/lib/explorer";
import { formatDateTime } from "@/lib/format";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AddressLink } from "@/components/kh/links";

function resolveBlockedReason(r: IncidentResponse): string {
  if (r.incident.status === "recovering" && r.incident.recoveryEndsAt) return `Resolved. Recovery timelock ends ${formatDateTime(r.incident.recoveryEndsAt)}`;
  if (r.incident.status === "resolved") return "Incident closed";
  if (r.tokenStatus === "BROKEN") return "Opens once quarantine lands onchain";
  return `Resolve needs QUARANTINED. Now ${r.tokenStatus}`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => {
            setState("copied");
            window.setTimeout(() => setState("idle"), 1_600);
          },
          (e: unknown) => {
            console.warn("Clipboard write failed", e);
            setState("failed");
          },
        );
      }}
      aria-label={label}
    >
      {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {state === "copied" ? "Copied" : state === "failed" ? "Copy blocked" : "Copy"}
    </Button>
  );
}

export function ResolveIncident({ r }: { r: IncidentResponse }) {
  const { resolution, incident } = r;
  const calldata = useMemo(
    () => encodeFunctionData({ abi: quarantineControllerAbi, functionName: "resolve", args: [incident.tokenId, incident.id] }),
    [incident.tokenId, incident.id],
  );
  const chain = resolution.chain;
  if (!resolution.canResolve) {
    return (
      <div className="flex flex-col items-start gap-1">
        <Button variant="primary" disabled data-testid="resolve-incident" aria-describedby="resolve-reason">
          <ShieldCheck aria-hidden="true" />
          Resolve incident
        </Button>
        <span id="resolve-reason" className="text-xs text-muted">
          {resolveBlockedReason(r)}
        </span>
      </div>
    );
  }
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="primary" data-testid="resolve-incident">
          <ShieldCheck aria-hidden="true" />
          Resolve incident
        </Button>
      </DialogTrigger>
      <DialogContent title="Resolve via issuer Safe" description="Starts RECOVERING. Lanes stay frozen until the timelock ends and a fresh epoch shows Δ of zero or more." className="w-[min(640px,calc(100vw-32px))]">
        <div className="space-y-4 px-5 py-5">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-sm">
            <dt className="text-muted">Chain</dt>
            <dd className="text-right text-fg">{CHAINS[chain].name}</dd>
            <dt className="text-muted">Issuer Safe</dt>
            <dd className="text-right">
              <AddressLink chain={chain} address={resolution.issuerSafe} />
            </dd>
            <dt className="text-muted">To</dt>
            <dd className="text-right">
              <span className="mr-2 text-xs text-subtle">QuarantineController</span>
              <AddressLink chain={chain} address={resolution.quarantineController} read />
            </dd>
            <dt className="text-muted">Value</dt>
            <dd className="text-right font-mono text-fg">0</dd>
            <dt className="text-muted">Function</dt>
            <dd className="truncate text-right font-mono text-xs text-fg">resolve(bytes32 tokenId, bytes32 incidentId)</dd>
          </dl>
          <div className="rounded-lg border border-wire bg-inset">
            <div className="flex items-center justify-between border-b border-wire px-3 py-1.5">
              <span className="text-xs font-medium text-muted">Calldata</span>
              <CopyButton value={calldata} label="Copy calldata" />
            </div>
            <pre data-testid="resolve-calldata" className="max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-xs leading-relaxed text-fg">
              {calldata}
            </pre>
          </div>
          <p className="text-xs text-muted">Paste the calldata into the Safe Transaction Builder. KIRCHHOFF never signs; only the issuer Safe can start recovery.</p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={safeQueueUrl(chain, resolution.issuerSafe)} target="_blank" rel="noopener noreferrer">
                Safe queue <ArrowUpRight aria-hidden="true" />
              </a>
            </Button>
            <Button asChild variant="primary" size="sm">
              <a href={safeTxBuilderUrl(chain, resolution.issuerSafe)} target="_blank" rel="noopener noreferrer">
                Open in Safe <ArrowUpRight aria-hidden="true" />
              </a>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
