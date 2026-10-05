import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, resetSchema, type Db } from "@kirchhoff/indexer";
import type { LabRun } from "@kirchhoff/sdk";
import { LabRunner } from "../src/lab.ts";
import { Ops } from "../src/ops.ts";
import { histogramQuantile, judgeScrape, parsePrometheus } from "../src/prometheus.ts";

const TEST_DB = process.env.API_UNIT_TEST_DATABASE_URL ?? "postgres://kirchhoff:kirchhoff@127.0.0.1:5434/kirchhoff_mcp_test";
let db: Db;

beforeAll(async () => {
  db = createDb(TEST_DB, { max: 3 });
  await resetSchema(db);
  await migrate(db);
});
afterAll(async () => {
  await db.end();
});

describe("Attack Lab runner", () => {
  it("maps demo StepEvent JSON lines onto the 7 PRD steps, console lines, attacker and incident", async () => {
    const lab = new LabRunner(
      { enabled: true, disabledReason: "", command: process.execPath, args: [join(import.meta.dirname, "fixtures", "fake-attack.mjs")], cwd: ".", timeoutMs: 20_000, token: "kETH", attacker: `0x${"0".repeat(40)}` },
      db,
    );
    const run = lab.start();
    expect(() => lab.start()).toThrow(/already running/);
    for (let i = 0; i < 100 && (lab.get(run.id)?.state ?? "running") === "running"; i++) await new Promise((r) => setTimeout(r, 50));
    const done: LabRun | null = lab.get(run.id);
    if (!done) throw new Error("run disappeared");
    expect(done.state).toBe("succeeded");
    expect(done.steps.map((s) => [s.key, s.state])).toEqual([
      ["forge_release", "done"],
      ["junction_search", "done"],
      ["breach_written", "done"],
      ["quarantine_applied", "done"],
      ["ccip_refused", "done"],
      ["guard_and_lending", "done"],
      ["loop_confirmed", "done"],
    ]);
    expect(done.steps.find((s) => s.key === "breach_written")?.txs.map((t) => t.chain)).toEqual(["ethereum-testnet-sepolia", "ethereum-testnet-sepolia-arbitrum-1", "ethereum-testnet-sepolia-base-1"]);
    expect(done.steps.find((s) => s.key === "guard_and_lending")?.txs).toHaveLength(2);
    expect(done.attacker).toBe(`0x${"a".repeat(40)}`);
    expect(done.incidentId).toBe(`0x${"3".repeat(64)}`);
    expect(done.console.some((l) => l.stream === "revert" && l.text.includes("CollateralBroken"))).toBe(true);
    expect(done.console.some((l) => l.stream === "stderr" && l.text.includes("fixture"))).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const stored = await db.query<{ state: string }>("select state from lab_runs where id = $1", [run.id]);
    expect(stored.rows[0]?.state).toBe("succeeded");
  });
});

const METRICS = `# HELP judge_evaluate_duration_seconds x
# TYPE judge_evaluate_duration_seconds histogram
judge_evaluate_duration_seconds_bucket{le="0.01",outcome="PASS"} 50
judge_evaluate_duration_seconds_bucket{le="0.05",outcome="PASS"} 90
judge_evaluate_duration_seconds_bucket{le="0.3",outcome="PASS"} 100
judge_evaluate_duration_seconds_bucket{le="+Inf",outcome="PASS"} 100
judge_evaluate_duration_seconds_count{outcome="PASS"} 100
judge_evaluate_duration_seconds_bucket{le="0.01",outcome="UNAUTHORIZED"} 7
judge_evaluate_duration_seconds_bucket{le="+Inf",outcome="UNAUTHORIZED"} 7
judge_decisions_total{decision="PASS",reason="OK"} 90
judge_decisions_total{decision="FAIL",reason="TOKEN_BROKEN"} 10
`;

describe("Ops from the Judge's Prometheus /metrics", () => {
  it("parses histograms and computes quantiles like histogram_quantile", () => {
    const sc = judgeScrape(parsePrometheus(METRICS));
    expect(sc.samples).toBe(100);
    expect(histogramQuantile(0.5, sc.buckets)).toBeCloseTo(0.01, 5);
    expect(histogramQuantile(0.99, sc.buckets)).toBeCloseTo(0.05 + 0.25 * 0.9, 5);
    expect(sc.byReason).toEqual({ OK: 90, TOKEN_BROKEN: 10 });
  });

  it("uses scraped metrics for p50/p99 and decision counts, marks unreachable cells unhealthy", async () => {
    const fakeFetch = ((url: string | URL) =>
      String(url).includes("cell-1") ? Promise.resolve(new Response(METRICS, { status: 200 })) : Promise.reject(new Error("down"))) as typeof fetch;
    const ops = new Ops(db, {
      rpc: { "ethereum-testnet-sepolia": [], "ethereum-testnet-sepolia-arbitrum-1": [], "ethereum-testnet-sepolia-base-1": [] },
      chains: [],
      cells: [],
      enforcement: "ccv_cell",
      metrics: [{ cellId: "cell-1", url: "http://cell-1/metrics" }, { cellId: "cell-2", url: "http://cell-2/metrics" }],
      fetch: fakeFetch,
    });
    const s = await ops.snapshot();
    expect(s.judge).toEqual({ p50Ms: 10, p99Ms: 275, samples: 100 });
    expect(s.verdictCounts).toMatchObject({ pass: 90, fail: 10 });
    expect(s.cells.map((c) => [c.id, c.healthy])).toEqual([["cell-1", true], ["cell-2", false]]);
    expect(s.enforcement).toBe("ccv_cell");
  });
});
