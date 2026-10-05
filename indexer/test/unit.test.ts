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
  const notice = {
    incidentId: "0xinc",
    token: "kETH",
    reason: "DEBIT_NOT_FOUND",
    deficit: "-116500000000000000000000",
    decimals: 18,
    offendingLabel: "WeakBridge credit on Ethereum Sepolia",
    offendingTxUrl: "https://sepolia.etherscan.io/tx/0xabc",
    contained: ["CCIP lanes frozen on Ethereum Sepolia, Base Sepolia", "0xatt tainted on Ethereum Sepolia"],
    link: "https://kirchhoff.test/incidents/0xinc",
    summary: "WeakBridge credited 116,500 kETH with no matching debit.",
    summaryLabel: "AI summary. Verify against evidence.",
    simulation: true,
  };

  it("every page carries deficit, offending tx link, containment, Incident Room link and narrative", () => {
    const t = incidentText(notice);
    for (const part of ["Deficit: -116,500 kETH", notice.offendingTxUrl, "Already contained: CCIP lanes frozen", notice.link, "AI summary. Verify against evidence.", notice.summary, "Testnet simulation."]) {
      expect(t).toContain(part);
    }
    expect(t).not.toMatch(/[\u2014\u2013]/);
  });

  it("posts to mocked Telegram, Slack and PagerDuty Events v2 endpoints, once per incident per channel", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let pdStatus = 500;
    const fetchMock = ((url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body as string) as Record<string, unknown> });
      const status = String(url).includes("pagerduty") ? pdStatus : 200;
      return Promise.resolve(new Response("{}", { status }));
    }) as typeof fetch;
    const channels = channelsFromEnv({ TELEGRAM_BOT_TOKEN: "tg-secret", TELEGRAM_CHAT_ID: "42", SLACK_WEBHOOK_URL: "https://hooks.slack.test/T/B/secret", PAGERDUTY_ROUTING_KEY: "pd-routing-key" }, fetchMock);
    expect(channels.map((c) => c.name)).toEqual(["telegram", "slack", "pagerduty"]);
    const n = new Notifier(db, channels);
    expect(await n.pending()).toEqual([]);
    expect(await n.notify(notice)).toEqual(["telegram", "slack"]);
    const pd = calls.find((c) => c.url === "https://events.pagerduty.com/v2/enqueue");
    expect(pd?.body).toMatchObject({ routing_key: "pd-routing-key", event_action: "trigger", dedup_key: "0xinc", payload: { severity: "critical", source: "kirchhoff" } });
    const details = (pd?.body.payload as { custom_details: Record<string, unknown> }).custom_details;
    expect(details).toMatchObject({ deficit: "-116,500 kETH", offending_tx: notice.offendingTxUrl, already_contained: notice.contained, narrative: notice.summary });
    expect(calls.find((c) => c.url.includes("telegram"))?.body).toMatchObject({ chat_id: "42" });
    expect(String(calls.find((c) => c.url.includes("slack"))?.body.text)).toContain("Incident Room: https://kirchhoff.test/incidents/0xinc");
    expect(await n.notify(notice)).toEqual([]);
    pdStatus = 202;
    expect(await n.notify(notice)).toEqual(["pagerduty"]);
    expect(await n.notify(notice)).toEqual([]);
    const failed = await db.query<{ last_error: string | null }>("select last_error from notifications where channel = 'pagerduty'");
    expect(failed.rows[0]?.last_error).toBeNull();
  });

  it("skips unconfigured channels and keeps secrets out of stored errors", async () => {
    expect(channelsFromEnv({})).toEqual([]);
    expect(new Notifier(db, []).configured).toBe(false);
    const bad = channelsFromEnv({ SLACK_WEBHOOK_URL: "https://hooks.slack.test/T/B/very-secret" }, (() => Promise.resolve(new Response("", { status: 403 }))));
    await new Notifier(db, bad).notify({ ...notice, incidentId: "0xother" });
    const row = await db.query<{ last_error: string }>("select last_error from notifications where incident_id = '0xother'");
    expect(row.rows[0]?.last_error).toBe("slack HTTP 403");
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
