import { keccak256, stringToBytes, type BlockTag, type Hex, type PublicClient } from "viem";
import {
  CHAINS,
  erc20Abi,
  ledgerAbi,
  quarantineAbi,
  reasonFromValue,
  registryAbi,
  statusFromValue,
  type ChainDeploymentInfo,
  type ChainKey,
} from "@kirchhoff/sdk";
import type { IndexerConfig } from "./config.ts";
import { withTransaction, type Db, type Queryable } from "./db.ts";
import { decodeLogs, watchedAddresses, type RawLog } from "./decode.ts";
import { applyEvents, eventKey, incidentIdOf, rewindChain, type Enrichment } from "./store.ts";
import { createChainClient, redactRpcError } from "./rpc.ts";

const HASH_RETENTION = 512n;
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

export type IndexerHooks = {
  /** Called after commit for each incident first seen (the Notifier). Failures are logged, never fatal. */
  onIncident?: (incidentId: string) => Promise<void>;
  log?: (msg: string) => void;
};

export function tokenIdOf(symbol: string): Hex {
  return keccak256(stringToBytes(symbol));
}

type Head = { number: bigint; hash: Hex; time: Date };

async function headAt(client: PublicClient, tag: BlockTag): Promise<Head> {
  const block = await client.getBlock({ blockTag: tag });
  if (block.number === null || block.hash === null) throw new Error(`no ${tag} block yet`);
  return { number: block.number, hash: block.hash, time: new Date(Number(block.timestamp) * 1000) };
}

async function blockAt(client: PublicClient, n: bigint): Promise<Head> {
  const block = await client.getBlock({ blockNumber: n });
  return { number: n, hash: block.hash, time: new Date(Number(block.timestamp) * 1000) };
}

/** Upserts static chain and token rows from config. Idempotent; called at every start. */
export async function bootstrap(db: Db, cfg: IndexerConfig, tokenName: string): Promise<void> {
  const home = cfg.deployments.chains[cfg.token.homeChain];
  await withTransaction(db, async (client) => {
    // A redeploy (new ledger address on any chain) makes every mirrored row stale: start the mirror over.
    const prev = await client.query<{ chain: string; ledger: string }>("select chain, ledger from chains");
    const moved = prev.rows.some((r) => {
      const d = cfg.deployments.chains[r.chain as ChainKey];
      return d !== undefined && d.ledger.toLowerCase() !== r.ledger.toLowerCase();
    });
    if (moved) {
      for (const table of ["debits", "credits", "matches", "epochs", "status_changes", "breaches", "incidents", "incident_actions", "taints", "chain_state", "cursors", "block_hashes", "verdicts", "judge_verdicts", "stream_events", "lab_runs", "notifications"]) {
        await client.query(`delete from ${table}`);
      }
      await client.query("delete from specs where source = 'registry'");
    }
    for (const chain of cfg.token.chains) {
      const d = cfg.deployments.chains[chain];
      if (!d) continue;
      await client.query(
        `insert into chains (chain, selector, chain_id, mode, role, confidence, ledger, quarantine, feed, guard, registry, token, escrow,
                             weak_bridge, ccip_pool, ccip_lockbox, on_ramp, off_ramp, token_admin_registry, lending_market, issuer_safe, deployed_at_block, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,now())
         on conflict (chain) do update set selector = excluded.selector, chain_id = excluded.chain_id, mode = excluded.mode, role = excluded.role,
           confidence = excluded.confidence, ledger = excluded.ledger, quarantine = excluded.quarantine, feed = excluded.feed, guard = excluded.guard,
           registry = excluded.registry, token = excluded.token, escrow = excluded.escrow, weak_bridge = excluded.weak_bridge,
           ccip_pool = excluded.ccip_pool, ccip_lockbox = excluded.ccip_lockbox, on_ramp = excluded.on_ramp, off_ramp = excluded.off_ramp,
           token_admin_registry = excluded.token_admin_registry, lending_market = excluded.lending_market, issuer_safe = excluded.issuer_safe,
           deployed_at_block = excluded.deployed_at_block, updated_at = now()`,
        [
          chain,
          CHAINS[chain].selector.toString(),
          d.chainId,
          d.mode,
          d.role,
          cfg.token.confidence[chain],
          d.ledger,
          d.quarantine,
          d.feed,
          d.guard,
          d.registry,
          d.token,
          d.escrow,
          d.weakBridge,
          d.ccipPool,
          d.ccipLockBox,
          d.onRamp,
          d.offRamp,
          d.tokenAdminRegistry,
          d.lendingMarket,
          d.issuerSafe ?? home?.issuerSafe ?? null,
          d.deployedAtBlock?.toString() ?? null,
        ],
      );
    }
    await client.query(
      `insert into tokens (symbol, token_id, name, decimals, model, home_chain, chains, simulation, spec_yaml, config)
       values ($1,$2,$3,$4,$5,$6,$7,true,$8,$9)
       on conflict (symbol) do update set name = excluded.name, decimals = excluded.decimals, model = excluded.model,
         home_chain = excluded.home_chain, chains = excluded.chains, spec_yaml = excluded.spec_yaml, config = excluded.config`,
      [
        cfg.symbol,
        tokenIdOf(cfg.symbol).toLowerCase(),
        tokenName,
        cfg.token.decimals,
        cfg.token.model,
        cfg.token.homeChain,
        cfg.token.chains,
        cfg.specYaml,
        JSON.stringify(cfg.token),
      ],
    );
  });
}

export class ChainIndexer {
  readonly chain: ChainKey;
  private readonly dep: ChainDeploymentInfo;
  private readonly client: PublicClient;
  private readonly tag: BlockTag;
  private chunk: bigint;
  private readonly tokenId: Hex;
  private readonly db: Db;
  private readonly cfg: IndexerConfig;
  private readonly hooks: IndexerHooks;

  constructor(db: Db, cfg: IndexerConfig, chain: ChainKey, hooks: IndexerHooks = {}, client?: PublicClient) {
    this.db = db;
    this.cfg = cfg;
    this.hooks = hooks;
    const dep = cfg.deployments.chains[chain];
    if (!dep) throw new Error(`no deployment for ${chain}`);
    this.chain = chain;
    this.dep = dep;
    this.client = client ?? createChainClient(chain, cfg.mode, cfg.rpc[chain]);
    this.tag = cfg.followTag === "spec" ? cfg.token.confidence[chain] : cfg.followTag;
    this.chunk = cfg.maxChunk;
    this.tokenId = tokenIdOf(cfg.symbol).toLowerCase() as Hex;
  }

  private log(msg: string): void {
    (this.hooks.log ?? ((m: string) => { console.warn(m); }))(`[indexer ${CHAINS[this.chain].alias}] ${msg}`);
  }

  /** One pass: reorg check, catch up to the confidence head in chunks, then refresh the snapshot. */
  async tick(): Promise<{ indexedTo: bigint; events: number }> {
    const head = await headAt(this.client, this.tag);
    let cursor = await this.loadCursor();
    if (cursor !== null) cursor = await this.checkReorg(cursor);
    let from = cursor === null ? await this.startBlock(head.number) : cursor + 1n;
    let total = 0;
    while (from <= head.number) {
      const to = from + this.chunk - 1n < head.number ? from + this.chunk - 1n : head.number;
      let logs: RawLog[];
      try {
        logs = (await this.client.getLogs({ address: watchedAddresses(this.dep), fromBlock: from, toBlock: to }));
      } catch (e) {
        if (this.chunk > 10n) {
          // Providers cap eth_getLogs ranges differently; halve and retry the same window.
          this.chunk = this.chunk / 2n;
          this.log(`getLogs ${from.toString()}-${to.toString()} failed (${redactRpcError(e)}); chunk now ${this.chunk.toString()}`);
          continue;
        }
        throw e;
      }
      total += await this.persistRange(logs, to);
      from = to + 1n;
    }
    await this.snapshot(head);
    return { indexedTo: head.number, events: total };
  }

  /**
   * First block to index: the recorded deployment block, else the ledger's creation block found by
   * binary search over eth_getCode (needs an archive-capable RPC), else a fixed lookback window.
   */
  private async startBlock(head: bigint): Promise<bigint> {
    const deployed = this.dep.deployedAtBlock;
    if (deployed !== null) return deployed > 50n ? deployed - 50n : 0n;
    const hasCode = async (n: bigint): Promise<boolean> => {
      const code = await this.client.getCode({ address: this.dep.ledger, blockNumber: n });
      return code !== undefined && code !== "0x";
    };
    try {
      if (await hasCode(head)) {
        let lo = 0n;
        let hi = head;
        while (lo < hi) {
          const mid = (lo + hi) / 2n;
          if (await hasCode(mid)) hi = mid;
          else lo = mid + 1n;
        }
        this.log(`ledger created at block ${lo.toString()}; indexing from there`);
        return lo;
      }
    } catch (e) {
      this.log(`deployment block search failed (${redactRpcError(e)}); using the lookback window`);
    }
    return head > this.cfg.defaultLookback ? head - this.cfg.defaultLookback : 0n;
  }


  private async loadCursor(): Promise<bigint | null> {
    const r = await this.db.query<{ block: string }>("select block from cursors where chain = $1", [this.chain]);
    const row = r.rows[0];
    return row ? BigInt(row.block) : null;
  }

  /**
   * Compares stored block hashes (newest first) with the chain; the newest one that still matches
   * is the common ancestor. Rows above it are rewound and re-indexed on the next pass.
   */
  private async checkReorg(cursor: bigint): Promise<bigint> {
    const stored = await this.db.query<{ number: string; hash: string }>(
      "select number, hash from block_hashes where chain = $1 and number <= $2 order by number desc limit 64",
      [this.chain, cursor.toString()],
    );
    let ancestor: Head | null = null;
    for (const row of stored.rows) {
      const live = await blockAt(this.client, BigInt(row.number)).catch(() => null);
      if (live !== null && live.hash.toLowerCase() === row.hash) {
        ancestor = live;
        break;
      }
    }
    if (stored.rows.length === 0) return cursor;
    if (ancestor === null) throw new Error(`reorg deeper than the stored hash window on ${this.chain}; reset the cursor`);
    if (ancestor.number === cursor) return cursor;
    const n = ancestor.number;
    const anc = ancestor;
    this.log(`reorg detected: rewinding from ${cursor.toString()} to ${n.toString()}`);
    await withTransaction(this.db, async (client) => {
      await rewindChain(client, this.chain, n);
      await client.query("update cursors set block = $2, block_hash = $3, block_time = $4, updated_at = now() where chain = $1", [
        this.chain,
        n.toString(),
        anc.hash.toLowerCase(),
        anc.time,
      ]);
    });
    return n;
  }

  private async enrich(events: ReturnType<typeof decodeLogs>): Promise<Enrichment> {
    const out: Enrichment = { epochs: new Map(), breaches: new Map() };
    for (const ev of events) {
      if (ev.kind === "EpochRecorded" && ev.tokenId.toLowerCase() === this.tokenId) {
        const epoch = await this.client
          .readContract({ address: this.dep.ledger, abi: ledgerAbi, functionName: "latestEpoch", args: [this.tokenId], blockNumber: ev.block })
          .catch(() => null);
        if (epoch?.epochId === ev.epochId) {
          out.epochs.set(eventKey(ev.txHash, ev.logIndex), {
            reason: epoch.reason,
            evaluatedAt: epoch.evaluatedAt,
            blocksHash: epoch.blocksHash,
            evidenceHash: epoch.evidenceHash,
          });
        }
      } else if (ev.kind === "BreachRecorded" && ev.tokenId.toLowerCase() === this.tokenId) {
        const breach = await this.client
          .readContract({ address: this.dep.ledger, abi: ledgerAbi, functionName: "breachOf", args: [incidentIdOf(this.tokenId, ev.evidenceHash)], blockNumber: ev.block })
          .catch(() => null);
        // Loop Rule breaches carry no message id; their delta and pinned blocks still matter.
        if (breach) {
          out.breaches.set(eventKey(ev.txHash, ev.logIndex), {
            messageId: breach.messageId === ZERO32 ? null : breach.messageId,
            delta: breach.delta,
            epochId: breach.epochId,
            blocksHash: breach.blocksHash,
          });
        }
      }
    }
    return out;
  }

  private async persistRange(logs: RawLog[], to: bigint): Promise<number> {
    const events = decodeLogs(logs, this.dep);
    const blocks = new Set<bigint>(events.map((e) => e.block));
    blocks.add(to);
    const times = new Map<bigint, Date>();
    let toHead: Head | null = null;
    for (const b of blocks) {
      const blk = await blockAt(this.client, b);
      times.set(b, blk.time);
      if (b === to) toHead = blk;
    }
    if (toHead === null) throw new Error("unreachable: range end block not fetched");
    const enrichment = await this.enrich(events);
    const endHead = toHead;
    const result = await withTransaction(this.db, async (client) => {
      const r = await applyEvents(
        client,
        events,
        { chain: this.chain, isHome: this.dep.role === "home", symbol: this.cfg.symbol, tokenId: this.tokenId, blockTimes: times },
        enrichment,
      );
      await client.query("insert into block_hashes (chain, number, hash) values ($1,$2,$3) on conflict (chain, number) do update set hash = excluded.hash", [
        this.chain,
        to.toString(),
        endHead.hash.toLowerCase(),
      ]);
      await client.query("delete from block_hashes where chain = $1 and number < $2", [this.chain, (to > HASH_RETENTION ? to - HASH_RETENTION : 0n).toString()]);
      await client.query(
        `insert into cursors (chain, block, block_hash, block_time) values ($1,$2,$3,$4)
         on conflict (chain) do update set block = excluded.block, block_hash = excluded.block_hash, block_time = excluded.block_time, updated_at = now()`,
        [this.chain, to.toString(), endHead.hash.toLowerCase(), endHead.time],
      );
      return r;
    });
    for (const id of result.newIncidents) {
      await this.hooks.onIncident?.(id).catch((e: unknown) => {
        this.log(`notifier failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    return events.length;
  }

  /** Reads supply, escrow, ledger status and freeze flag at the head and records read health. */
  async snapshot(head: Head): Promise<void> {
    const d = this.dep;
    const at = { blockNumber: head.number } as const;
    try {
      const [supply, status, frozen, escrow, lockbox] = await Promise.all([
        this.client.readContract({ address: d.token, abi: erc20Abi, functionName: "totalSupply", ...at }),
        this.client.readContract({ address: d.ledger, abi: ledgerAbi, functionName: "statusOf", args: [this.tokenId], ...at }),
        this.client.readContract({ address: d.quarantine, abi: quarantineAbi, functionName: "isFrozen", args: [this.tokenId], ...at }),
        d.role === "home" && d.escrow
          ? this.client.readContract({ address: d.token, abi: erc20Abi, functionName: "balanceOf", args: [d.escrow], ...at })
          : Promise.resolve(null),
        d.role === "home" && d.ccipLockBox
          ? this.client.readContract({ address: d.token, abi: erc20Abi, functionName: "balanceOf", args: [d.ccipLockBox], ...at })
          : Promise.resolve(null),
      ]);
      const [statusValue, delta, updatedAt, stale] = status;
      const epoch = await this.client
        .readContract({ address: d.ledger, abi: ledgerAbi, functionName: "latestEpoch", args: [this.tokenId], ...at })
        .catch(() => null);
      const reason = epoch ? reasonFromValue(epoch.reason) : "OK";
      const ledgerStatus = statusFromValue(statusValue);
      const updatedAtDate = updatedAt > 0n ? new Date(Number(updatedAt) * 1000) : null;
      const tokenReads = d.role === "home" ? await this.tokenReads(head) : null;
      // chain_state and the token row change in one transaction, so every reader sees one block's status.
      await withTransaction(this.db, async (tx) => {
      const prev = await tx.query<{ ledger_status: string; ledger_delta: string; frozen: boolean }>(
        "select ledger_status, ledger_delta, frozen from chain_state where chain = $1 for update",
        [this.chain],
      );
      await tx.query(
        `insert into chain_state (chain, token_symbol, block, block_time, supply, escrow, ccip_lockbox, ledger_status, ledger_reason, ledger_delta,
                                  ledger_updated_at, ledger_stale, frozen, read_ok, read_error, read_error_since, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,null,null,now())
         on conflict (chain) do update set block = excluded.block, block_time = excluded.block_time, supply = excluded.supply, escrow = excluded.escrow,
           ccip_lockbox = excluded.ccip_lockbox, ledger_status = excluded.ledger_status, ledger_reason = excluded.ledger_reason,
           ledger_delta = excluded.ledger_delta, ledger_updated_at = excluded.ledger_updated_at, ledger_stale = excluded.ledger_stale,
           frozen = excluded.frozen, read_ok = true, read_error = null, read_error_since = null, updated_at = now()`,
        [
          this.chain,
          this.cfg.symbol,
          head.number.toString(),
          head.time,
          supply.toString(),
          escrow?.toString() ?? null,
          lockbox?.toString() ?? null,
          ledgerStatus,
          reason,
          delta.toString(),
          updatedAtDate,
          stale,
          frozen,
        ],
      );
      if (tokenReads) await this.writeToken(tx, tokenReads, ledgerStatus, reason, delta, updatedAtDate, stale, epoch?.epochId ?? 0n);
      const p = prev.rows[0];
      if (p?.ledger_status !== ledgerStatus || p.ledger_delta !== delta.toString() || p.frozen !== frozen) {
        await tx.query("insert into stream_events (token_symbol, channel, ref) values ($1, 'status', $2)", [this.cfg.symbol, JSON.stringify({ chain: this.chain })]);
      }
      });
    } catch (e) {
      const msg = redactRpcError(e);
      await this.db.query(
        `update chain_state set read_ok = false, read_error = $2, read_error_since = coalesce(read_error_since, now()), updated_at = now() where chain = $1`,
        [this.chain, msg],
      );
      throw e;
    }
  }

  private async tokenReads(head: Head): Promise<{ incident: Hex | null; specHash: Hex | null }> {
    const d = this.dep;
    const at = { blockNumber: head.number } as const;
    const [incident, specHash] = await Promise.all([
      this.client.readContract({ address: d.ledger, abi: ledgerAbi, functionName: "activeIncident", args: [this.tokenId], ...at }).catch(() => null),
      d.registry
        ? this.client.readContract({ address: d.registry, abi: registryAbi, functionName: "activeSpecHash", args: [this.tokenId], ...at }).catch(() => null)
        : Promise.resolve(null),
    ]);
    return { incident, specHash };
  }

  private async writeToken(
    tx: Queryable,
    reads: { incident: Hex | null; specHash: Hex | null },
    status: string,
    reason: string,
    delta: bigint,
    updatedAt: Date | null,
    stale: boolean,
    epochId: bigint,
  ): Promise<void> {
    const { incident, specHash } = reads;
    await tx.query(
      `update tokens set status = $2, reason = $3, delta = $4, updated_at = $5, stale = $6, epoch_id = $7,
         active_incident_id = case when $8::text is null then active_incident_id when $8 = $10 then null else $8 end,
         spec_hash = coalesce($9, spec_hash)
       where symbol = $1`,
      [
        this.cfg.symbol,
        status,
        reason,
        delta.toString(),
        updatedAt,
        stale,
        epochId.toString(),
        incident?.toLowerCase() ?? null,
        specHash && specHash !== ZERO32 ? specHash.toLowerCase() : null,
        ZERO32,
      ],
    );
  }

}

/** Runs every chain's indexer until `signal` aborts. A failing chain backs off without stopping the others. */
export async function runIndexer(db: Db, cfg: IndexerConfig, hooks: IndexerHooks, signal: AbortSignal, clients?: Partial<Record<ChainKey, PublicClient>>): Promise<void> {
  const home = cfg.deployments.chains[cfg.token.homeChain];
  if (!home) throw new Error("home deployment missing");
  const homeClient = clients?.[cfg.token.homeChain] ?? createChainClient(cfg.token.homeChain, cfg.mode, cfg.rpc[cfg.token.homeChain]);
  const name = await homeClient.readContract({ address: home.token, abi: erc20Abi, functionName: "name" }).catch(() => cfg.symbol);
  await bootstrap(db, cfg, name);
  const indexers = cfg.token.chains.map((c) => new ChainIndexer(db, cfg, c, hooks, c === cfg.token.homeChain ? homeClient : clients?.[c]));
  await Promise.all(
    indexers.map(async (ix) => {
      let backoff = cfg.pollMs;
      while (!signal.aborted) {
        try {
          await ix.tick();
          backoff = cfg.pollMs;
        } catch (e) {
          backoff = Math.min(backoff * 2, 30_000);
          (hooks.log ?? console.warn)(`[indexer ${ix.chain}] tick failed: ${redactRpcError(e)}; retry in ${backoff}ms`);
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, backoff);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      }
    }),
  );
}
