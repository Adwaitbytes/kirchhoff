import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { createDb, migrate, resetSchema, type Db } from "../src/db.ts";
import { decodeLogs, type RawLog } from "../src/decode.ts";
import { Notifier, channelsFromEnv, incidentText } from "../src/notifier.ts";
import { ingestVerdict, parseVerdictReport, VerdictValidationError } from "../src/verdicts.ts";
import type { ChainDeploymentInfo } from "@kirchhoff/sdk";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { ccipAbi } from "@kirchhoff/sdk";

const TEST_DB = process.env.INDEXER_UNIT_DATABASE_URL ?? "postgres://kirchhoff:kirchhoff@127.0.0.1:5434/kirchhoff_idx_unit_test";
let db: Db;

beforeAll(async () => {
  db = createDb(TEST_DB, { max: 3 });
  await resetSchema(db);
  await migrate(db);
});
afterAll(async () => {
  await db.end();
});

const base = {
  cellId: "cell-1",
  messageId: keccak256(toHex("m")),
  decision: "FAIL",
  reason: "TOKEN_BROKEN",
  note: "attacker transfer",
  latencyMs: 12,
  srcChain: "3478487238524512106",
  dstChain: "ethereum-testnet-sepolia-base-1",
  amount: "10",
  sender: `0x000000000000000000000000${"ab".repeat(20)}`,
  receiver: `0x${"cd".repeat(20)}`,
};

describe("Judge verdict sink", () => {
  it("validates untrusted reports and normalizes selectors and padded addresses", () => {
    const r = parseVerdictReport(base);
    expect(r).toMatchObject({ srcChain: "ethereum-testnet-sepolia-arbitrum-1", sender: `0x${"ab".repeat(20)}`, token: null });
    for (const bad of [{ ...base, decision: "MAYBE" }, { ...base, reason: "NOPE" }, { ...base, amount: "1e18" }, { ...base, srcChain: "1" }, { ...base, cellId: "x y" }, { ...base, latencyMs: -1 }, null]) {
      expect(() => parseVerdictReport(bad)).toThrow(VerdictValidationError);
    }
  });

  it("builds the committee row: PENDING is stored raw but never shown; any FAIL makes the row FAIL", async () => {
    await db.query("insert into tokens (symbol, token_id, name, decimals, model, home_chain, chains, spec_yaml, config) values ('kETH','0x01','k',18,'lock_release_home','ethereum-testnet-sepolia','{}','', '{}')");
    await ingestVerdict(db, parseVerdictReport({ ...base, decision: "PENDING", reason: "PENDING_ATTESTATION" }), "kETH");
    expect((await db.query("select * from verdicts")).rowCount).toBe(0);
    await ingestVerdict(db, parseVerdictReport({ ...base, cellId: "cell-2", decision: "PASS", reason: "OK" }), "kETH");
    await ingestVerdict(db, parseVerdictReport(base), "kETH");
    const v = await db.query<{ decision: string; cells: { cellId: string }[] }>("select decision, cells from verdicts");
    expect(v.rows[0]?.decision).toBe("FAIL");
    expect(v.rows[0]?.cells.map((c) => c.cellId).sort()).toEqual(["cell-1", "cell-2"]);
    const raw = await db.query("select * from judge_verdicts");
    expect(raw.rowCount).toBe(3);
  });
});

describe("Notifier", () => {
  it("pages once per incident per channel, retries failures, and skips when unconfigured", async () => {
    const sent: string[] = [];
    let fail = true;
    const channels = [
      { name: "slack" as const, send: (t: string) => { sent.push(t); return Promise.resolve(); } },
      { name: "telegram" as const, send: () => (fail ? Promise.reject(new Error("telegram HTTP 500")) : Promise.resolve()) },
    ];
    const n = new Notifier(db, channels);
    const notice = { incidentId: "0xinc", token: "kETH", reason: "DEBIT_NOT_FOUND", amount: "116500000000000000000000", decimals: 18, chain: "ethereum-testnet-sepolia", recipient: "0xabc", link: "https://k/incidents/0xinc" };
    expect(await n.notify(notice)).toEqual(["slack"]);
    expect(await n.notify(notice)).toEqual([]);
    fail = false;
    expect(await n.notify(notice)).toEqual(["telegram"]);
    expect(await n.notify(notice)).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("116,500 kETH on Ethereum Sepolia");
    expect(incidentText(notice)).not.toMatch(/[—–]/);
    expect(new Notifier(db, channelsFromEnv({})).configured).toBe(false);
    expect(await new Notifier(db, []).notifyIncident("0xinc", null)).toEqual([]);
  });
});

describe("CCIP 2.0 log pairing", () => {
  it("pairs LockedOrBurned with the OnRamp CCIPMessageSent of the same tx and ignores an unpaired ramp log", () => {
    const pool = `0x${"11".repeat(20)}` as const;
    const onRamp = `0x${"22".repeat(20)}` as const;
    const dep = { role: "remote", ledger: `0x${"99".repeat(20)}`, quarantine: `0x${"98".repeat(20)}`, registry: null, escrow: null, weakBridge: null, ccipPool: pool, onRamp, offRamp: null } as unknown as ChainDeploymentInfo;
    const tx = keccak256(toHex("tx"));
    const msgId = keccak256(toHex("msg"));
    const locked: RawLog = {
      address: pool,
      topics: encodeEventTopics({ abi: ccipAbi, eventName: "LockedOrBurned", args: { remoteChainSelector: 16015286601757825753n } }) as RawLog["topics"],
      data: encodeAbiParameters(parseAbi(["function f(address,address,uint256)"])[0].inputs, [pool, onRamp, 7n]),
      blockNumber: 5n,
      transactionHash: tx,
      logIndex: 0,
    };
    const sentTopics = encodeEventTopics({ abi: ccipAbi, eventName: "CCIPMessageSent", args: { destChainSelector: 16015286601757825753n, sender: onRamp, messageId: msgId } });
    const sentData = encodeAbiParameters(
      parseAbi(["function f(address feeToken, uint256 amt, bytes encodedMessage, (address issuer, uint32 destGasLimit, uint32 destBytesOverhead, uint256 feeTokenAmount, bytes extraArgs)[] receipts, bytes[] verifierBlobs)"])[0].inputs,
      [pool, 7n, "0x", [], []],
    );
    const sent: RawLog = { address: onRamp, topics: sentTopics as RawLog["topics"], data: sentData, blockNumber: 5n, transactionHash: tx, logIndex: 1 };
    const events = decodeLogs([locked, sent], dep);
    expect(events).toEqual([expect.objectContaining({ kind: "Debit", bridge: "ccip", messageId: msgId, amount: 7n, dstSelector: 16015286601757825753n })]);
    const orphan = decodeLogs([sent], dep);
    expect(orphan.filter((e) => e.kind === "Debit")).toHaveLength(0);
  });
});
