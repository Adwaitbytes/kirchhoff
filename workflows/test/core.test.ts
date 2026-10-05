import { decodeReport, ReportType, Status, type Hex } from "@kirchhoff/engine";
import { describe, expect, it } from "vitest";
import { encodeFunctionResult, parseAbi } from "viem";
import { CRE_CHAIN_READ_LIMIT, logWindow, ReadBudget, ReadBudgetExceeded } from "../src/budget.ts";
import { w1ConfigSchema, w2ConfigSchema, w3ConfigSchema, w4ConfigSchema } from "../src/config.ts";
import { withBudget } from "../src/io.ts";
import { CRE_READ_PAYLOAD_LIMIT_BYTES, decodeAggregate3, encodeAggregate3, MULTICALL3_ABI, successful } from "../src/multicall.ts";
import { envelopeFor, junctionEvidence, ReportWriteError, writeToLedgers } from "../src/reports.ts";
import { parseSimulateOutput, simulateCommand } from "../scripts/lib/cre.ts";
import { fromDeployRecords } from "../scripts/lib/deployments.ts";
import { ADDR, compiledConfigs, deployRecords, FakeChain, HOME, SEL } from "./helpers.ts";

describe("ReadBudget", () => {
  it("allows exactly the CRE limit of 15 reads and names the read that would exceed it", () => {
    const budget = new ReadBudget();
    for (let i = 0; i < CRE_CHAIN_READ_LIMIT; i++) budget.spend("callContract", "c", `r${i}`);
    expect(budget.remaining).toBe(0);
    expect(() => {
      budget.spend("filterLogs", "c", "extra");
    }).toThrow(/filterLogs extra on c/);
  });

  it("rejects limits outside 1..15", () => {
    expect(() => new ReadBudget(0)).toThrow(RangeError);
    expect(() => new ReadBudget(16)).toThrow(RangeError);
  });

  it("charges every read made through withBudget, but not writes", () => {
    const fake = new FakeChain();
    fake.setHead(HOME, 10n, 20n);
    const budget = new ReadBudget(2);
    const io = withBudget(fake, budget);
    io.header(HOME, { tag: "latest" });
    io.writeReport(HOME, ADDR.home.ledger, "0x", 1n);
    expect(budget.used).toBe(1);
    io.header(HOME, { tag: "finalized" });
    expect(() => io.header(HOME, { tag: "finalized" })).toThrow(ReadBudgetExceeded);
  });
});

describe("logWindow", () => {
  it("spans the latest 100 blocks inclusive and clamps at genesis", () => {
    expect(logWindow(1000n)).toEqual({ fromBlock: 901n, toBlock: 1000n });
    expect(logWindow(5n)).toEqual({ fromBlock: 1n, toBlock: 5n });
    expect(() => logWindow(0n)).toThrow(RangeError);
    expect(() => logWindow(10n, 101n)).toThrow(RangeError);
  });
});

describe("multicall", () => {
  it("round-trips aggregate3 and surfaces a reverted sub-call by label", () => {
    const encoded = encodeFunctionResult({
      abi: MULTICALL3_ABI,
      functionName: "aggregate3",
      result: [
        { success: true, returnData: "0x01" },
        { success: false, returnData: "0x" },
      ],
    });
    const results = decodeAggregate3(encoded, 2);
    expect(successful(results[0], "a")).toBe("0x01");
    expect(() => successful(results[1], "statusOf")).toThrow(/statusOf reverted/);
    expect(() => decodeAggregate3(encoded, 3)).toThrow(/2 results for 3 calls/);
  });

  it("refuses calldata above the CRE 5 KB read payload limit", () => {
    const big: Hex = `0x${"ab".repeat(CRE_READ_PAYLOAD_LIMIT_BYTES)}`;
    expect(() => encodeAggregate3([{ target: ADDR.home.ledger, callData: big }])).toThrow(/payload limit/);
  });
});

describe("reports", () => {
  const target = { chain: HOME, selector: SEL[HOME], ledger: ADDR.home.ledger };
  const tokenId: Hex = `0x${"11".repeat(32)}`;

  it("binds every report to one chain selector and one ledger (INTERFACES.md envelope)", () => {
    const encoded = envelopeFor(target, tokenId, {
      reportType: ReportType.QUARANTINE_APPLIED,
      payload: { incidentId: `0x${"22".repeat(32)}`, tainted: [ADDR.arb.token] },
    });
    const decoded = decodeReport(encoded);
    expect(decoded.reportType).toBe(ReportType.QUARANTINE_APPLIED);
    expect(decoded.chainSelector).toBe(SEL[HOME]);
    expect(decoded.ledger.toLowerCase()).toBe(ADDR.home.ledger);
    expect(decoded.tokenId).toBe(tokenId);
  });

  it("derives one evidence hash per offending credit, so redelivery is the same incident", () => {
    const txHash: Hex = `0x${"33".repeat(32)}`;
    const messageId: Hex = `0x${"44".repeat(32)}`;
    const e = { dstChain: SEL[HOME], txHash, messageId, reason: 2 };
    expect(junctionEvidence(e)).toBe(junctionEvidence({ ...e }));
    expect(junctionEvidence(e)).not.toBe(junctionEvidence({ ...e, reason: 5 }));
  });

  it("attempts every ledger before failing loudly on any write failure", () => {
    const fake = new FakeChain();
    fake.failWritesOn.add("arb");
    const targets = ["home", "arb", "base"].map((chain) => ({ ...target, chain }));
    const body = { reportType: ReportType.RECOVERY_CHECK, payload: { epochId: 1n, delta: 0n, blocksHash: tokenId } } as const;
    expect(() => writeToLedgers(fake, targets, tokenId, body)).toThrow(ReportWriteError);
    expect(fake.writes.map((w) => w.chain)).toEqual(["home", "arb", "base"]);
  });
});

describe("generated configs", () => {
  it("parse with the workflow schemas exactly as the engine compiler emits them", async () => {
    const c = await compiledConfigs();
    expect(w1ConfigSchema.parse(c.w1)).toEqual(c.w1);
    expect(w2ConfigSchema.parse(c.w2)).toEqual(c.w2);
    expect(w3ConfigSchema.parse(c.w3)).toEqual(c.w3);
    expect(w4ConfigSchema.parse(c.w4)).toEqual(c.w4);
  });

  it("reject a config with a malformed address", async () => {
    const c = await compiledConfigs();
    expect(() => w3ConfigSchema.parse({ ...c.w3, breachTrigger: { ...c.w3.breachTrigger, address: "0x1234" } })).toThrow();
  });

  it("assemble Deploy.s.sol records into the engine Deployments shape (escrow + lockbox, home escrow emits)", () => {
    const d = fromDeployRecords("test", deployRecords());
    const home = d.chains[HOME];
    expect(home?.tokens.kETH?.escrow).toBe(ADDR.home.escrow);
    expect(home?.tokens.kETH?.lockbox).toBe(ADDR.home.lockbox);
    expect(home?.tokens.kETH?.bridges?.weakbridge).toBe(ADDR.home.escrow);
    expect(home?.registry).toBe(ADDR.home.registry);
    const [home0] = deployRecords();
    if (home0 === undefined) throw new Error("fixture missing");
    expect(() => fromDeployRecords("x", [{ ...home0, chainSelector: "1" }])).toThrow(/not a KIRCHHOFF chain/);
  });
});

describe("cre simulate harness", () => {
  it("builds the exact non-interactive simulate command from cre.md", () => {
    expect(
      simulateCommand({ workflow: "w1-junction", target: "local", triggerIndex: 1, evm: { txHash: "0xab", eventIndex: 0 }, broadcast: true }).join(" "),
    ).toBe("workflow simulate ./w1-junction --target local --non-interactive --trigger-index 1 --evm-tx-hash 0xab --evm-event-index 0 --broadcast -e ../.env");
  });

  it("extracts user logs, the result and failures from simulator output", () => {
    const ok = parseSimulateOutput('2026 [USER LOG] hello\n✓ Workflow Simulation Result:\n"epoch 1 status=1"\n');
    expect(ok).toEqual({ userLogs: ["hello"], result: "epoch 1 status=1", error: null });
    expect(parseSimulateOutput("✗ workflow execution failed: boom").error).toMatch(/boom/);
  });
});

describe("abi fixtures", () => {
  it("statusOf decodes the Solidity Status enum as a uint8", () => {
    const abi = parseAbi(["function statusOf(bytes32) view returns (uint8, int256, uint64, bool)"]);
    expect(encodeFunctionResult({ abi, functionName: "statusOf", result: [Status.BROKEN, -1n, 1n, false] })).toMatch(/^0x0{63}3/);
  });
});
