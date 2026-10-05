import { resolveSpec, type Deployments } from "@kirchhoff/engine/compile";
import { canonicalJson, parseSpec, specHash } from "@kirchhoff/engine/spec";
import type { Queryable } from "@kirchhoff/indexer";
import type { Address, Bytes32, ChainKey, Hex, PendingSpecProposal, SpecFieldChange, TxRef } from "@kirchhoff/sdk";

/**
 * Spec proposal diff alert (PRD section 14 threat 7): every pending KirchhoffRegistry proposal is
 * resolved to its YAML (stored draft by hash, the spec URI, or the repo template resolved against
 * the stored deployments), verified against the onchain hash, and diffed field by field against the
 * active spec. The effect classification is deterministic code, never AI.
 */

const MAX_SPEC_BYTES = 256 * 1024;
const DEFAULT_URI_HOSTS = ["raw.githubusercontent.com", "ipfs.io", "gateway.pinata.cloud", "cloudflare-ipfs.com"];

type Resolved = { ok: true; json: Record<string, unknown> } | { ok: false; reason: string };

export type SpecResolverOptions = { fetch?: typeof fetch; allowedHosts?: readonly string[] };

const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Flattens a canonical TokenSpec JSON into YAML-style paths (remotes and bridges keyed by alias/id). */
export function flattenSpec(json: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, path: string): void => {
    if (v === null || v === undefined) {
      out.set(path, "null");
      return;
    }
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x !== "object" || x === null)) {
        out.set(path, `[${v.map(String).join(", ")}]`);
        return;
      }
      for (const [i, item] of v.entries()) {
        const o = item as Record<string, unknown>;
        const chain = o.chain as { alias?: unknown } | undefined;
        const key = typeof o.id === "string" ? o.id : typeof chain?.alias === "string" ? chain.alias : String(i);
        walk(item, `${path}[${key}]`);
      }
      return;
    }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      // A chain reference renders as its CRE chain name, like the YAML.
      if ("selector" in o && "name" in o && "alias" in o) {
        out.set(path, String(o.name));
        return;
      }
      for (const [k, x] of Object.entries(o)) walk(x, path ? `${path}.${snake(k)}` : snake(k));
      return;
    }
    out.set(path, typeof v === "string" ? v : JSON.stringify(v));
  };
  walk(json, "");
  return out;
}

const listOf = (s: string | null): string[] => (s?.startsWith("[") ? s.slice(1, -1).split(", ").filter(Boolean) : []);
const num = (s: string | null): bigint | null => (s !== null && /^-?\d+$/.test(s) ? BigInt(s) : null);
const CONFIDENCE_RANK: Readonly<Record<string, number>> = { latest: 0, safe: 1, finalized: 2 };

/** Deterministic effect of one field change on how strict the rules are. */
export function effectOf(path: string, kind: SpecFieldChange["kind"], before: string | null, after: string | null): SpecFieldChange["effect"] {
  const higher = (): number => {
    const b = num(before);
    const a = num(after);
    return b === null || a === null ? 0 : a > b ? 1 : a < b ? -1 : 0;
  };
  if (path.endsWith(".minters")) {
    const added = listOf(after).filter((x) => !listOf(before).includes(x));
    if (kind === "added" || added.length > 0) return "loosens";
    return kind === "removed" || listOf(before).length > listOf(after).length ? "tightens" : "neutral";
  }
  // A whole new remote chain or bridge is a new path that can create claims.
  if (/^(remotes|bridges)\[[^\]]+\]\./.test(path) && kind === "added") return "loosens";
  if (path === "response.on_broken") {
    const removed = listOf(before).filter((x) => !listOf(after).includes(x));
    return removed.length > 0 ? "loosens" : listOf(after).length > listOf(before).length ? "tightens" : "neutral";
  }
  if (path === "rules.on_stale") return after === "fail_open" ? "loosens" : after === "fail_closed" ? "tightens" : "neutral";
  if (path.startsWith("confidence.")) {
    const b = CONFIDENCE_RANK[before ?? ""];
    const a = CONFIDENCE_RANK[after ?? ""];
    if (a === undefined || b === undefined) return "neutral";
    return a < b ? "loosens" : a > b ? "tightens" : "neutral";
  }
  if (path === "rules.soft.flow_limit_per_hour") {
    if (after === "null" || after === null) return "loosens";
    if (before === "null" || before === null) return "tightens";
    return higher() > 0 ? "loosens" : higher() < 0 ? "tightens" : "neutral";
  }
  if (["rules.loop.tolerance_wei", "rules.staleness_seconds", "rules.junction.match_window_seconds", "rules.loop.breach_confirmations"].includes(path) || path.endsWith(".max_delivery_seconds")) {
    return higher() > 0 ? "loosens" : higher() < 0 ? "tightens" : "neutral";
  }
  if (path === "response.recovery_timelock_seconds") return higher() < 0 ? "loosens" : higher() > 0 ? "tightens" : "neutral";
  return "neutral";
}

export function diffSpecs(active: Record<string, unknown>, pending: Record<string, unknown>): SpecFieldChange[] {
  const a = flattenSpec(active);
  const p = flattenSpec(pending);
  const out: SpecFieldChange[] = [];
  for (const path of [...new Set([...a.keys(), ...p.keys()])].sort()) {
    if (path === "token_id") continue;
    const before = a.get(path) ?? null;
    const after = p.get(path) ?? null;
    if (before === after) continue;
    const kind: SpecFieldChange["kind"] = before === null ? "added" : after === null ? "removed" : "changed";
    out.push({ path, kind, before, after, effect: effectOf(path, kind, before, after) });
  }
  return out;
}

export class SpecResolver {
  private readonly db: Queryable;
  private readonly fetchImpl: typeof fetch;
  private readonly hosts: readonly string[];
  private readonly cache = new Map<string, string | null>();

  constructor(db: Queryable, opts: SpecResolverOptions = {}) {
    this.db = db;
    this.fetchImpl = opts.fetch ?? fetch;
    this.hosts = opts.allowedHosts ?? DEFAULT_URI_HOSTS;
  }

  private async fetchUri(uri: string): Promise<string | null> {
    if (this.cache.has(uri)) return this.cache.get(uri) ?? null;
    let url = uri;
    if (uri.startsWith("ipfs://")) url = `https://ipfs.io/ipfs/${uri.slice(7)}`;
    let body: string | null = null;
    try {
      const u = new URL(url);
      // Only allow-listed https hosts: the URI is attacker-influenced input (SSRF).
      if (u.protocol === "https:" && this.hosts.includes(u.hostname)) {
        const res = await this.fetchImpl(u, { signal: AbortSignal.timeout(5_000), redirect: "error" });
        const text = res.ok ? await res.text() : null;
        body = text !== null && text.length <= MAX_SPEC_BYTES ? text : null;
      }
    } catch {
      body = null;
    }
    this.cache.set(uri, body);
    return body;
  }

  private async deployments(): Promise<Deployments | null> {
    const r = await this.db.query<{ doc: Deployments }>("select doc from deployment_docs where name = 'active'");
    return r.rows[0]?.doc ?? null;
  }

  /** YAML candidates for a hash, in trust order; the first whose resolved hash matches wins. */
  async resolve(hash: string, uri: string | null, symbol: string): Promise<Resolved> {
    const candidates: string[] = [];
    const stored = await this.db.query<{ yaml: string }>("select yaml from specs where spec_hash = $1 and yaml is not null order by created_at desc", [hash.toLowerCase()]);
    candidates.push(...stored.rows.map((r) => r.yaml));
    if (uri) {
      const fetched = await this.fetchUri(uri);
      if (fetched !== null) candidates.push(fetched);
    }
    const template = (await this.db.query<{ spec_yaml: string }>("select spec_yaml from tokens where symbol = $1", [symbol])).rows[0]?.spec_yaml;
    if (template) candidates.push(template);
    const deployments = await this.deployments();
    for (const yaml of candidates) {
      const parsed = parseSpec(yaml);
      if (!parsed.ok) continue;
      const resolved = deployments ? resolveSpec(parsed.spec, deployments) : { spec: parsed.spec, errors: [] };
      for (const spec of [parsed.spec, resolved.spec]) {
        if (specHash(spec).toLowerCase() === hash.toLowerCase()) return { ok: true, json: JSON.parse(canonicalJson(spec)) as Record<string, unknown> };
      }
    }
    return { ok: false, reason: uri ? `no document at the spec URI or in stored drafts hashes to ${hash.slice(0, 10)}` : "no spec URI and no stored draft for this hash" };
  }

  async proposals(symbol: string, homeChain: ChainKey, issuerSafe: Address): Promise<PendingSpecProposal[]> {
    const token = (await this.db.query<{ spec_hash: string }>("select spec_hash from tokens where symbol = $1", [symbol])).rows[0];
    const activeHash = token?.spec_hash ?? `0x${"0".repeat(64)}`;
    const activeRow = (await this.db.query<{ spec_uri: string | null }>("select spec_uri from specs where spec_hash = $1 and source = 'registry' limit 1", [activeHash])).rows[0];
    const active = BigInt(activeHash) === 0n ? null : await this.resolve(activeHash, activeRow?.spec_uri ?? null, symbol);
    const rows = await this.db.query<{
      spec_hash: string;
      spec_uri: string | null;
      state: PendingSpecProposal["state"];
      propose_tx: string;
      propose_block: string;
      proposed_at: Date;
      activates_at: Date;
    }>(
      `select spec_hash, spec_uri, state, propose_tx, propose_block::text, proposed_at, activates_at from specs
       where token_symbol = $1 and source = 'registry' and propose_tx is not null
         and (state = 'proposed' or (state in ('active', 'superseded', 'cancelled') and proposed_at > now() - interval '24 hours'))
       order by (state = 'proposed') desc, proposed_at desc`,
      [symbol],
    );
    const out: PendingSpecProposal[] = [];
    for (const r of rows.rows) {
      const pending = await this.resolve(r.spec_hash, r.spec_uri, symbol);
      let diff: SpecFieldChange[];
      if (pending.ok && active?.ok) diff = diffSpecs(active.json, pending.json);
      else if (pending.ok && active === null) diff = diffSpecs({}, pending.json);
      else {
        // Unverifiable documents are surfaced, never silently shown as "no change".
        const reason = !pending.ok ? pending.reason : active && !active.ok ? `active spec unresolved: ${active.reason}` : "unresolved";
        diff = [{ path: "spec_document", kind: "changed", before: activeHash, after: `unverified: ${reason}`, effect: "neutral" }];
      }
      const tx: TxRef = { chain: homeChain, hash: r.propose_tx as Hex, block: r.propose_block, timestamp: r.proposed_at.toISOString() };
      out.push({
        specHash: r.spec_hash as Bytes32,
        activeSpecHash: activeHash as Bytes32,
        state: r.state,
        proposeTx: tx,
        proposedAt: r.proposed_at.toISOString(),
        activatesAt: r.activates_at.toISOString(),
        timelockSeconds: Math.max(0, Math.round((r.activates_at.getTime() - r.proposed_at.getTime()) / 1000)),
        proposer: issuerSafe,
        diff,
      });
    }
    return out;
  }
}
