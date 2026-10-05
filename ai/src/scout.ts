import { keccak256, toHex, type Address, type PublicClient } from "viem";
import type { Queryable } from "@kirchhoff/indexer";
import { CHAINS, CHAIN_KEYS, addressUrl, erc20Abi, isChainKey, type ChainKey, type ScoutProposal as ScoutFinding } from "@kirchhoff/sdk";
import { UNTRUSTED_POLICY, houseStyle, parseModelJson, untrusted, validateJson } from "./guard.ts";
import type { JsonSchema, LlmProvider } from "./provider.ts";

/**
 * Topology Scout (PRD section 11 feature 3): finds supply paths the issuer forgot by crawling
 * explorers for same-name and same-symbol token deployments that the active spec does not list,
 * then files them as draft proposals for the Onboarding screen. W4 (deterministic) watches known
 * chains; the Scout looks for unknown ones. Proposals are drafts: nothing here changes a spec.
 */

export type ScoutCandidate = { chain: ChainKey; address: Address; name: string | null; symbol: string | null; source: string };
export type ScoutProposal = ScoutCandidate & { assessment: "likely_bridged_variant" | "same_symbol_unrelated" | "needs_review"; why: string; generator: "model" | "rule" };

export interface CandidateSource {
  readonly id: string;
  search(symbol: string, name: string): Promise<ScoutCandidate[]>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Blockscout REST search on every chain (keyless). */
export class BlockscoutSearch implements CandidateSource {
  readonly id = "blockscout";
  private readonly fetchImpl: typeof fetch;
  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }
  async search(symbol: string, name: string): Promise<ScoutCandidate[]> {
    const out: ScoutCandidate[] = [];
    for (const chain of CHAIN_KEYS) {
      for (const q of new Set([symbol, name])) {
        const res = await this.fetchImpl(`${CHAINS[chain].blockscout}/api/v2/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
        if (!res?.ok) continue;
        const body: unknown = await res.json().catch(() => null);
        const items = isObj(body) && Array.isArray(body.items) ? body.items : [];
        for (const it of items) {
          if (!isObj(it) || it.type !== "token" || typeof it.address_hash !== "string") continue;
          out.push({ chain, address: it.address_hash.toLowerCase() as Address, name: typeof it.name === "string" ? it.name : null, symbol: typeof it.symbol === "string" ? it.symbol : null, source: `blockscout:${chain}` });
        }
      }
    }
    return out;
  }
}

/** Anvil: reads symbol() of every contract created on each chain. */
export class LocalScan implements CandidateSource {
  readonly id = "local-scan";
  private readonly clients: Partial<Record<ChainKey, PublicClient>>;
  constructor(clients: Partial<Record<ChainKey, PublicClient>>) {
    this.clients = clients;
  }
  async search(symbol: string, name: string): Promise<ScoutCandidate[]> {
    const out: ScoutCandidate[] = [];
    for (const [chain, client] of Object.entries(this.clients) as [ChainKey, PublicClient][]) {
      const head = await client.getBlockNumber();
      const floor = head > 2_000n ? head - 2_000n : 0n;
      for (let n = floor; n <= head; n++) {
        const block = await client.getBlock({ blockNumber: n, includeTransactions: true });
        for (const tx of block.transactions) {
          if (tx.to !== null) continue;
          const r = await client.getTransactionReceipt({ hash: tx.hash });
          if (!r.contractAddress) continue;
          const [s, nm] = await Promise.all([
            client.readContract({ address: r.contractAddress, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
            client.readContract({ address: r.contractAddress, abi: erc20Abi, functionName: "name" }).catch(() => null),
          ]);
          if (s === symbol || nm?.toLowerCase().includes(name.toLowerCase()) === true) {
            out.push({ chain, address: r.contractAddress.toLowerCase() as Address, name: nm, symbol: s, source: `local:${chain}` });
          }
        }
      }
    }
    return out;
  }
}

const TRIAGE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "assessment", "why"],
        properties: { index: { type: "integer", minimum: 0 }, assessment: { type: "string", enum: ["likely_bridged_variant", "same_symbol_unrelated", "needs_review"] }, why: { type: "string", maxLength: 200 } },
      },
    },
  },
};

function ruleAssessment(c: ScoutCandidate, symbol: string): Pick<ScoutProposal, "assessment" | "why"> {
  if (c.symbol === symbol) return { assessment: "needs_review", why: `Same symbol ${symbol} on ${CHAINS[c.chain].label}, not listed in the active spec. Confirm whether it can mint ${symbol} claims.` };
  return { assessment: "same_symbol_unrelated", why: `Name matches but symbol is ${c.symbol ?? "unknown"}.` };
}

export type ScoutTraceEvent =
  | { type: "source"; source: string; candidates: number }
  | { type: "finding"; finding: ScoutFinding }
  | { type: "done"; count: number }
  | { type: "error"; message: string };

/** The Onboarding-screen shape (web/lib/api/types.ts ScoutProposal). Every claim links to its source. */
export function toFinding(p: ScoutProposal, token: string, specChains: readonly string[], foundAt: Date): ScoutFinding {
  const known = isChainKey(p.chain);
  const newChain = known && !specChains.includes(p.chain);
  const kind: ScoutFinding["kind"] = newChain ? "new_chain" : p.assessment === "likely_bridged_variant" ? "bridged_variant" : "same_symbol";
  const label = known ? CHAINS[p.chain].label : p.chain;
  const evidence = [
    { label: `${p.name ?? "unnamed"} (${p.symbol ?? "no symbol"}) found by ${p.source}`, href: known ? addressUrl(p.chain, p.address) : `${p.source}:${p.address}` },
    ...(known ? [{ label: `Blockscout: ${p.address}`, href: `${CHAINS[p.chain].blockscout}/address/${p.address}` }] : []),
  ];
  return {
    id: keccak256(toHex(`scout:${p.chain}:${p.address}`)),
    token,
    kind,
    chain: p.chain,
    chainName: label,
    address: p.address,
    summary: p.why,
    evidence,
    confidence: p.assessment === "likely_bridged_variant" ? "high" : p.assessment === "needs_review" ? "medium" : "low",
    specPatch: newChain ? `  - chain: ${p.chain}\n    token: "${p.address}"\n    minters: []   # confirm with list_role_grants before approving\n    decimals: 18` : null,
    foundAt: foundAt.toISOString(),
    status: "open",
  };
}

export type ScoutOptions = {
  symbol: string;
  name: string;
  /** Addresses already in the spec, lowercase. */
  known: ReadonlySet<string>;
  sources: readonly CandidateSource[];
  provider: LlmProvider | null;
  model: string;
  db?: Queryable;
  /** Chains already in the spec (CRE names), to tell a new chain from a variant on a known one. */
  specChains?: readonly string[];
  emit?: (e: ScoutTraceEvent) => void;
  now?: () => Date;
};

export async function runTopologyScout(opts: ScoutOptions): Promise<ScoutProposal[]> {
  const seen = new Set<string>();
  const candidates: ScoutCandidate[] = [];
  for (const s of opts.sources) {
    const found = await s.search(opts.symbol, opts.name).catch((e: unknown) => {
      opts.emit?.({ type: "error", message: `${s.id} search failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` });
      return [];
    });
    opts.emit?.({ type: "source", source: s.id, candidates: found.length });
    for (const c of found) {
      const key = `${c.chain}:${c.address}`;
      if (seen.has(key) || opts.known.has(c.address)) continue;
      seen.add(key);
      candidates.push(c);
    }
  }
  let proposals: ScoutProposal[] = candidates.map((c) => ({ ...c, ...ruleAssessment(c, opts.symbol), generator: "rule" as const }));
  if (opts.provider && candidates.length > 0) {
    try {
      const res = await opts.provider.chat({
        model: opts.model,
        temperature: 0,
        maxTokens: 800,
        messages: [
          { role: "system", content: `You triage token deployments that share a name or symbol with a protected token. ${UNTRUSTED_POLICY}\nReply with JSON only.` },
          { role: "user", content: `Protected token: ${opts.symbol} (${opts.name}). Candidates not in its spec:\n${untrusted(candidates.map((c, index) => ({ index, chain: c.chain, address: c.address, name: c.name, symbol: c.symbol })))}` },
        ],
        responseSchema: { name: "scout_triage", schema: TRIAGE_SCHEMA },
      });
      const parsed = validateJson<{ items: { index: number; assessment: ScoutProposal["assessment"]; why: string }[] }>(TRIAGE_SCHEMA, parseModelJson(res.content));
      if (parsed.ok) {
        proposals = proposals.map((p, i) => {
          const t = parsed.value.items.find((x) => x.index === i);
          return t ? { ...p, assessment: t.assessment, why: houseStyle(t.why), generator: "model" as const } : p;
        });
      }
    } catch {
      // Triage is advisory; the rule assessment stands.
    }
  }
  const now = (opts.now ?? (() => new Date()))();
  for (const p of proposals) {
    const finding = toFinding(p, opts.symbol, opts.specChains ?? [], now);
    // Re-runs keep the issuer's accept/dismiss decision on an existing finding.
    await opts.db?.query(
      `insert into specs (spec_hash, token_symbol, state, source, notes) values ($1, $2, 'draft', 'topology_scout', $3)
       on conflict (spec_hash, token_symbol) do update
         set notes = jsonb_set(excluded.notes, '{finding,status}', coalesce(specs.notes->'finding'->'status', '"open"'))`,
      [finding.id, opts.symbol, JSON.stringify({ proposal: p, finding })],
    );
    opts.emit?.({ type: "finding", finding });
  }
  opts.emit?.({ type: "done", count: proposals.length });
  return proposals;
}
