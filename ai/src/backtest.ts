import { toEventSelector, type PublicClient } from "viem";
import { backtest, reasonName, type Credit, type Debit, type HistoryEvent, type TokenSpec } from "@kirchhoff/engine";
import { parseSpec, specHash, validateSpec } from "@kirchhoff/engine/spec";
import { decodeLogs, watchedAddresses } from "@kirchhoff/indexer";
import { CHAINS, chainBySelector, erc20Abi, isChainKey, type Address, type BacktestResponse, type ChainDeploymentInfo, type ChainKey, type Hex, type TxRef } from "@kirchhoff/sdk";

/**
 * Spec lifecycle step 3 (PRD section 6): replay the token's event history through the
 * deterministic engine. Shared by POST /specs/backtest and the Copilot's backtest_spec tool.
 * The engine decides; this module only fetches history and maps the result.
 */

export type BacktestBody = Omit<BacktestResponse, "source" | "ledger" | "block" | "servedAt">;

export class SpecInvalidError extends Error {
  override readonly name = "SpecInvalidError";
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`spec invalid: ${errors.slice(0, 3).join("; ")}`);
    this.errors = errors;
  }
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;
const isZero = (a: string | null | undefined): boolean => !a || BigInt(a) === 0n;

function pseudoDeployment(spec: TokenSpec, chain: ChainKey, alias: string, role: "home" | "remote", token: Address): ChainDeploymentInfo {
  const custom = spec.bridges.find((b) => b.kind === "custom");
  const ccip = spec.bridges.find((b) => b.kind === "ccip_v2");
  const at = (m: Readonly<Record<string, Hex>> | undefined): Address | null => {
    const v = m?.[alias];
    return isZero(v) ? null : (v?.toLowerCase() as Address);
  };
  const emitter = custom?.kind === "custom" ? at(custom.contracts) : null;
  return {
    chain,
    chainId: 0,
    mode: "local",
    role,
    tokenSymbol: spec.token,
    // Ledger, quarantine and feed are not history sources for a backtest; ZERO never matches a log address.
    ledger: ZERO,
    quarantine: ZERO,
    feed: ZERO,
    guard: null,
    registry: null,
    token,
    escrow: role === "home" ? emitter : null,
    weakBridge: emitter,
    ccipPool: ccip?.kind === "ccip_v2" ? at(ccip.pools) : null,
    ccipLockBox: role === "home" && ccip?.kind === "ccip_v2" && !isZero(ccip.lockbox) ? (ccip.lockbox?.toLowerCase() as Address) : null,
    onRamp: ccip?.kind === "ccip_v2" ? at(ccip.onramps) : null,
    offRamp: ccip?.kind === "ccip_v2" ? at(ccip.offramps) : null,
    tokenAdminRegistry: null,
    lendingMarket: null,
    issuerSafe: null,
    deployedAtBlock: null,
  };
}

export type BacktestDeps = {
  clients: Partial<Record<ChainKey, PublicClient>>;
  /** Default start when the request names none: genesis on Anvil, a recent window on testnets. */
  defaultLookback: bigint | null;
  maxChunk?: bigint;
};

export async function backtestYaml(yaml: string, fromBlock: Partial<Record<ChainKey, bigint>>, deps: BacktestDeps): Promise<BacktestBody> {
  const started = Date.now();
  const parsed = parseSpec(yaml);
  if (!parsed.ok) throw new SpecInvalidError(parsed.errors);
  const spec = parsed.spec;
  const chains = [
    { name: spec.home.chain.name, alias: spec.home.chain.alias, role: "home" as const, token: spec.home.canonical },
    ...spec.remotes.map((r) => ({ name: r.chain.name, alias: r.chain.alias, role: "remote" as const, token: r.token })),
  ];
  const events: (HistoryEvent & { at: bigint; order: bigint })[] = [];
  const coverage: BacktestBody["coverage"] = [];
  const pinned: { chain: bigint; block: bigint }[] = [];
  const supplies: { chain: bigint; supply: bigint }[] = [];
  const sources = new Map<bigint, { head: bigint; headTimestamp: bigint }>();
  const creditTx = new Map<string, TxRef>();
  let escrow = 0n;
  let latest = 0n;
  const debitIds = new Set<string>();
  const creditIds = new Map<ChainKey, Set<string>>();
  for (const c of chains) {
    if (!isChainKey(c.name)) throw new SpecInvalidError([`chain ${c.name} is not supported`]);
    if (isZero(c.token)) throw new SpecInvalidError([`${c.name} token address is a placeholder`]);
    const client = deps.clients[c.name];
    if (!client) throw new SpecInvalidError([`no RPC configured for ${c.name}`]);
    const selector = CHAINS[c.name].selector;
    const dep = pseudoDeployment(spec, c.name, c.alias, c.role, c.token.toLowerCase() as Address);
    const headBlock = await client.getBlock({ blockTag: "latest" });
    const head = headBlock.number;
    const from = fromBlock[c.name] ?? (deps.defaultLookback === null ? 0n : head > deps.defaultLookback ? head - deps.defaultLookback : 0n);
    const addresses = watchedAddresses(dep).filter((a) => a !== ZERO);
    let debits = 0;
    let credits = 0;
    const chunk = deps.maxChunk ?? 2_000n;
    const times = new Map<bigint, bigint>();
    for (let start = from; start <= head && addresses.length > 0; start += chunk) {
      const end = start + chunk - 1n < head ? start + chunk - 1n : head;
      const logs = await client.getLogs({ address: addresses, fromBlock: start, toBlock: end });
      for (const ev of decodeLogs(logs, dep)) {
        if (ev.kind !== "Debit" && ev.kind !== "Credit") continue;
        let ts = times.get(ev.block);
        if (ts === undefined) {
          ts = (await client.getBlock({ blockNumber: ev.block })).timestamp;
          times.set(ev.block, ts);
        }
        const order = ev.block * 100_000n + BigInt(ev.logIndex);
        if (ev.kind === "Debit") {
          debits++;
          debitIds.add(ev.messageId.toLowerCase());
          const debit: Debit = { messageId: ev.messageId, srcChain: selector, dstChain: ev.dstSelector, amount: ev.amount, txHash: ev.txHash, block: ev.block, ...(ev.recipient ? { recipient: ev.recipient } : {}) };
          events.push({ kind: "debit", debit, at: ts, order });
        } else {
          credits++;
          const set = creditIds.get(c.name) ?? new Set<string>();
          set.add(ev.messageId.toLowerCase());
          creditIds.set(c.name, set);
          const credit: Credit = { messageId: ev.messageId, claimedSrcChain: ev.srcSelector, dstChain: selector, amount: ev.amount, txHash: ev.txHash, block: ev.block, ...(ev.recipient ? { recipient: ev.recipient } : {}) };
          creditTx.set(`${ev.txHash}:${ev.messageId}`.toLowerCase(), { chain: c.name, hash: ev.txHash, block: ev.block.toString(), timestamp: new Date(Number(ts) * 1000).toISOString() });
          events.push({ kind: "credit", credit, timestamp: ts, at: ts, order });
        }
      }
    }
    const supply = await client.readContract({ address: c.token, abi: erc20Abi, functionName: "totalSupply", blockNumber: head });
    supplies.push({ chain: selector, supply });
    if (c.role === "home") {
      for (const holder of [dep.escrow, dep.ccipLockBox]) {
        if (holder) escrow += await client.readContract({ address: c.token, abi: erc20Abi, functionName: "balanceOf", args: [holder], blockNumber: head });
      }
    }
    pinned.push({ chain: selector, block: head });
    sources.set(selector, { head, headTimestamp: headBlock.timestamp });
    if (headBlock.timestamp > latest) latest = headBlock.timestamp;
    coverage.push({ chain: c.name, fromBlock: from.toString(), toBlock: head.toString(), debits, credits, matched: 0 });
  }
  for (const cov of coverage) {
    const ids = creditIds.get(cov.chain) ?? new Set<string>();
    cov.matched = [...ids].filter((id) => debitIds.has(id)).length;
  }
  events.sort((a, b) => (a.at === b.at ? (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) : a.at < b.at ? -1 : 1));
  const history: HistoryEvent[] = events.map(({ at: _at, order: _order, ...e }) => e);
  history.push({
    kind: "epoch",
    epoch: {
      timestamp: latest,
      sources,
      snapshot: spec.model === "lock_release_home" ? { model: "lock_release_home", epochId: 1n, pinned, supplies, escrow } : { model: "burn_mint_multi", epochId: 1n, pinned, supplies, issuanceNet: 0n, reserve: null },
    },
  });
  const result = backtest(history, spec);
  const homeKey = spec.home.chain.name as ChainKey;
  const homePin = pinned[0];
  const atHome: TxRef = { chain: homeKey, hash: ZERO_HASH, block: (homePin?.block ?? 0n).toString(), timestamp: new Date(Number(latest) * 1000).toISOString() };
  const chainOf = (sel: bigint): string => chainBySelector(sel)?.label ?? sel.toString();
  return {
    specHash: specHash(spec),
    ok: result.breaches.length === 0,
    eventsReplayed: history.length - 1,
    durationMs: Date.now() - started,
    coverage,
    breaches: result.breaches.map((b) => ({
      reason: reasonName(b.reason),
      tx: b.credit ? (creditTx.get(`${b.credit.txHash}:${b.credit.messageId}`.toLowerCase()) ?? atHome) : atHome,
      amount: (b.credit ? b.credit.amount : b.delta < 0n ? -b.delta : b.delta).toString(),
      note: b.rule === "junction" && b.credit ? `credit on ${chainOf(b.credit.dstChain)} for message ${b.credit.messageId.slice(0, 10)} has no valid debit` : `Loop Rule delta ${b.delta.toString()} at the pinned blocks`,
    })),
    driftEvents: result.drift.map((d) => ({ reason: reasonName(d.reason), tx: atHome, note: d.messageId ? `message ${d.messageId.slice(0, 10)} still inside its match window` : "soft rule tripped" })),
  };
}

/**
 * Pre-validation that keeps the engine pure: every custom bridge address must be the contract that
 * actually emits the spec's debit/credit events on its chain. If the declared address emitted none
 * of them while another contract on that chain did, the spec points at the wrong contract (for
 * example the home WeakBridge instead of the HomeEscrowAdapter, which emits on home).
 */
export async function checkBridgeEmitters(spec: TokenSpec, clients: Partial<Record<ChainKey, PublicClient>>, lookback: bigint | null): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const chainOfAlias = new Map<string, string>([[spec.home.chain.alias, spec.home.chain.name], ...spec.remotes.map((r) => [r.chain.alias, r.chain.name] as [string, string])]);
  for (const b of spec.bridges) {
    if (b.kind !== "custom") continue;
    const topics: Hex[] = [toEventSelector(b.events.debitEvent), toEventSelector(b.events.creditEvent)];
    for (const [alias, declared] of Object.entries(b.contracts)) {
      const chain = chainOfAlias.get(alias);
      const client = chain && isChainKey(chain) ? clients[chain] : undefined;
      if (!client || isZero(declared)) continue;
      const head = await client.getBlockNumber();
      const floor = lookback === null ? 0n : head > lookback ? head - lookback : 0n;
      const counts = new Map<string, number>();
      for (let to = head; to >= floor; to -= 10_000n) {
        const from = to - 9_999n > floor ? to - 9_999n : floor;
        const logs = (await client
          .request({ method: "eth_getLogs", params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [topics] }] })
          .catch(() => null)) as { address: string; topics: Hex[] }[] | null;
        if (logs === null) {
          // Topic-only queries are refused by some providers; fall back to a softer check.
          warnings.push(`bridge ${b.id} ${alias}: could not scan emitters on ${chain}`);
          break;
        }
        for (const l of logs) if (l.topics[0] && topics.includes(l.topics[0])) counts.set(l.address.toLowerCase(), (counts.get(l.address.toLowerCase()) ?? 0) + 1);
        if (from === floor) break;
      }
      const own = counts.get(declared.toLowerCase()) ?? 0;
      const others = [...counts].filter(([a]) => a !== declared.toLowerCase()).sort((x, y) => y[1] - x[1]);
      if (own === 0 && others.length > 0) {
        const [addr, n] = others[0] ?? ["", 0];
        errors.push(`bridge ${b.id} ${alias}: ${declared} never emitted its declared debit/credit events on ${chain}; ${addr} did (${n} events), so the spec points at the wrong contract`);
      } else if (own === 0) {
        warnings.push(`bridge ${b.id} ${alias}: no ${b.events.debitEvent.split("(")[0] ?? "debit"}/${b.events.creditEvent.split("(")[0] ?? "credit"} events seen on ${chain} yet, emitter unconfirmed`);
      }
    }
  }
  return { errors, warnings };
}

/** validate_spec: JSON Schema plus engine semantic checks (bytecode read over RPC) plus the emitter pre-validation. */
export async function validateYaml(
  yaml: string,
  clients: Partial<Record<ChainKey, PublicClient>>,
  options: { emitterLookback?: bigint | null } = {},
): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const parsed = parseSpec(yaml);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };
  const engine = await validateSpec(parsed.spec, async (chain, address) => {
    const client = isChainKey(chain.name) ? clients[chain.name] : undefined;
    if (!client) return false;
    const code = await client.getCode({ address }).catch(() => undefined);
    return code !== undefined && code !== "0x";
  });
  const emitters = await checkBridgeEmitters(parsed.spec, clients, options.emitterLookback ?? null);
  const errors = [...engine.errors, ...emitters.errors];
  return { ok: errors.length === 0, errors, warnings: [...engine.warnings, ...emitters.warnings] };
}
