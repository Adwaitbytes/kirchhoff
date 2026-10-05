import { CHAINS, type ReplayPlanMessage, type ReplayPlanResponse, type TokenStatus } from "@kirchhoff/sdk";
import type { IncidentBundle } from "@kirchhoff/ai";

/**
 * Held-message replay plan (PRD section 3 nice-to-have, section 6 replay_requires: issuer_multisig).
 * The API prepares; it never sends. Replay is allowed only once the token is CONSERVED again, and
 * messages from tainted senders stay held.
 *
 * `calls` is empty by design: re-executing a CCIP 2.0 message is done with ccip-cli manual-exec
 * (docs/research/ccip.md, ccv.md), which builds the OffRamp call itself; we do not hand-encode
 * OffRamp calldata against an ABI we have not verified. The per-message notes carry the exact
 * commands for the issuer's operator to run after the Safe signers approve the plan.
 */

export type ReplayContext = {
  enforcement: "ccv_cell" | "token_pool_fallback";
  aggregatorUrl: string | null;
};

export function replayPlan(bundle: IncidentBundle, tokenStatus: TokenStatus, ctx: ReplayContext): Omit<ReplayPlanResponse, "source" | "ledger" | "block" | "servedAt"> {
  const allowed = tokenStatus === "CONSERVED";
  const tainted = new Set(bundle.blastRadius.flatMap((b) => b.taintedAddresses.map((a) => a.toLowerCase())));
  const refusedById = new Map(bundle.refused.map((v) => [v.messageId.toLowerCase(), v]));
  const messages: ReplayPlanMessage[] = bundle.heldMessages.map((m) => {
    const base = { messageId: m.messageId, srcChain: m.srcChain, dstChain: m.dstChain, amount: m.amount, sender: m.sender };
    if (tainted.has(m.sender.toLowerCase())) {
      return { ...base, action: "skip", note: `Sender ${m.sender} is tainted by this incident; the message stays held until the issuer Safe untaints it.` };
    }
    if (ctx.enforcement === "token_pool_fallback") {
      return {
        ...base,
        action: "skip",
        note: "Refused at the source by KirchhoffTokenPool (Fallback B): no CCIP message was sent, so there is nothing to execute. The sender resends after recovery.",
      };
    }
    const srcTx = refusedById.get(m.messageId.toLowerCase())?.sourceTx.hash ?? "<source tx>";
    const agg = ctx.aggregatorUrl ?? "grpcs://<kirchhoff-aggregator>:443";
    return {
      ...base,
      action: "replay",
      note: [
        "After the issuer Safe approves this plan:",
        `1) on every KIRCHHOFF cell: /bin/verifier ccv job-queue reschedule --queue task-verifier --verifier-id <verifier-id> --message-id ${m.messageId}`,
        `2) ccip-cli manual-exec ${srcTx} --verifiers ${agg}`,
        `3) ccip-cli show ${m.messageId} --rpcs <${CHAINS[m.dstChain].label} RPC> --json (expect status SUCCESS)`,
      ].join(" "),
    };
  });
  return {
    incidentId: bundle.incident.id,
    allowed,
    reason: allowed ? null : `Replay opens once ${bundle.incident.token} is CONSERVED again; it is ${tokenStatus} now.`,
    tokenStatus,
    issuerSafe: bundle.resolution.issuerSafe,
    messages,
    calls: [],
  };
}
