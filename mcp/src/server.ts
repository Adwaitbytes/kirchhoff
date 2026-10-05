import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAINS, CHAIN_KEYS, txUrl, type ChainKey } from "@kirchhoff/sdk";
import { BackendError, type KirchhoffBackend } from "./backend.ts";

/**
 * KIRCHHOFF MCP server (PRD section 13). Five read-only tools. The descriptions instruct agents
 * to call kirchhoff_check_transfer before any cross-chain move of a protected token and to stop
 * when would_pass is false.
 */

const chainEnum = z.enum(CHAIN_KEYS as [ChainKey, ...ChainKey[]]);
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(summary: string, data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: `${summary}\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
}

function fail(e: unknown): ToolResult {
  const message = e instanceof BackendError ? `${e.code}: ${e.message}` : `KIRCHHOFF is unreachable: ${e instanceof Error ? e.message : String(e)}`;
  return { content: [{ type: "text", text: `${message}\nTreat the token as unsafe to move until KIRCHHOFF answers.` }], isError: true };
}

function ageSeconds(servedAt: string, updatedAt: string): number {
  return Math.max(0, Math.round((Date.parse(servedAt) - Date.parse(updatedAt)) / 1000));
}

export function createKirchhoffMcp(backend: KirchhoffBackend): McpServer {
  const server = new McpServer(
    { name: "kirchhoff", version: "0.1.0" },
    {
      instructions:
        "KIRCHHOFF verifies that cross-chain tokens add up across every chain. Before ANY cross-chain move of a protected token, call kirchhoff_check_transfer. If would_pass is false, STOP and do not send the transfer by any bridge. All tools are read-only; KIRCHHOFF never moves funds.",
    },
  );

  server.registerTool(
    "kirchhoff_list_tokens",
    {
      title: "List protected tokens",
      description: "Lists every token protected by KIRCHHOFF with its current conservation status. Use it to learn which tokens need kirchhoff_check_transfer before moving them.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const r = await backend.tokens();
        const tokens = r.items.map((t) => ({ symbol: t.symbol, status: t.status, reason: t.reason, chains: t.chains, delta: t.delta, stale: t.stale, simulation: t.simulation }));
        return ok(`${tokens.length} protected token(s).`, { tokens, source: r.source, ledger: r.ledger, block: r.block });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "kirchhoff_status",
    {
      title: "Token conservation status",
      description:
        "Conservation status of a protected token: CONSERVED, DRIFT, BROKEN, QUARANTINED, RECOVERING or UNKNOWN, with the deficit (delta, base units), its age, and a per-chain summary (supply, ledger status, frozen lanes). BROKEN or QUARANTINED means do not move it. Always confirm a specific move with kirchhoff_check_transfer.",
      inputSchema: { token: z.string().regex(/^[A-Za-z0-9]{1,16}$/).describe("Token symbol, e.g. kETH") },
      annotations: READ_ONLY,
    },
    async ({ token }) => {
      try {
        const s = await backend.status(token);
        const data = {
          token: s.token.symbol,
          status: s.token.status,
          reason: s.token.reason,
          delta: s.token.delta,
          ageSeconds: ageSeconds(s.servedAt, s.token.updatedAt),
          stale: s.token.stale,
          activeIncidentId: s.token.activeIncidentId,
          chains: s.chains.map((c) => ({ chain: c.chain, role: c.role, supply: c.supply, ledgerStatus: c.ledgerStatus, frozen: c.frozen, readOk: c.read.ok })),
          source: s.source,
          ledger: s.ledger,
          block: s.block,
        };
        return ok(`${s.token.symbol} is ${s.token.status} (${s.token.reason}).`, data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "kirchhoff_check_transfer",
    {
      title: "Check a cross-chain transfer before sending it",
      description:
        "CALL THIS BEFORE ANY CROSS-CHAIN MOVE of a protected token, on any bridge. Dry-runs the transfer against current onchain conservation status and returns would_pass, a reason code and an advice line. If would_pass is false, STOP: do not send the transfer by CCIP or any other bridge, and tell the user why.",
      inputSchema: {
        token: z.string().regex(/^[A-Za-z0-9]{1,16}$/).describe("Token symbol, e.g. kETH"),
        src_chain: chainEnum.describe("Source chain (CRE chain name)"),
        dst_chain: chainEnum.describe("Destination chain (CRE chain name)"),
        amount: z.string().regex(/^\d{1,78}$/).describe("Amount in base units as a decimal string"),
        sender: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Sender address"),
      },
      annotations: READ_ONLY,
    },
    async ({ token, src_chain, dst_chain, amount, sender }) => {
      try {
        const r = await backend.checkTransfer({ token, srcChain: src_chain, dstChain: dst_chain, amount, sender: sender.toLowerCase() as `0x${string}` });
        const data = { would_pass: r.wouldPass, reason: r.reason, advice: r.advice, status: r.status, source: r.source, ledger: r.ledger, block: r.block };
        return ok(r.wouldPass ? `would_pass: true. ${r.advice}` : `would_pass: false. STOP: do not send this transfer. ${r.advice}`, data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "kirchhoff_explain_verdict",
    {
      title: "Explain a Judge verdict",
      description: "Explains the KIRCHHOFF Judge verdict for one CCIP message: PASS or FAIL, the reason code, the committee cells, and explorer links to the source debit and the execution.",
      inputSchema: { message_id: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("CCIP message id (bytes32)") },
      annotations: READ_ONLY,
    },
    async ({ message_id }) => {
      try {
        const v = await backend.verdict(message_id);
        if (!v) return ok(`No KIRCHHOFF verdict recorded for ${message_id}.`, { messageId: message_id, found: false });
        const data = {
          found: true,
          messageId: v.messageId,
          decision: v.decision,
          reason: v.reason,
          note: v.note,
          route: `${CHAINS[v.srcChain].label} to ${CHAINS[v.dstChain].label}`,
          amount: v.amount,
          cells: v.cells,
          incidentId: v.incidentId,
          evidence: [
            { label: "source debit", href: txUrl(v.sourceTx.chain, v.sourceTx.hash) },
            ...(v.executionTx ? [{ label: "execution", href: txUrl(v.executionTx.chain, v.executionTx.hash) }] : []),
          ],
        };
        return ok(`${v.decision} ${v.reason}: ${v.note}`, data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "kirchhoff_incident",
    {
      title: "Incident narrative and evidence",
      description: "An incident's narrative (AI summary labeled for verification, or the deterministic template) plus its evidence items with explorer links, containment actions and blast radius.",
      inputSchema: { incident_id: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("Incident id (bytes32)") },
      annotations: READ_ONLY,
    },
    async ({ incident_id }) => {
      try {
        const r = await backend.incident(incident_id);
        const data = {
          incident: r.incident,
          narrative: r.narrative ? { label: r.narrative.label, generator: r.narrative.generator, summary: r.narrative.summary, nextSteps: r.narrative.nextSteps } : null,
          evidence: r.evidence.map((e) => ({ id: e.id, kind: e.kind, label: e.label, href: e.tx ? txUrl(e.tx.chain, e.tx.hash) : null })),
          actions: r.actions.map((a) => ({ kind: a.kind, applied: a.applied })),
          blastRadius: r.blastRadius,
          tokenStatus: r.tokenStatus,
        };
        const summary = r.narrative ? r.narrative.summary.map((s) => s.text).join(" ") : `${r.incident.token} ${r.incident.reason}`;
        return ok(`${r.narrative?.label ?? "Evidence"} ${summary}`, data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
