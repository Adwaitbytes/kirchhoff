import { CHAINS, isChainKey, type CopilotTool, type LineProvenance, type SpecDraftLine } from "@kirchhoff/sdk";
import type { JsonSchema } from "../provider.ts";

/**
 * The Copilot's structured output. Every fact is a {value, source} pair where source is the id of
 * the tool call whose result contains the value, or "issuer" when it came from the issuer's own
 * description. YAML is rendered from this structure by code (principle 5), and each line's
 * provenance is verified against the recorded tool results, never taken on the model's word.
 */

export type Sourced = { value: string; source: string };

export type DraftStructure = {
  token: Sourced;
  model: "lock_release_home" | "burn_mint_multi";
  home: { chain: Sourced; canonical: Sourced; escrow: Sourced | null; decimals: Sourced };
  remotes: { chain: Sourced; token: Sourced; /** null: the KIRCH-SPEC default (18) applies. */ decimals: Sourced | null; minters: { name: string; address: Sourced; why: string }[] }[];
  bridges: {
    id: string;
    kind: "ccip_v2" | "custom";
    contracts: { chain: string; address: Sourced }[];
    onramps: { chain: string; address: Sourced }[];
    offramps: { chain: string; address: Sourced }[];
    /** ccip_v2 lock-release: the ERC20LockBox that holds home escrow. */
    lockbox: Sourced | null;
    debit_event: Sourced | null;
    credit_event: Sourced | null;
  }[];
  notes: string;
};

const sourced = { type: "object", additionalProperties: false, required: ["value", "source"], properties: { value: { type: "string", maxLength: 300 }, source: { type: "string", maxLength: 40 } } } as const;
const nullableSourced = { anyOf: [sourced, { type: "null" }] } as const;
const chainAddr = { type: "object", additionalProperties: false, required: ["chain", "address"], properties: { chain: { type: "string" }, address: sourced } } as const;

export const DRAFT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["token", "model", "home", "remotes", "bridges", "notes"],
  properties: {
    token: sourced,
    model: { type: "string", enum: ["lock_release_home", "burn_mint_multi"] },
    home: {
      type: "object",
      additionalProperties: false,
      required: ["chain", "canonical", "escrow", "decimals"],
      properties: { chain: sourced, canonical: sourced, escrow: nullableSourced, decimals: sourced },
    },
    remotes: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["chain", "token", "decimals", "minters"],
        properties: {
          chain: sourced,
          token: sourced,
          decimals: nullableSourced,
          minters: {
            type: "array",
            maxItems: 8,
            items: { type: "object", additionalProperties: false, required: ["name", "address", "why"], properties: { name: { type: "string", pattern: "^[a-z0-9_]{1,40}$" }, address: sourced, why: { type: "string", maxLength: 240 } } },
          },
        },
      },
    },
    bridges: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "contracts", "onramps", "offramps", "lockbox", "debit_event", "credit_event"],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9_]{1,24}$" },
          kind: { type: "string", enum: ["ccip_v2", "custom"] },
          contracts: { type: "array", maxItems: 8, items: chainAddr },
          onramps: { type: "array", maxItems: 8, items: chainAddr },
          offramps: { type: "array", maxItems: 8, items: chainAddr },
          lockbox: nullableSourced,
          debit_event: nullableSourced,
          credit_event: nullableSourced,
        },
      },
    },
    notes: { type: "string", maxLength: 1200 },
  },
};

/** `tool` is the requested name, which may be unknown (refused) when the model asked for a tool that does not exist. */
export type TraceEntry = { id: string; tool: string; ok: boolean; resultText: string; href: string | null };

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

export type ProvenanceChecker = (s: Sourced | null, why?: string) => LineProvenance | null;

/** Builds the checker: a value is backed only if it literally occurs in the cited tool result (or the issuer's text). */
export function provenanceChecker(trace: readonly TraceEntry[], issuerText: string): ProvenanceChecker {
  const byId = new Map(trace.map((t) => [t.id, t]));
  const issuer = norm(issuerText);
  return (s, why) => {
    if (s === null) return null;
    const value = norm(s.value);
    if (value.length === 0) return null;
    const tool = (entry: TraceEntry): LineProvenance => ({ kind: "tool", toolCallId: entry.id, tool: entry.tool as CopilotTool, href: entry.href, why: why ?? null });
    const cited = byId.get(s.source);
    if (cited?.ok && norm(cited.resultText).includes(value)) return tool(cited);
    // The model cited the wrong call (or "issuer"): provenance is recovered only from a tool result
    // that verifiably contains the value, never taken on the model's word.
    const found = trace.find((t) => t.ok && norm(t.resultText).includes(value));
    if (found) return tool(found);
    return s.source === "issuer" && issuer.includes(value) ? { kind: "issuer", toolCallId: null, tool: null, href: null, why: why ?? null } : null;
  };
}

const SCHEMA_LINE: LineProvenance = { kind: "schema", toolCallId: null, tool: null, href: null, why: null };

const ALIAS: Readonly<Record<string, string>> = Object.fromEntries(Object.values(CHAINS).map((c) => [c.key, c.alias]));
const aliasOf = (chain: string): string => ALIAS[chain] ?? chain;

/** Renders the KIRCH-SPEC YAML (same layout as engine/specs/kETH.yaml) with per-line provenance. */
export function renderDraft(d: DraftStructure, check: ProvenanceChecker): { yaml: string; lines: SpecDraftLine[] } {
  const out: { text: string; provenance: LineProvenance | null }[] = [];
  const line = (text: string, provenance: LineProvenance | null = SCHEMA_LINE): void => {
    out.push({ text, provenance });
  };
  const q = (v: string): string => JSON.stringify(v);
  line("# KIRCH-SPEC drafted by Spec Copilot. Review every line; red lines have no provenance and block approval.");
  line("spec_version: 1");
  line(`token: ${d.token.value}`, check(d.token));
  line(`model: ${d.model}`, d.model === "lock_release_home" ? check(d.home.escrow, "Lock-and-release: the home chain escrows the canonical token") : SCHEMA_LINE);
  line("unit: tokens");
  line("home:");
  line(`  chain: ${d.home.chain.value}`, isChainKey(d.home.chain.value) ? check(d.home.chain) : null);
  line(`  canonical: ${q(d.home.canonical.value)}`, check(d.home.canonical));
  if (d.home.escrow) line(`  escrow: ${q(d.home.escrow.value)}`, check(d.home.escrow));
  line(`  decimals: ${d.home.decimals.value}`, check(d.home.decimals));
  // An empty section must render as [] or YAML reads it as null ("must be array").
  line(d.remotes.length === 0 ? "remotes: []" : "remotes:");
  for (const r of d.remotes) {
    line(`  - chain: ${r.chain.value}`, isChainKey(r.chain.value) ? check(r.chain) : null);
    line(`    alias: ${aliasOf(r.chain.value)}`);
    line(`    token: ${q(r.token.value)}`, check(r.token));
    line("    minters:");
    for (const m of r.minters) line(`      - ${m.name}`, check(m.address, m.why));
    if (r.decimals) line(`    decimals: ${r.decimals.value}`, check(r.decimals));
    else line("    decimals: 18");
  }
  line(d.bridges.length === 0 ? "bridges: []" : "bridges:");
  for (const b of d.bridges) {
    line(`  - id: ${b.id}`);
    line(`    kind: ${b.kind}`);
    if (b.kind === "ccip_v2") {
      const map = (key: string, list: DraftStructure["bridges"][number]["contracts"]): void => {
        // An empty map must render as {} or YAML reads it as null.
        if (list.length === 0) { line(`    ${key}: {}`); return; }
        line(`    ${key}:`);
        for (const c of list) line(`      ${aliasOf(c.chain)}: ${q(c.address.value)}`, check(c.address));
      };
      map("pools", b.contracts);
      map("onramps", b.onramps);
      map("offramps", b.offramps);
      if (b.lockbox) line(`    lockbox: ${q(b.lockbox.value)}`, check(b.lockbox));
    } else {
      if (b.contracts.length === 0) line("    contracts: {}");
      else {
        line("    contracts:");
        for (const c of b.contracts) line(`      ${aliasOf(c.chain)}: ${q(c.address.value)}`, check(c.address));
      }
      if (b.debit_event) line(`    debit_event: ${q(b.debit_event.value)}`, check(b.debit_event));
      if (b.credit_event) line(`    credit_event: ${q(b.credit_event.value)}`, check(b.credit_event));
      line("    search_window_blocks: 100");
    }
  }
  line("reserves:");
  line("  por_feed: null");
  line("confidence:");
  line("  default: finalized");
  line("  overrides: { ethereum-testnet-sepolia-base-1: safe }");
  line("rules:");
  line("  junction: { match_window_seconds: 1200 }");
  line('  loop: { tolerance_wei: "0", breach_confirmations: 1 }');
  line("  soft:");
  line('    flow_limit_per_hour: "50000e18"');
  line("  staleness_seconds: 120");
  line("  on_stale: fail_closed");
  line("response:");
  line("  on_broken: [freeze_ccip_lanes, taint_recipient, flip_feed, page_issuer]");
  line("  replay_requires: issuer_multisig");
  line("  recovery_timelock_seconds: 3600");
  return { yaml: `${out.map((l) => l.text).join("\n")}\n`, lines: out.map((l, i) => ({ line: i + 1, text: l.text, provenance: l.provenance })) };
}

/** Eval metric: share of lines carrying an address (0x + 40 hex) whose provenance is a verified tool result. */
export function addressProvenanceCoverage(lines: readonly SpecDraftLine[]): { total: number; covered: number } {
  const addrLines = lines.filter((l) => /0x[0-9a-fA-F]{40}/.test(l.text) || /^\s+- [a-z0-9_]+$/.test(l.text));
  return { total: addrLines.length, covered: addrLines.filter((l) => l.provenance?.kind === "tool").length };
}
