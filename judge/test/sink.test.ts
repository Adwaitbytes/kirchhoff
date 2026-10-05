import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseVerdictReport } from "@kirchhoff/indexer/verdicts";
import { createLogger } from "../src/log.ts";
import { createMetrics } from "../src/metrics.ts";
import { VerdictSink, toReport, type VerdictReport } from "../src/sink.ts";
import { ARB, HOME, SOURCE_TX, kethRequest, post, startHarness, type Harness } from "./helpers/harness.ts";

type FakeApi = { url: string; batches: VerdictReport[][]; keys: string[]; mode: "ok" | "down" | "reject" | "hang"; close: () => Promise<void> };

async function fakeApi(): Promise<FakeApi> {
  const api: Omit<FakeApi, "url" | "close"> = { batches: [], keys: [], mode: "ok" };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (api.mode === "hang") return;
      if (api.mode === "down") {
        res.writeHead(503).end();
        return;
      }
      if (api.mode === "reject") {
        res.writeHead(400).end('{"error":"BAD_REQUEST"}');
        return;
      }
      api.keys.push(String(req.headers["x-kirchhoff-internal-key"]));
      const batch = JSON.parse(Buffer.concat(chunks).toString("utf8")) as VerdictReport[];
      for (const r of batch) parseVerdictReport(r); // the API's own validator
      api.batches.push(batch);
      res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ stored: batch.length }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(api, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    },
  });
}

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const SELECTORS = new Set([HOME, ARB].map(String));
const report = (i: number): VerdictReport => ({
  cellId: "kirchhoff-cell-1",
  messageId: `0x${i.toString(16).padStart(64, "0")}`,
  decision: "PASS",
  reason: "OK",
  note: "CONSERVED delta=0 epoch=1",
  latencyMs: 3,
  evaluatedAt: new Date(0).toISOString(),
  srcChain: ARB.toString(),
  dstChain: HOME.toString(),
  amount: "1",
  sender: `0x${"11".repeat(20)}`,
  receiver: `0x${"22".repeat(20)}`,
  token: "kETH",
  sourceTxHash: SOURCE_TX,
});

let api: FakeApi | undefined;
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  await api?.close();
  h = undefined;
  api = undefined;
});

describe("toReport", () => {
  const base = { cellId: "kirchhoff-cell-1", latencyMs: 3.4, evaluatedAt: new Date(0) };

  it("builds a report the API's validator accepts, always with sourceTxHash", async () => {
    h = await startHarness();
    const r = toReport({ ...base, request: kethRequest(h.token), decision: "FAIL", reasonString: "TOKEN_BROKEN kETH DEBIT_NOT_FOUND incident=0x9f3c...", symbol: "kETH" }, SELECTORS);
    expect(r).toMatchObject({ decision: "FAIL", reason: "TOKEN_BROKEN", note: "DEBIT_NOT_FOUND incident=0x9f3c...", token: "kETH", sourceTxHash: SOURCE_TX, latencyMs: 3 });
    expect(parseVerdictReport(r)).toMatchObject({ srcChain: "ethereum-testnet-sepolia-arbitrum-1", dstChain: "ethereum-testnet-sepolia", sourceTxHash: SOURCE_TX });
  });

  it("skips what the read model cannot hold", async () => {
    h = await startHarness();
    const req = kethRequest(h.token);
    req.message.source_chain_selector = "16423721717087811551";
    expect(toReport({ ...base, request: req, decision: "PASS", reasonString: "OK no protected token", symbol: null }, SELECTORS)).toBeNull();
  });
});

describe("VerdictSink", () => {
  const make = (url: string, maxQueue = 10) => {
    const metrics = createMetrics();
    const sink = new VerdictSink({ url, key: "test-internal-key-123", metrics: metrics.sink, logger: createLogger("error"), maxQueue, flushMs: 20, timeoutMs: 200 });
    return { sink, metrics };
  };

  it("batches up to 100 per request with the internal key", async () => {
    api = await fakeApi();
    const { sink, metrics } = make(api.url, 1000);
    for (let i = 0; i < 150; i += 1) sink.offer(report(i));
    sink.start();
    await until(() => api?.batches.flat().length === 150);
    sink.stop();
    expect(api.batches.map((b) => b.length)).toEqual([100, 50]);
    expect(api.keys.every((k) => k === "test-internal-key-123")).toBe(true);
    expect(await metrics.registry.getSingleMetricAsString("judge_verdict_sink_sent_total")).toMatch(/ 150$/m);
  });

  it("keeps reports while the API is down, drops the oldest past the bound, then delivers the rest", async () => {
    api = await fakeApi();
    api.mode = "down";
    const { sink, metrics } = make(api.url, 10);
    sink.start();
    for (let i = 0; i < 15; i += 1) sink.offer(report(i));
    await new Promise((r) => setTimeout(r, 100));
    expect(sink.size).toBe(10);
    expect(await metrics.registry.getSingleMetricAsString("judge_verdict_sink_dropped_total")).toMatch(/reason="overflow"} 5/);
    api.mode = "ok";
    await until(() => api?.batches.flat().length === 10, 5000);
    sink.stop();
    expect(api.batches.flat().map((r) => Number.parseInt(r.messageId, 16))).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("drops a batch the API rejects instead of retrying it forever", async () => {
    api = await fakeApi();
    api.mode = "reject";
    const { sink, metrics } = make(api.url);
    sink.offer(report(1));
    sink.start();
    await until(() => sink.size === 0);
    await new Promise((r) => setTimeout(r, 50));
    sink.stop();
    expect(await metrics.registry.getSingleMetricAsString("judge_verdict_sink_dropped_total")).toMatch(/reason="rejected"} 1/);
  });
});

describe("Judge with the sink", () => {
  it("reports PASS, FAIL and PENDING with sourceTxHash after answering", async () => {
    api = await fakeApi();
    h = await startHarness({ sinkUrl: api.url });
    expect((await post(h.url, kethRequest(h.token))).status).toBe(200);
    expect((await post(h.url, kethRequest(h.token, { amount: 1n }))).status).toBe(200);
    h.both(ARB, (s) => {
      s.state.logs = [];
    });
    expect((await post(h.url, kethRequest(h.token))).status).toBe(503);
    await until(() => api?.batches.flat().length === 3);
    expect(api.batches.flat().map((r) => [r.decision, r.reason, r.sourceTxHash])).toEqual([
      ["PASS", "OK", SOURCE_TX],
      ["FAIL", "AMOUNT_MISMATCH", SOURCE_TX],
      ["PENDING", "PENDING_ATTESTATION", SOURCE_TX],
    ]);
  });

  it("never delays the verdict when the API hangs", async () => {
    api = await fakeApi();
    api.mode = "hang";
    h = await startHarness({ sinkUrl: api.url });
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await post(h.url, kethRequest(h.token));
      expect(res.body.decision).toBe("PASS");
      times.push(res.ms);
    }
    expect(Math.max(...times)).toBeLessThan(200);
  });
});
