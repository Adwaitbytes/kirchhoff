import { CHAINS, isChainKey, txUrl, addressUrl, type AskCitation, type AskEvent, type AskRequest } from "@kirchhoff/sdk";
import { UNTRUSTED_POLICY, houseStyle, parseModelJson, untrusted, validateJson } from "./guard.ts";
import type { ChatMessage, JsonSchema, LlmProvider, ToolDef } from "./provider.ts";

/**
 * Ask KIRCHHOFF (PRD section 11 feature 4): questions over the read model with a read-only SQL
 * tool and the evidence store. Answers cite rows and transactions that appeared in tool results.
 */

export type SqlResult = { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean };

export interface AskBackend {
  /** Runs one SELECT as the read-only role over the `ask` views. Must reject anything else. */
  sql(query: string, signal?: AbortSignal): Promise<SqlResult>;
  /** The deterministic evidence bundle of an incident, or null. */
  evidence(incidentId: string): Promise<unknown>;
}

export const ASK_VIEWS = `Views (schema "ask"; amounts are base-unit numerics, 18 decimals for kETH):
tokens(symbol, token_id, status, reason, delta, epoch_id, updated_at, stale, active_incident_id, spec_hash, home_chain, chains)
chains(chain, selector, role, ledger, quarantine, feed, token, escrow, weak_bridge, ccip_pool)
chain_state(chain, block, block_time, supply, escrow, ledger_status, ledger_delta, frozen, read_ok, read_error)
debits(chain, tx_hash, block, block_time, bridge, message_id, src_chain, dst_chain, amount, sender, recipient)
credits(chain, tx_hash, block, block_time, bridge, message_id, dst_chain, claimed_src_chain, amount, recipient)
matches(message_id, bridge, src_chain, dst_chain, amount, debit_tx, credit_tx, state)   -- state: in_flight|settled|refused|forged
epochs(chain, tx_hash, block, block_time, epoch_id, delta, status, reason, evaluated_at)
status_changes(chain, tx_hash, block_time, from_status, to_status, reason)
breaches(chain, tx_hash, block_time, incident_id, reason, offending_chain, offending_tx, recipient, amount, message_id, delta)
incidents(id, token_symbol, reason, status, offending_chain, offending_tx, recipient, amount, message_id, opened_at, broken_at)
incident_actions(chain, tx_hash, block_time, incident_id, kind, account)   -- kind: lanes_frozen|tainted|quarantine_applied|breach_report|...
taints(chain, account, incident_id, active)
verdicts(message_id, evaluated_at, src_chain, dst_chain, amount, sender, receiver, decision, reason, note, source_tx, incident_id)
Chains: ${Object.keys(CHAINS).join(", ")}.`;

const TOOLS: ToolDef[] = [
  {
    name: "sql",
    description: `Run ONE read-only SELECT over the KIRCHHOFF read model (max 50 rows). Always select tx_hash and chain for facts you will cite.\n${ASK_VIEWS}`,
    parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", maxLength: 2000 } } },
  },
  {
    name: "evidence",
    description: "Fetch the deterministic evidence bundle of one incident by id (bytes32).",
    parameters: { type: "object", additionalProperties: false, required: ["incident_id"], properties: { incident_id: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } } },
  },
];

const ANSWER_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "citations"],
  properties: {
    answer: { type: "string", maxLength: 1500 },
    citations: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "kind", "label", "chain", "ref"],
        properties: {
          n: { type: "integer", minimum: 1, maximum: 8 },
          kind: { type: "string", enum: ["tx", "row", "onchain_read"] },
          label: { type: "string", maxLength: 120 },
          chain: { type: "string" },
          ref: { type: "string", maxLength: 140 },
        },
      },
    },
  },
};

type Answer = { answer: string; citations: { n: number; kind: AskCitation["kind"]; label: string; chain: string; ref: string }[] };

const SYSTEM = [
  "You are Ask KIRCHHOFF. You answer questions about protected tokens, conservation status, epochs, verdicts and incidents using only tool results.",
  UNTRUSTED_POLICY,
  "Rules: query before answering; never guess numbers. Convert base units to tokens (divide by 10^18) when you state amounts.",
  "Cite every factual claim with [n] markers. Citation kinds: tx (ref = the 0x tx hash, chain = its chain), row (ref = table:key, e.g. incidents:0xabc...),",
  "onchain_read (ref = the contract address read, chain = its chain). Only cite values that appeared in tool results.",
  "If the read model cannot answer, say so plainly. No em dashes.",
  "When done, reply with ONLY a JSON object: {\"answer\": string, \"citations\": [{\"n\", \"kind\", \"label\", \"chain\", \"ref\"}]}.",
].join("\n");

const FORBIDDEN = /\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|call|do|set|reset|vacuum|analyze|lock|listen|notify|prepare|execute|refresh|comment|security|pg_sleep|pg_read|lo_import|lo_export|dblink)\b/i;

/** Defense in depth only: the database role and a READ ONLY transaction are the real enforcement. */
export function checkSelect(query: string): string {
  const q = query.trim().replace(/;\s*$/, "");
  if (q.length === 0 || q.length > 2000) throw new Error("query must be 1..2000 characters");
  if (q.includes(";")) throw new Error("one statement only");
  if (!/^(select|with)\b/i.test(q)) throw new Error("only SELECT queries are allowed");
  if (FORBIDDEN.test(q.replace(/'[^']*'/g, "''"))) throw new Error("query uses a forbidden keyword");
  return q;
}

export type AskOptions = { provider: LlmProvider; model: string; backend: AskBackend; emit: (e: AskEvent) => void; signal?: AbortSignal };

function hrefFor(c: Answer["citations"][number]): string | null {
  if (c.kind === "tx" && isChainKey(c.chain) && /^0x[0-9a-fA-F]{64}$/.test(c.ref)) return txUrl(c.chain, c.ref as `0x${string}`);
  if (c.kind === "onchain_read" && isChainKey(c.chain) && /^0x[0-9a-fA-F]{40}$/.test(c.ref)) return `${addressUrl(c.chain, c.ref as `0x${string}`)}#readContract`;
  if (c.kind === "row" && /^[a-z_]{1,32}:[0-9a-zA-Zx:_-]{1,100}$/.test(c.ref)) return `kirchhoff://row/${c.ref}`;
  return null;
}

export async function askKirchhoff(req: AskRequest, opts: AskOptions): Promise<void> {
  const results: string[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    ...req.history.slice(-10).map((h): ChatMessage => (h.role === "user" ? { role: "user", content: h.content.slice(0, 2000) } : { role: "assistant", content: h.content.slice(0, 2000) })),
    { role: "user", content: `${req.token ? `Token in focus: ${req.token}. ` : ""}Question: ${req.question.slice(0, 1000)}` },
  ];
  try {
    let final: string | null = null;
    for (let turn = 0; turn < 5; turn++) {
      const res = await opts.provider.chat({ model: opts.model, temperature: 0, maxTokens: 900, messages, tools: TOOLS }, opts.signal);
      if (res.toolCalls.length === 0) {
        final = res.content;
        break;
      }
      messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls.slice(0, 4) });
      for (const call of res.toolCalls.slice(0, 4)) {
        let content: string;
        try {
          const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
          if (call.name === "sql") {
            const q = checkSelect(typeof args.query === "string" ? args.query : "");
            const r = await opts.backend.sql(q, opts.signal);
            opts.emit({ type: "tool", tool: "sql", summary: `${r.rows.length} rows${r.truncated ? " (truncated)" : ""}` });
            content = untrusted(r);
          } else if (call.name === "evidence") {
            const id = typeof args.incident_id === "string" && /^0x[0-9a-fA-F]{64}$/.test(args.incident_id) ? args.incident_id : null;
            if (!id) throw new Error("incident_id must be bytes32");
            const b = await opts.backend.evidence(id.toLowerCase());
            opts.emit({ type: "tool", tool: "evidence", summary: b ? `evidence bundle for ${id.slice(0, 10)}` : "no such incident" });
            content = untrusted(b ?? { error: "no such incident" });
          } else {
            content = untrusted({ error: `unknown tool "${call.name.slice(0, 40)}": only sql and evidence exist, both read-only` });
          }
        } catch (e) {
          content = untrusted({ error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
        }
        results.push(content);
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
      }
    }
    let parsed = validateJson<Answer>(ANSWER_SCHEMA, parseModelJson(final));
    if (!parsed.ok) {
      const res = await opts.provider.chat(
        {
          model: opts.model,
          temperature: 0,
          maxTokens: 700,
          messages: [
            ...messages.map((m): ChatMessage => (m.role === "tool" ? { role: "user", content: `Tool ${m.name} result:\n${m.content}` } : m.role === "assistant" ? { role: "assistant", content: m.content ?? "" } : m)),
            { role: "user", content: "Return the final answer as JSON matching the schema." },
          ],
          responseSchema: { name: "ask_answer", schema: ANSWER_SCHEMA },
        },
        opts.signal,
      );
      parsed = validateJson<Answer>(ANSWER_SCHEMA, parseModelJson(res.content));
    }
    if (!parsed.ok) {
      opts.emit({ type: "error", message: "Ask KIRCHHOFF could not produce a cited answer. Try a narrower question." });
      return;
    }
    const corpus = results.join("\n").toLowerCase();
    const kept = parsed.value.citations.filter((c) => corpus.includes(c.ref.split(":").pop()?.toLowerCase() ?? "\u0000") && hrefFor(c) !== null);
    let text = houseStyle(parsed.value.answer);
    // Markers whose citation failed verification are removed rather than shown unbacked.
    const keptN = new Set(kept.map((c) => c.n));
    text = text.replace(/\[(\d+)\]/g, (m, n: string) => (keptN.has(Number(n)) ? m : ""));
    for (let i = 0; i < text.length; i += 48) opts.emit({ type: "text", delta: text.slice(i, i + 48) });
    for (const c of kept) opts.emit({ type: "citation", citation: { n: c.n, kind: c.kind, label: houseStyle(c.label), href: hrefFor(c) ?? "" } });
    opts.emit({ type: "done" });
  } catch (e) {
    opts.emit({ type: "error", message: `Ask KIRCHHOFF failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` });
  }
}
