import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import { createChainClient, ChainIndexer, bootstrap, createDb, migrate, resetSchema, tokenConfigFromSpec, incidentIdOf, type Db, type IndexerConfig } from "../src/index.ts";
import { ACCOUNTS, TOKEN_ID, World } from "./world.ts";

const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://kirchhoff:kirchhoff@127.0.0.1:5434/kirchhoff_test";
const HOME = "ethereum-testnet-sepolia" as const;
const ARB = "ethereum-testnet-sepolia-arbitrum-1" as const;
const BASE = "ethereum-testnet-sepolia-base-1" as const;

let world: World;
let db: Db;
let cfg: IndexerConfig;

function makeConfig(w: World): IndexerConfig {
  const specYaml = readFileSync(join(import.meta.dirname, "..", "..", "engine", "specs", "kETH.yaml"), "utf8");
  return {
    mode: "local",
    symbol: "kETH",
    deployments: w.deployments,
    token: tokenConfigFromSpec(specYaml),
    specYaml,
    rpc: w.rpc,
    followTag: "latest",
    pollMs: 200,
    maxChunk: 50n,
    defaultLookback: 1000n,
  };
}

async function tickAll(): Promise<void> {
  for (const chain of [HOME, ARB, BASE]) {
    const ix = new ChainIndexer(db, cfg, chain, { log: () => undefined }, createChainClient(chain, "local", world.rpc[chain]));
    await ix.tick();
  }
}

beforeAll(async () => {
  world = await World.start();
  db = createDb(TEST_DB, { max: 4 });
  await resetSchema(db);
  await migrate(db);
  cfg = makeConfig(world);
  await bootstrap(db, cfg, "Kirchhoff ETH");
}, 300_000);

afterAll(async () => {
  await db.end();
  await world.stop();
});

describe("indexer against a private three-chain Anvil world", () => {
  it("mirrors a settled WeakBridge round trip and a CONSERVED epoch", async () => {
    const amount = 10n * 10n ** 18n;
    const { id } = await world.bridgeSend(HOME, ARB, amount);
    await world.bridgeCredit(ARB, id, ACCOUNTS.user.address, amount, HOME);
    for (const c of [HOME, ARB, BASE]) await world.epoch(c, 1n, 0n, [id]);
    await tickAll();

    const m = await db.query("select state, src_chain, dst_chain, amount from matches where message_id = $1", [id.toLowerCase()]);
    expect(m.rows).toEqual([{ state: "settled", src_chain: HOME, dst_chain: ARB, amount: amount.toString() }]);
    const e = await db.query("select chain, epoch_id, status, evidence_hash from epochs order by chain");
    expect(e.rows).toHaveLength(3);
    expect(e.rows[0]).toMatchObject({ epoch_id: "1", status: "CONSERVED", evidence_hash: keccak256(toHex("evidence:1")) });
    const t = await db.query("select status, delta, epoch_id, stale from tokens where symbol = 'kETH'");
    expect(t.rows[0]).toMatchObject({ status: "CONSERVED", delta: "0", epoch_id: "1", stale: false });
    const s = await db.query("select chain, supply, escrow from chain_state order by chain");
    expect(s.rows.find((r: { chain: string }) => r.chain === HOME)).toMatchObject({ escrow: amount.toString() });
    expect(s.rows.find((r: { chain: string }) => r.chain === ARB)).toMatchObject({ supply: amount.toString() });
  });

  it("records the Kelp-style forgery as a forged credit, a BREACH on all chains, one incident, and quarantine", async () => {
    const forgedId = keccak256(toHex("forged-message"));
    const amount = 5n * 10n ** 18n;
    const tx = await world.bridgeCredit(HOME, forgedId, ACCOUNTS.attacker.address, amount, ARB);
    const evidenceHash = keccak256(toHex("evidence:forgery"));
    for (const c of [HOME, ARB, BASE]) {
      await world.breach(c, { epochId: 2n, delta: -amount, evidenceHash, reason: 2, offendingChain: HOME, offendingTx: tx, recipient: ACCOUNTS.attacker.address, amount, messageId: forgedId });
    }
    const incidentId = incidentIdOf(TOKEN_ID, evidenceHash).toLowerCase() as Hex;
    await world.quarantine(HOME, incidentId, [ACCOUNTS.attacker.address]);
    await tickAll();

    const m = await db.query("select state from matches where message_id = $1", [forgedId]);
    expect(m.rows[0]).toEqual({ state: "forged" });
    const b = await db.query("select count(*)::int as n from breaches where incident_id = $1", [incidentId]);
    expect(b.rows[0]).toEqual({ n: 3 });
    const i = await db.query("select id, reason, offending_chain, message_id, status from incidents");
    expect(i.rows).toEqual([{ id: incidentId, reason: "DEBIT_NOT_FOUND", offending_chain: HOME, message_id: forgedId, status: "open" }]);
    const taint = await db.query("select account, active from taints where chain = $1", [HOME]);
    expect(taint.rows).toEqual([{ account: ACCOUNTS.attacker.address.toLowerCase(), active: true }]);
    const tok = await db.query("select status, active_incident_id from tokens");
    expect(tok.rows[0]).toEqual({ status: "QUARANTINED", active_incident_id: incidentId });
    const st = await db.query("select frozen from chain_state where chain = $1", [HOME]);
    expect(st.rows[0]).toEqual({ frozen: true });
    const kinds = await db.query<{ kind: string }>("select distinct kind from incident_actions where incident_id = $1 order by kind", [incidentId]);
    expect(kinds.rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["breach_report", "lanes_frozen", "tainted"]));
  });

  it("is idempotent: re-indexing from scratch yields the same rows", async () => {
    const before = await db.query("select count(*)::int as n from (select * from debits union all select chain, tx_hash, log_index, block, block_time, token_symbol, bridge, message_id, dst_chain, claimed_src_chain, claimed_src_selector, amount, recipient, null from credits) x");
    await db.query("delete from cursors");
    await tickAll();
    const after = await db.query("select count(*)::int as n from (select * from debits union all select chain, tx_hash, log_index, block, block_time, token_symbol, bridge, message_id, dst_chain, claimed_src_chain, claimed_src_selector, amount, recipient, null from credits) x");
    expect(after.rows[0]).toEqual(before.rows[0]);
    const inc = await db.query("select count(*)::int as n from incidents");
    expect(inc.rows[0]).toEqual({ n: 1 });
  });

  it("rewinds rows above the fork point when a stored block hash no longer matches (reorg)", async () => {
    const homeRpc = world.chains[HOME];
    const snapshotId = await homeRpc.pub.request({ method: "evm_snapshot" as never, params: [] as never });
    const { id } = await world.bridgeSend(HOME, BASE, 10n ** 18n);
    await tickAll();
    expect((await db.query("select 1 from debits where message_id = $1", [id.toLowerCase()])).rowCount).toBe(1);
    await homeRpc.pub.request({ method: "evm_revert" as never, params: [snapshotId] as never });
    // Mine different blocks at the same heights so the stored hash diverges.
    for (let i = 0; i < 6; i++) await homeRpc.pub.request({ method: "evm_mine" as never, params: [] as never });
    await tickAll();
    expect((await db.query("select 1 from debits where message_id = $1", [id.toLowerCase()])).rowCount).toBe(0);
    expect((await db.query("select 1 from matches where message_id = $1", [id.toLowerCase()])).rowCount).toBe(0);
  });
});
