import type { Queryable } from "@kirchhoff/indexer";
import type { TokenConfig } from "@kirchhoff/indexer";
import {
  CHAINS,
  isChainKey,
  type Address,
  type BlockRef,
  type BridgeInfo,
  type BridgeKind,
  type Bytes32,
  type ChainContracts,
  type ChainKey,
  type ChainSupply,
  type EpochPoint,
  type EpochSummary,
  type Hex,
  type Lane,
  type LaneTransfer,
  type LedgerRef,
  type MirrorMeta,
  type ReasonCode,
  type TokenStatus,
  type TokenStatusResponse,
  type TokenSummary,
  type TxRef,
  type Verdict,
} from "@kirchhoff/sdk";
import { notFound } from "./errors.ts";

/** Row and response builders shared by REST, WebSocket, SSE, MCP and the AI evidence bundle. */

const EPOCH_ZERO = "1970-01-01T00:00:00.000Z";
const iso = (d: Date | null | undefined): string => (d ? d.toISOString() : EPOCH_ZERO);
const asChain = (v: string | null): ChainKey | null => (v !== null && isChainKey(v) ? v : null);

export type TokenRow = {
  symbol: string;
  token_id: string;
  name: string;
  decimals: number;
  model: TokenSummary["model"];
  home_chain: string;
  chains: string[];
  simulation: boolean;
  spec_yaml: string;
  config: TokenConfig;
  status: TokenStatus;
  reason: ReasonCode;
  delta: string;
  epoch_id: string;
  updated_at: Date | null;
  stale: boolean;
  active_incident_id: string | null;
  spec_hash: string;
};

export type ChainRow = {
  chain: ChainKey;
  selector: string;
  chain_id: number;
  role: "home" | "remote";
  confidence: ChainSupply["confidence"];
  ledger: Address;
  quarantine: Address;
  feed: Address;
  guard: Address | null;
  registry: Address | null;
  token: Address;
  escrow: Address | null;
  weak_bridge: Address | null;
  ccip_pool: Address | null;
  ccip_lockbox: Address | null;
  issuer_safe: Address | null;
};

type StateRow = {
  chain: ChainKey;
  block: string;
  block_time: Date;
  supply: string;
  escrow: string | null;
  ccip_lockbox: string | null;
  ledger_status: TokenStatus;
  frozen: boolean;
  read_ok: boolean;
  read_error: string | null;
  read_error_since: Date | null;
};

export type MatchRow = {
  message_id: string;
  bridge: string;
  src_chain: string | null;
  dst_chain: string | null;
  amount: string;
  sender: string | null;
  recipient: string | null;
  debit_chain: string | null;
  debit_tx: string | null;
  debit_block: string | null;
  debit_time: Date | null;
  credit_chain: string | null;
  credit_tx: string | null;
  credit_block: string | null;
  credit_time: Date | null;
  state: LaneTransfer["state"];
};

export class ReadModel {
  private readonly db: Queryable;
  constructor(db: Queryable) {
    this.db = db;
  }

  async tokenRow(symbol: string): Promise<TokenRow> {
    const r = await this.db.query<TokenRow>("select * from tokens where lower(symbol) = lower($1)", [symbol]);
    const row = r.rows[0];
    if (!row) throw notFound(`token ${symbol}`);
    return row;
  }

  async tokenRows(): Promise<TokenRow[]> {
    return (await this.db.query<TokenRow>("select * from tokens order by symbol")).rows;
  }

  async chainRows(): Promise<ChainRow[]> {
    return (await this.db.query<ChainRow>("select * from chains order by role desc, chain")).rows;
  }

  async homeChain(token: TokenRow): Promise<ChainRow> {
    const rows = await this.chainRows();
    const home = rows.find((c) => c.chain === token.home_chain);
    if (!home) throw notFound(`home chain deployment for ${token.symbol}`);
    return home;
  }

  /** MirrorMeta for the token's home ledger at the indexer's latest read. */
  async meta(token?: TokenRow): Promise<MirrorMeta> {
    const t = token ?? (await this.tokenRows())[0];
    if (!t) throw notFound("protected token");
    const home = await this.homeChain(t);
    const s = await this.db.query<{ block: string | null; block_time: Date | null }>(
      `select coalesce(cs.block, c.block) as block, coalesce(cs.block_time, c.block_time) as block_time
       from (select 1) x left join chain_state cs on cs.chain = $1 left join cursors c on c.chain = $1`,
      [home.chain],
    );
    const row = s.rows[0];
    return {
      source: "onchain-mirror",
      ledger: { chain: home.chain, address: home.ledger },
      block: { chain: home.chain, number: row?.block ?? "0", timestamp: iso(row?.block_time) },
      servedAt: new Date().toISOString(),
    };
  }

  summary(t: TokenRow): TokenSummary {
    return {
      symbol: t.symbol,
      tokenId: t.token_id as Bytes32,
      name: t.name,
      decimals: t.decimals,
      model: t.model,
      homeChain: t.home_chain as ChainKey,
      chains: t.chains.filter(isChainKey),
      status: t.status,
      reason: t.reason,
      delta: t.delta,
      epochId: t.epoch_id,
      updatedAt: iso(t.updated_at),
      stale: t.stale,
      activeIncidentId: (t.active_incident_id as Bytes32 | null) ?? null,
      specHash: t.spec_hash as Bytes32,
      simulation: t.simulation,
    };
  }

  private async latestEpoch(t: TokenRow): Promise<EpochSummary | null> {
    const r = await this.db.query<{ epoch_id: string; evaluated_at: Date; blocks_hash: string; evidence_hash: string }>(
      "select epoch_id, evaluated_at, blocks_hash, evidence_hash from epochs where token_symbol = $1 and chain = $2 order by epoch_id desc limit 1",
      [t.symbol, t.home_chain],
    );
    const e = r.rows[0];
    if (!e) return null;
    const txs = await this.db.query<{ chain: ChainKey; tx_hash: Hex; block: string; block_time: Date }>(
      "select chain, tx_hash, block, block_time from epochs where token_symbol = $1 and epoch_id = $2 order by chain",
      [t.symbol, e.epoch_id],
    );
    return {
      epochId: e.epoch_id,
      evaluatedAt: iso(e.evaluated_at),
      blocksHash: e.blocks_hash as Bytes32,
      evidenceHash: e.evidence_hash as Bytes32,
      reportTxs: txs.rows.map((x) => ({ chain: x.chain, hash: x.tx_hash, block: x.block, timestamp: iso(x.block_time) })),
    };
  }

  static txRef(chain: string | null, hash: string | null, block: string | null, time: Date | null): TxRef | null {
    const c = asChain(chain);
    if (c === null || hash === null) return null;
    return { chain: c, hash: hash as Hex, block: block ?? "0", timestamp: iso(time) };
  }

  static laneTransfer(m: MatchRow): LaneTransfer | null {
    const src = asChain(m.src_chain);
    const dst = asChain(m.dst_chain);
    if (src === null || dst === null) return null;
    return {
      messageId: m.message_id as Bytes32,
      bridge: m.bridge,
      srcChain: src,
      dstChain: dst,
      amount: m.amount,
      sender: (m.sender as Address | null) ?? null,
      recipient: (m.recipient as Address | null) ?? null,
      debitTx: ReadModel.txRef(m.debit_chain, m.debit_tx, m.debit_block, m.debit_time),
      creditTx: ReadModel.txRef(m.credit_chain, m.credit_tx, m.credit_block, m.credit_time),
      state: m.state,
      ccipMessageId: m.bridge === "ccip" ? (m.message_id as Bytes32) : null,
    };
  }

  async transfer(messageId: string, bridge: string): Promise<(LaneTransfer & { laneId: string }) | null> {
    const r = await this.db.query<MatchRow>("select * from matches where message_id = $1 and bridge = $2", [messageId, bridge]);
    const row = r.rows[0];
    const t = row ? ReadModel.laneTransfer(row) : null;
    return t ? { ...t, laneId: `${t.bridge}:${t.srcChain}->${t.dstChain}` } : null;
  }

  async status(symbol: string): Promise<TokenStatusResponse> {
    const t = await this.tokenRow(symbol);
    const [meta, chains, states, flights, epoch] = await Promise.all([
      this.meta(t),
      this.chainRows(),
      this.db.query<StateRow>("select * from chain_state where token_symbol = $1", [t.symbol]),
      this.db.query<{ src_chain: string; dst_chain: string | null; amount: string }>(
        `select src_chain, dst_chain, sum(amount)::text as amount from matches
         where token_symbol = $1 and state = 'in_flight' and debit_tx is not null group by src_chain, dst_chain`,
        [t.symbol],
      ),
      this.latestEpoch(t),
    ]);
    const stateOf = new Map(states.rows.map((s) => [s.chain, s]));
    const flightOut = new Map<string, bigint>();
    const flightIn = new Map<string, bigint>();
    for (const f of flights.rows) {
      flightOut.set(f.src_chain, (flightOut.get(f.src_chain) ?? 0n) + BigInt(f.amount));
      if (f.dst_chain) flightIn.set(f.dst_chain, (flightIn.get(f.dst_chain) ?? 0n) + BigInt(f.amount));
    }
    const cfg = t.config;
    let backing = 0n;
    let remoteSupply = 0n;
    let fOut = 0n;
    let fIn = 0n;
    const chainSupply: ChainSupply[] = [];
    for (const key of t.chains.filter(isChainKey)) {
      const c = chains.find((x) => x.chain === key);
      if (!c) continue;
      const s = stateOf.get(key);
      const isHome = key === t.home_chain;
      const escrowBal = s ? BigInt(s.escrow ?? "0") + BigInt(s.ccip_lockbox ?? "0") : 0n;
      const supply = s ? BigInt(s.supply) : 0n;
      const out = flightOut.get(key) ?? 0n;
      if (isHome) {
        backing += escrowBal;
        fOut += out;
      } else {
        remoteSupply += supply;
        fIn += out;
      }
      const pinned: BlockRef = { chain: key, number: s?.block ?? "0", timestamp: iso(s?.block_time) };
      const contracts: ChainContracts = {
        token: c.token,
        ledger: c.ledger,
        feed: c.feed,
        quarantineController: c.quarantine,
        escrow: isHome ? c.escrow : null,
        guard: isHome ? c.guard : null,
      };
      chainSupply.push({
        chain: key,
        selector: c.selector,
        role: isHome ? "home" : "remote",
        confidence: c.confidence,
        contracts,
        supply: (isHome ? supply - escrowBal : supply).toString(),
        escrow: isHome ? escrowBal.toString() : null,
        inFlightOut: out.toString(),
        inFlightIn: (flightIn.get(key) ?? 0n).toString(),
        pinnedBlock: pinned,
        ledgerStatus: s?.ledger_status ?? "UNKNOWN",
        frozen: s?.frozen ?? false,
        read:
          s === undefined
            ? { ok: false, error: "not read yet", lastGoodBlock: null, since: new Date().toISOString() }
            : s.read_ok
              ? { ok: true }
              : { ok: false, error: s.read_error ?? "RPC error", lastGoodBlock: pinned, since: iso(s.read_error_since) },
      });
    }
    const total = remoteSupply + fOut + fIn;
    const tolerance = BigInt(cfg.toleranceWei);
    const computedDelta = backing - total;
    const { bridges, lanes } = await this.lanes(t, chains, stateOf);
    return {
      ...meta,
      token: this.summary(t),
      epoch,
      backing: backing.toString(),
      claims: { remoteSupply: remoteSupply.toString(), inFlightOut: fOut.toString(), inFlightIn: fIn.toString(), total: total.toString() },
      tolerance: tolerance.toString(),
      unclaimedSurplus: (computedDelta > tolerance ? computedDelta - tolerance : 0n).toString(),
      stalenessSeconds: cfg.stalenessSeconds,
      onStale: cfg.onStale,
      chains: chainSupply,
      bridges,
      lanes,
    };
  }

  private async lanes(t: TokenRow, chains: ChainRow[], stateOf: Map<ChainKey, StateRow>): Promise<{ bridges: BridgeInfo[]; lanes: Lane[] }> {
    const offending = t.active_incident_id
      ? (
          await this.db.query<{ chain: string; bridge: string; claimed_src_chain: string | null }>(
            `select c.chain, c.bridge, c.claimed_src_chain from incidents i join credits c on c.tx_hash = i.offending_tx where i.id = $1 limit 1`,
            [t.active_incident_id],
          )
        ).rows[0]
      : undefined;
    const recent = await this.db.query<MatchRow & { rn: number }>(
      `select * from (
         select m.*, row_number() over (partition by bridge, src_chain, dst_chain order by coalesce(credit_time, debit_time) desc nulls last) as rn
         from matches m where token_symbol = $1) x where rn <= 10`,
      [t.symbol],
    );
    const bridges: BridgeInfo[] = [];
    const lanes: Lane[] = [];
    for (const b of t.config.bridges) {
      const kind: BridgeKind = b.kind;
      const contracts: Partial<Record<ChainKey, Address>> = {};
      for (const key of b.chains) {
        const c = chains.find((x) => x.chain === key);
        const addr = kind === "ccip_v2" ? c?.ccip_pool : key === t.home_chain ? (c?.escrow ?? c?.weak_bridge) : c?.weak_bridge;
        if (addr) contracts[key] = addr;
      }
      bridges.push({ id: b.id, kind, label: kind === "ccip_v2" ? "CCIP 2.0" : b.id === "weakbridge" ? "WeakBridge (1-of-1 verifier)" : b.id, contracts });
      for (const src of b.chains) {
        for (const dst of b.chains) {
          if (src === dst) continue;
          const frozen = kind === "ccip_v2" && ((stateOf.get(src)?.frozen ?? false) || (stateOf.get(dst)?.frozen ?? false));
          lanes.push({
            id: `${b.id}:${src}->${dst}`,
            bridge: b.id,
            bridgeKind: kind,
            srcChain: src,
            dstChain: dst,
            frozen,
            offending: offending?.bridge === b.id && offending.chain === dst && offending.claimed_src_chain === src,
            recentTransfers: recent.rows
              .filter((m) => m.bridge === b.id && m.src_chain === src && m.dst_chain === dst)
              .map((m) => ReadModel.laneTransfer(m))
              .filter((x): x is LaneTransfer => x !== null),
          });
        }
      }
    }
    return { bridges, lanes };
  }

  /** Home-ledger Δ history: EPOCH reports and BREACH reports, newest first. Cursor = (block, logIndex). */
  async epochs(symbol: string, limit: number, cursor: (string | number)[] | null, since: Date | null): Promise<{ items: EpochPoint[]; nextCursor: [string, number] | null }> {
    const t = await this.tokenRow(symbol);
    const params: unknown[] = [t.symbol, t.home_chain, limit + 1];
    let where = "";
    if (cursor) {
      params.push(String(cursor[0]), Number(cursor[1]));
      where += ` and (block < $4 or (block = $4 and log_index < $5))`;
    }
    if (since) {
      params.push(since);
      where += ` and evaluated_at >= $${params.length}`;
    }
    const r = await this.db.query<{
      epoch_id: string;
      evaluated_at: Date;
      blocks_hash: string;
      evidence_hash: string;
      delta: string;
      status: TokenStatus;
      reason: ReasonCode;
      block: string;
      log_index: number;
      kind: "epoch" | "breach";
    }>(
      `select * from (
         select epoch_id::text, evaluated_at, blocks_hash, evidence_hash, delta::text, status, reason, block, log_index, 'epoch' as kind
         from epochs where token_symbol = $1 and chain = $2
         union all
         select coalesce(epoch_id, 0)::text, block_time, '0x', evidence_hash, coalesce(delta, 0)::text, 'BROKEN', reason, block, log_index, 'breach'
         from breaches where token_symbol = $1 and chain = $2
       ) x where true ${where} order by block desc, log_index desc limit $3`,
      params,
    );
    const rows = r.rows.slice(0, limit);
    const incidents = await this.db.query<{ id: string; opened_at: Date; resolved_at: Date | null; evidence_hash: string }>(
      "select id, opened_at, resolved_at, evidence_hash from incidents where token_symbol = $1",
      [t.symbol],
    );
    const items: EpochPoint[] = [];
    for (const e of rows) {
      const txs = await this.db.query<{ chain: ChainKey; tx_hash: Hex; block: string; block_time: Date }>(
        e.kind === "epoch"
          ? "select chain, tx_hash, block, block_time from epochs where token_symbol = $1 and epoch_id = $2 order by chain"
          : "select chain, tx_hash, block, block_time from breaches where token_symbol = $1 and evidence_hash = $2 order by chain",
        [t.symbol, e.kind === "epoch" ? e.epoch_id : e.evidence_hash],
      );
      const at = e.evaluated_at.getTime();
      const inc =
        incidents.rows.find((i) => i.evidence_hash === e.evidence_hash) ??
        incidents.rows.find((i) => i.opened_at.getTime() <= at && (i.resolved_at === null || i.resolved_at.getTime() >= at));
      items.push({
        epochId: e.epoch_id,
        evaluatedAt: iso(e.evaluated_at),
        blocksHash: e.blocks_hash as Bytes32,
        evidenceHash: e.evidence_hash as Bytes32,
        reportTxs: txs.rows.map((x) => ({ chain: x.chain, hash: x.tx_hash, block: x.block, timestamp: iso(x.block_time) })),
        delta: e.delta,
        status: e.status,
        reason: e.reason,
        incidentId: (inc?.id as Bytes32 | undefined) ?? null,
      });
    }
    const last = rows[rows.length - 1];
    return { items, nextCursor: r.rows.length > limit && last ? [last.block, last.log_index] : null };
  }

  async epochPoint(symbol: string, chain: string, txHash: string, logIndex: number): Promise<EpochPoint | null> {
    const r = await this.db.query<{ block: string }>("select block from epochs where chain = $1 and tx_hash = $2 and log_index = $3", [chain, txHash, logIndex]);
    const row = r.rows[0];
    if (!row) return null;
    const page = await this.epochs(symbol, 1, [String(BigInt(row.block) + 1n), 0], null);
    return page.items[0] ?? null;
  }

  static verdict(v: VerdictRow, execution: TxRef | null): Verdict {
    const src = asChain(v.src_chain) ?? "ethereum-testnet-sepolia";
    return {
      id: `ccv:${v.message_id}`,
      messageId: v.message_id as Bytes32,
      evaluatedAt: iso(v.evaluated_at),
      bridge: "ccip",
      srcChain: src,
      dstChain: asChain(v.dst_chain) ?? src,
      amount: v.amount,
      sender: v.sender as Address,
      receiver: v.receiver as Address,
      decision: v.decision,
      reason: v.reason,
      note: v.note,
      cells: v.cells,
      sourceTx: ReadModel.txRef(src, v.source_tx, v.source_block, v.source_time ?? v.evaluated_at) ?? {
        chain: src,
        hash: v.message_id as Hex,
        block: "0",
        timestamp: iso(v.evaluated_at),
      },
      executionTx: execution,
      incidentId: (v.incident_id as Bytes32 | null) ?? null,
    };
  }

  async verdicts(symbol: string, limit: number, cursor: (string | number)[] | null, extra: { incidentId?: string } = {}): Promise<{ items: Verdict[]; nextCursor: [string, string] | null }> {
    const t = await this.tokenRow(symbol);
    const params: unknown[] = [t.symbol, limit + 1];
    let where = "";
    if (cursor) {
      params.push(new Date(String(cursor[0])), String(cursor[1]));
      where += " and (v.evaluated_at < $3 or (v.evaluated_at = $3 and v.message_id < $4))";
    }
    if (extra.incidentId) {
      params.push(extra.incidentId);
      where += ` and v.incident_id = $${params.length}`;
    }
    const r = await this.db.query<VerdictRow & { credit_chain: string | null; credit_tx: string | null; credit_block: string | null; credit_time: Date | null }>(
      `select v.*, m.credit_chain, m.credit_tx, m.credit_block, m.credit_time
       from verdicts v left join matches m on m.message_id = v.message_id and m.bridge = 'ccip'
       where v.token_symbol = $1 ${where} order by v.evaluated_at desc, v.message_id desc limit $2`,
      params,
    );
    const rows = r.rows.slice(0, limit);
    const items = rows.map((v) => ReadModel.verdict(v, ReadModel.txRef(v.credit_chain, v.credit_tx, v.credit_block, v.credit_time)));
    const last = rows[rows.length - 1];
    return { items, nextCursor: r.rows.length > limit && last ? [last.evaluated_at.toISOString(), last.message_id] : null };
  }

  async verdict(messageId: string): Promise<Verdict | null> {
    const r = await this.db.query<VerdictRow & { credit_chain: string | null; credit_tx: string | null; credit_block: string | null; credit_time: Date | null }>(
      `select v.*, m.credit_chain, m.credit_tx, m.credit_block, m.credit_time
       from verdicts v left join matches m on m.message_id = v.message_id and m.bridge = 'ccip' where v.message_id = $1`,
      [messageId.toLowerCase()],
    );
    const v = r.rows[0];
    return v ? ReadModel.verdict(v, ReadModel.txRef(v.credit_chain, v.credit_tx, v.credit_block, v.credit_time)) : null;
  }

  ledgerRef(chain: ChainRow): LedgerRef {
    return { chain: chain.chain, address: chain.ledger };
  }

  chainLabel(chain: ChainKey): string {
    return CHAINS[chain].label;
  }
}

export type VerdictRow = {
  message_id: string;
  token_symbol: string;
  evaluated_at: Date;
  src_chain: string;
  dst_chain: string;
  amount: string;
  sender: string;
  receiver: string;
  decision: "PASS" | "FAIL";
  reason: ReasonCode;
  note: string;
  cells: Verdict["cells"];
  source_tx: string | null;
  source_block: string | null;
  source_time: Date | null;
  incident_id: string | null;
};
