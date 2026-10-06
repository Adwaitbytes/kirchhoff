import { decodeReport, eventTopic, incidentId, Reason, ReportType, reviveSpec, Status, type Hex } from "@kirchhoff/engine";
import { BRIDGE_REGISTRY_ABI } from "@kirchhoff/engine/adapters";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  pad,
  parseAbi,
  parseEther,
  toFunctionSelector,
} from "viem";
import { ACCESS_CONTROL_ABI, ERC20_ABI, LEDGER_ABI } from "../src/abi.ts";
import { ReadBudget } from "../src/budget.ts";
import type { ChainLog } from "../src/io.ts";
import { withBudget } from "../src/io.ts";
import { creditTriggerGroups, runJunction } from "../src/w1.ts";
import { runLoop, supplyTriggerFilters } from "../src/w2.ts";
import { buildNotifications } from "../src/notify.ts";
import { decodeBreach, incidentText, runResponder } from "../src/w3.ts";
import { driftKey, runTopology } from "../src/w4.ts";
import { ADDR, ARB, BASE, compiledConfigs, FakeChain, HOME, SEL, type Configs } from "./helpers.ts";

const BRIDGE_EVENTS = parseAbi([
  "event Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)",
  "event Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain)",
  "event BreachRecorded(bytes32 indexed tokenId, uint16 reason, bytes32 evidenceHash, uint64 offendingChain, bytes32 offendingTx, address recipient, uint256 amount)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
]);
const MULTICALL3: Hex = "0xcA11bde05977b3631167028862bE2a173976CA11";
const USER: Hex = "0x00000000000000000000000000000000000000aa";
const ATTACKER: Hex = "0x00000000000000000000000000000000000000bb";
const ID: Hex = `0x${"5a".repeat(32)}`;
const TX = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const ONE = parseEther("1");

function released(address: Hex, id: Hex, to: Hex, amount: bigint, src: bigint, block: bigint): ChainLog {
  return {
    address,
    topics: encodeEventTopics({ abi: BRIDGE_EVENTS, eventName: "Released", args: { id, to } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [amount, src]),
    transactionHash: TX(Number(block)),
    blockNumber: block,
    logIndex: 0,
  };
}

function burned(address: Hex, id: Hex, from: Hex, to: Hex, amount: bigint, dst: bigint, block: bigint): ChainLog {
  return {
    address,
    topics: encodeEventTopics({ abi: BRIDGE_EVENTS, eventName: "Burned", args: { id, from } }) as Hex[],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint64" }], [to, amount, dst]),
    transactionHash: TX(10_000 + Number(block)),
    blockNumber: block,
    logIndex: 0,
  };
}

const debitOfReply = (amount: bigint, recipient: Hex, dst: bigint, block: bigint): Hex =>
  encodeFunctionResult({ abi: BRIDGE_REGISTRY_ABI, functionName: "debitOf", result: [amount, recipient, dst, block] });

const selectorOf = (data: Hex): Hex => data.slice(0, 10) as Hex;
const DEBIT_OF = "0xb4b71ba5";

let c: Configs;
beforeAll(async () => {
  c = await compiledConfigs();
});

type LedgerState = { status: number; epochId: bigint; recoveryEndsAt: bigint; active: Hex; consumed: Set<string> };
const ledgerState = (status: number = Status.CONSERVED): LedgerState => ({ status, epochId: 7n, recoveryEndsAt: 0n, active: `0x${"0".repeat(64)}`, consumed: new Set() });

/** Answers the ledger views the workflows read, for one chain. */
function serveLedger(fake: FakeChain, chain: string, ledger: Hex, state: LedgerState): void {
  fake.on(chain, (to, data) => {
    if (to.toLowerCase() !== ledger.toLowerCase()) return undefined;
    const call = decodeFunctionData({ abi: LEDGER_ABI, data });
    switch (call.functionName) {
      case "statusOf":
        return encodeFunctionResult({ abi: LEDGER_ABI, functionName: "statusOf", result: [state.status, 0n, 1n, false] });
      case "latestEpoch":
        return encodeFunctionResult({
          abi: LEDGER_ABI,
          functionName: "latestEpoch",
          result: { epochId: state.epochId, delta: 0n, evaluatedAt: 1n, blocksHash: TX(0), evidenceHash: TX(0), status: state.status, reason: 0 },
        });
      case "recoveryEndsAt":
        return encodeFunctionResult({ abi: LEDGER_ABI, functionName: "recoveryEndsAt", result: state.recoveryEndsAt });
      case "activeIncident":
        return encodeFunctionResult({ abi: LEDGER_ABI, functionName: "activeIncident", result: state.active });
      case "isConsumed":
        return encodeFunctionResult({ abi: LEDGER_ABI, functionName: "isConsumed", result: state.consumed.has(call.args[0].toLowerCase()) });
    }
  });
}

function decodedWrites(fake: FakeChain) {
  return fake.writes.map((w) => ({ chain: w.chain, receiver: w.receiver, report: decodeReport(w.payload) }));
}

// ------------------------------------------------------------------ W1

describe("W1 Junction Watch", () => {
  function setup(opts: { debitAmount: bigint; consumed?: boolean; homeFinal?: bigint }) {
    const fake = new FakeChain();
    fake.setHead(HOME, opts.homeFinal ?? 500n, 600n);
    fake.setHead(ARB, 500n, 600n);
    fake.setHead(BASE, 500n, 600n);
    fake.on(HOME, (to, data) =>
      to.toLowerCase() === ADDR.home.escrow && selectorOf(data) === DEBIT_OF
        ? debitOfReply(opts.debitAmount, opts.debitAmount === 0n ? `0x${"0".repeat(40)}` : USER, opts.debitAmount === 0n ? 0n : SEL[ARB], 90n)
        : undefined,
    );
    serveLedger(fake, ARB, ADDR.arb.ledger, { ...ledgerState(), consumed: new Set(opts.consumed === true ? [ID] : []) });
    return fake;
  }
  const credit = (amount: bigint, to: Hex = USER): ChainLog => released(ADDR.arb.bridge, ID, to, amount, SEL[HOME], 100n);

  it("wires one log trigger per chain over its credit emitters, in config chain order", () => {
    const groups = creditTriggerGroups(c.w1);
    expect(groups.map((g) => g.chain)).toEqual([HOME, ARB, BASE]);
    expect(groups[1]?.addresses.map((x) => x.toLowerCase())).toContain(ADDR.arb.bridge);
    expect(groups[1]?.topic0s).toContain(eventTopicOf("Released"));
  });

  it("settles an honest credit without writing anything", () => {
    const fake = setup({ debitAmount: 10n * ONE });
    const budget = new ReadBudget();
    const out = runJunction(withBudget(fake, budget), c.w1, reviveSpec(c.w1.spec), ARB, credit(10n * ONE), 2_000n);
    expect(out.kind === "evaluated" && out.verdict.status).toBe(Status.CONSERVED);
    expect(fake.writes).toHaveLength(0);
    // credit header, source pin header, debitOf, evidence filterLogs, isConsumed
    expect(budget.used).toBe(5);
  });

  it("breaks on a forged credit (no debit, source final) and writes BREACH to every chain in the same run", () => {
    const fake = setup({ debitAmount: 0n });
    const budget = new ReadBudget();
    const out = runJunction(withBudget(fake, budget), c.w1, reviveSpec(c.w1.spec), ARB, credit(7n * ONE, ATTACKER), 2_000n);
    expect(out.kind === "evaluated" && out.verdict.reason).toBe(Reason.DEBIT_NOT_FOUND);
    const writes = decodedWrites(fake);
    expect(writes.map((w) => w.chain)).toEqual([HOME, ARB, BASE]);
    for (const w of writes) {
      expect(w.report.reportType).toBe(ReportType.BREACH);
      if (w.report.reportType !== ReportType.BREACH) continue;
      expect(w.report.payload.reason).toBe(Reason.DEBIT_NOT_FOUND);
      expect(w.report.payload.recipient.toLowerCase()).toBe(ATTACKER);
      expect(w.report.payload.amount).toBe(7n * ONE);
      expect(w.report.ledger.toLowerCase()).toBe(w.receiver.toLowerCase());
    }
    // Same evidence on every chain: one incident everywhere.
    expect(new Set(writes.map((w) => (w.report.reportType === ReportType.BREACH ? w.report.payload.evidenceHash : "")))).toHaveProperty("size", 1);
    // the debit was searched on both home bridges (weakbridge registry, then the CCIP OnRamp)
    expect(budget.used).toBeLessThanOrEqual(15);
  });

  it("keeps a credit whose source is not yet final in DRIFT instead of breaking", () => {
    const fake = setup({ debitAmount: 0n, homeFinal: 50n });
    const out = runJunction(fake, c.w1, reviveSpec(c.w1.spec), ARB, credit(7n * ONE), 1_100n);
    expect(out.kind === "evaluated" && out.verdict.status).toBe(Status.DRIFT);
    expect(fake.writes).toHaveLength(0);
  });

  it("flags DOUBLE_CREDIT when the matching debit is already consumed", () => {
    const fake = setup({ debitAmount: 10n * ONE, consumed: true });
    const out = runJunction(fake, c.w1, reviveSpec(c.w1.spec), ARB, credit(10n * ONE), 2_000n);
    expect(out.kind === "evaluated" && out.verdict.reason).toBe(Reason.DOUBLE_CREDIT);
    expect(fake.writes).toHaveLength(3);
  });

  it("flags AMOUNT_MISMATCH when the credit mints more than was burned", () => {
    const fake = setup({ debitAmount: 10n * ONE });
    const out = runJunction(fake, c.w1, reviveSpec(c.w1.spec), ARB, credit(11n * ONE), 2_000n);
    expect(out.kind === "evaluated" && out.verdict.reason).toBe(Reason.AMOUNT_MISMATCH);
  });

  it("ignores logs that are not credits of the spec's bridges", () => {
    const fake = setup({ debitAmount: 0n });
    const foreign = { ...credit(ONE), address: ADDR.arb.token };
    expect(runJunction(fake, c.w1, reviveSpec(c.w1.spec), ARB, foreign, 2_000n).kind).toBe("ignored");
  });
});

function eventTopicOf(name: "Released" | "Burned"): Hex {
  const [topic0] = encodeEventTopics({ abi: BRIDGE_EVENTS, eventName: name });
  if (typeof topic0 !== "string") throw new Error(`no topic0 for ${name}`);
  return topic0;
}

// ------------------------------------------------------------------ W2

describe("W2 Loop Ledger", () => {
  type Book = { escrow: bigint; lockbox: bigint; arb: bigint; base: bigint; ledgers?: Partial<Record<string, LedgerState>>; homeDebit?: Hex };
  function setup(book: Book) {
    const fake = new FakeChain();
    for (const chain of [HOME, ARB, BASE]) fake.setHead(chain, 500n, 600n);
    const tokens: Record<string, { token: Hex; supply: bigint }> = {
      [HOME]: { token: ADDR.home.token, supply: 100n * ONE },
      [ARB]: { token: ADDR.arb.token, supply: book.arb },
      [BASE]: { token: ADDR.base.token, supply: book.base },
    };
    for (const [chain, t] of Object.entries(tokens)) {
      fake.on(chain, (to, data) => {
        if (to.toLowerCase() !== t.token.toLowerCase()) return undefined;
        const call = decodeFunctionData({ abi: ERC20_ABI, data });
        if (call.functionName === "totalSupply") return encodeFunctionResult({ abi: ERC20_ABI, functionName: "totalSupply", result: t.supply });
        const holder = call.args[0].toLowerCase();
        const balance = holder === ADDR.home.escrow ? book.escrow : holder === ADDR.home.lockbox ? book.lockbox : 0n;
        return encodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", result: balance });
      });
    }
    const ledgers = { [HOME]: ADDR.home.ledger, [ARB]: ADDR.arb.ledger, [BASE]: ADDR.base.ledger };
    for (const [chain, ledger] of Object.entries(ledgers)) serveLedger(fake, chain, ledger, book.ledgers?.[chain] ?? ledgerState());
    fake.on(HOME, (to, data) =>
      to.toLowerCase() === ADDR.home.escrow && selectorOf(data) === DEBIT_OF
        ? book.homeDebit === undefined
          ? debitOfReply(0n, `0x${"0".repeat(40)}`, 0n, 0n)
          : debitOfReply(5n * ONE, USER, SEL[ARB], 10n)
        : undefined,
    );
    return fake;
  }
  const run = (fake: FakeChain, budget = new ReadBudget()) => ({ out: runLoop(withBudget(fake, budget), c.w2, reviveSpec(c.w2.spec), 2_000_000_000n), budget });

  it("reports a donation to the escrow as surplus: CONSERVED, delta positive, EPOCH to every chain", () => {
    const { out, budget } = run(setup({ escrow: 3n * ONE, lockbox: 0n, arb: 0n, base: 0n }));
    expect(out.result.status).toBe(Status.CONSERVED);
    expect(out.result.delta).toBe(3n * ONE);
    expect(out.writes.map((w) => w.chain)).toEqual([HOME, ARB, BASE]);
    expect(budget.used).toBe(3 + 3 * 2 + 3);
  });

  it("counts CCIP lockbox and WeakBridge escrow together as home backing", () => {
    const { out } = run(setup({ escrow: 2n * ONE, lockbox: 3n * ONE, arb: 5n * ONE, base: 0n }));
    expect(out.result.delta).toBe(0n);
  });

  it("breaks on a mint with no message (LOOP_DEFICIT) and sends BREACH with recipient zero", () => {
    const fake = setup({ escrow: 0n, lockbox: 0n, arb: 50n * ONE, base: 0n });
    const { out } = run(fake);
    expect(out.result.status).toBe(Status.BROKEN);
    expect(out.result.reason).toBe(Reason.LOOP_DEFICIT);
    const writes = decodedWrites(fake);
    expect(writes).toHaveLength(3);
    const first = writes[0]?.report;
    expect(first?.reportType).toBe(ReportType.BREACH);
    if (first?.reportType === ReportType.BREACH) {
      expect(first.payload.amount).toBe(50n * ONE);
      expect(first.payload.recipient).toBe("0x0000000000000000000000000000000000000000");
    }
  });

  it("counts a locked-not-minted transfer in flight by message id (no false deficit across an epoch)", () => {
    const fake = setup({ escrow: 5n * ONE, lockbox: 0n, arb: 0n, base: 0n });
    fake.logsByChain.set(HOME, [burned(ADDR.home.escrow, ID, USER, USER, 5n * ONE, SEL[ARB], 450n)]);
    const { out } = run(fake);
    expect(out.inFlightOut).toBe(5n * ONE);
    expect(out.result.delta).toBe(0n);
    expect(out.result.status).toBe(Status.CONSERVED);
  });

  it("settles a credit whose debit is older than the log windows through the source debit registry", () => {
    const fake = setup({ escrow: 5n * ONE, lockbox: 0n, arb: 5n * ONE, base: 0n, homeDebit: ID });
    fake.logsByChain.set(ARB, [released(ADDR.arb.bridge, ID, USER, 5n * ONE, SEL[HOME], 450n)]);
    const { out } = run(fake);
    expect(out.settled.map((x) => x.toLowerCase())).toEqual([ID]);
    expect(out.result.delta).toBe(0n);
    const epoch = decodedWrites(fake)[0]?.report;
    expect(epoch?.reportType === ReportType.EPOCH && epoch.payload.settledMessageIds.map((x) => x.toLowerCase())).toEqual([ID]);
  });

  it("does not re-settle a credit already consumed onchain", () => {
    const consumed = { ...ledgerState(), consumed: new Set([ID]) };
    const fake = setup({ escrow: 5n * ONE, lockbox: 0n, arb: 5n * ONE, base: 0n, ledgers: { [HOME]: consumed } });
    fake.logsByChain.set(HOME, [burned(ADDR.home.escrow, ID, USER, USER, 5n * ONE, SEL[ARB], 440n)]);
    fake.logsByChain.set(ARB, [released(ADDR.arb.bridge, ID, USER, 5n * ONE, SEL[HOME], 450n)]);
    const { out } = run(fake);
    expect(out.settled).toEqual([]);
    expect(out.result.delta).toBe(0n);
  });

  it("keeps sending EPOCH during containment (raises the high-water mark) and RECOVERY_CHECK once the timelock ended", () => {
    const ledgers = {
      [HOME]: { ...ledgerState(Status.RECOVERING), recoveryEndsAt: 1_000n },
      [ARB]: { ...ledgerState(Status.RECOVERING), recoveryEndsAt: 99_999n },
      [BASE]: ledgerState(Status.QUARANTINED),
    };
    const fake = setup({ escrow: 0n, lockbox: 0n, arb: 0n, base: 0n, ledgers });
    run(fake);
    expect(decodedWrites(fake).map((w) => w.report.reportType)).toEqual([ReportType.RECOVERY_CHECK, ReportType.EPOCH, ReportType.EPOCH]);
  });

  it("subscribes to supply changes only: mint/burn on remotes, escrow in/out on home", () => {
    const filters = supplyTriggerFilters(c.w2);
    expect(filters).toHaveLength(6);
    const zero = pad("0x0", { size: 32 });
    const remote = filters.filter((f) => f.chain === ARB);
    expect(remote.map((f) => f.topics)).toEqual([[[eventTopic("Transfer")], [zero], []], [[eventTopic("Transfer")], [], [zero]]]);
    const home = filters.filter((f) => f.chain === HOME);
    expect(home.map((f) => f.side)).toEqual(["escrow_in", "escrow_out"]);
    expect(home[0]?.topics[2]).toContain(pad(ADDR.home.escrow, { size: 32 }));
    expect(home[0]?.topics[2]).toContain(pad(ADDR.home.lockbox, { size: 32 }));
  });
});

// ------------------------------------------------------------------ W3

describe("W3 Responder", () => {
  const evidence: Hex = `0x${"e1".repeat(32)}`;
  const breachLog = (): ChainLog => ({
    address: ADDR.home.ledger,
    topics: encodeEventTopics({ abi: BRIDGE_EVENTS, eventName: "BreachRecorded", args: { tokenId: c.w3.tokenId } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint16" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [Reason.DEBIT_NOT_FOUND, evidence, SEL[HOME], TX(9), ATTACKER, 7n * ONE],
    ),
    transactionHash: TX(9),
    blockNumber: 100n,
    logIndex: 3,
  });

  it("quarantines only ledgers whose active incident is this one and that are still BROKEN", () => {
    const id = incidentId(c.w3.tokenId, evidence);
    const fake = new FakeChain();
    serveLedger(fake, HOME, ADDR.home.ledger, { ...ledgerState(Status.BROKEN), active: id });
    serveLedger(fake, ARB, ADDR.arb.ledger, { ...ledgerState(Status.BROKEN), active: id });
    serveLedger(fake, BASE, ADDR.base.ledger, { ...ledgerState(Status.QUARANTINED), active: id });
    const budget = new ReadBudget();
    const out = runResponder(withBudget(fake, budget), c.w3, MULTICALL3, breachLog());
    expect(out.kind).toBe("contained");
    const writes = decodedWrites(fake);
    expect(writes.map((w) => w.chain)).toEqual([HOME, ARB]);
    const report = writes[0]?.report;
    expect(report?.reportType === ReportType.QUARANTINE_APPLIED && report.payload.incidentId).toBe(id);
    expect(report?.reportType === ReportType.QUARANTINE_APPLIED && report.payload.tainted.map((t) => t.toLowerCase())).toEqual([ATTACKER]);
    expect(budget.used).toBe(3);
  });

  it("decodes BreachRecorded and builds pages keyed by incident id, skipping channels with no secret", () => {
    const breach = decodeBreach(breachLog());
    const id = incidentId(c.w3.tokenId, evidence);
    const none = buildNotifications(incidentText("kETH", id, breach), id, { telegramBotToken: "", telegramChatId: "", slackWebhookUrl: "" });
    expect(none.requests).toEqual([]);
    expect(none.skipped).toEqual(["telegram", "slack"]);
    const both = buildNotifications(incidentText("kETH", id, breach), id, { telegramBotToken: "t", telegramChatId: "1", slackWebhookUrl: "https://hooks.example/x" });
    expect(both.requests.map((r) => r.idempotencyKey)).toEqual([id, id]);
    expect(both.requests[0]?.body).toContain("DEBIT_NOT_FOUND");
  });
});

// ------------------------------------------------------------------ W4

describe("W4 Topology Watch", () => {
  const grantLog = (account: Hex, token: Hex = ADDR.arb.token): ChainLog => ({
    address: token,
    topics: encodeEventTopics({ abi: BRIDGE_EVENTS, eventName: "RoleGranted", args: { role: c.w4.minterRole, account, sender: USER } }) as Hex[],
    data: "0x",
    transactionHash: TX(77),
    blockNumber: 300n,
    logIndex: 0,
  });
  const TOPO = parseAbi([
    "function getPool(address) view returns (address)",
    "function getSupportedChains() view returns (uint64[])",
    "function getRemotePools(uint64) view returns (bytes[])",
    "function activeSpecHash(bytes32) view returns (bytes32)",
  ]);
  const ROGUE: Hex = "0x00000000000000000000000000000000000000cc";

  type World = {
    hasRole?: boolean;
    activeSpec?: Hex;
    /** CCIP pools registered per chain (testnet chain ids only). */
    pools?: Record<string, Hex>;
    /** Remote pools a chain's pool trusts, per remote selector. */
    peers?: Record<string, Record<string, Hex[]>>;
    supported?: Record<string, bigint[]>;
  };

  /** kETH's W4 config with the public testnet chain ids, so the CCIP TokenAdminRegistry checks apply. */
  const onTestnets = (): Configs["w4"] => ({
    ...c.w4,
    chains: c.w4.chains.map((ch) => ({ ...ch, tokenAdminRegistry: REGISTRY[ch.name] ?? null })),
  });
  const REGISTRY: Record<string, Hex> = {
    [HOME]: "0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82",
    [ARB]: "0x8126bE56454B628a88C17849B9ED99dd5a11Bd2f",
    [BASE]: "0x736D0bBb318c1B27Ff686cd19804094E66250e17",
  };

  function setup(w: World) {
    const fake = new FakeChain();
    for (const chain of [HOME, ARB, BASE]) fake.setHead(chain, 500n, 600n);
    serveLedger(fake, HOME, ADDR.home.ledger, ledgerState());
    serveLedger(fake, ARB, ADDR.arb.ledger, ledgerState());
    serveLedger(fake, BASE, ADDR.base.ledger, ledgerState(Status.UNKNOWN));
    fake.on(HOME, (to) =>
      to.toLowerCase() === ADDR.home.registry
        ? encodeFunctionResult({ abi: TOPO, functionName: "activeSpecHash", result: w.activeSpec ?? c.w4.specHash })
        : undefined,
    );
    fake.on(ARB, (to, data) =>
      to.toLowerCase() === ADDR.arb.token && selectorOf(data) === toFunctionSelector("hasRole(bytes32,address)")
        ? encodeFunctionResult({ abi: ACCESS_CONTROL_ABI, functionName: "hasRole", result: w.hasRole ?? true })
        : undefined,
    );
    // Without a TokenAdminRegistry W4 checks the spec pools' peers, so the fake serves those pools by default.
    const pools: Partial<Record<string, Hex>> = w.pools ?? { [HOME]: ADDR.home.pool, [ARB]: ADDR.arb.pool, [BASE]: ADDR.base.pool };
    for (const chain of [HOME, ARB, BASE]) {
      fake.on(chain, (to, data) => {
        if (to.toLowerCase() === REGISTRY[chain]?.toLowerCase()) {
          return encodeFunctionResult({ abi: TOPO, functionName: "getPool", result: pools[chain] ?? "0x0000000000000000000000000000000000000000" });
        }
        if (to.toLowerCase() !== pools[chain]?.toLowerCase()) return undefined;
        const call = decodeFunctionData({ abi: TOPO, data });
        if (call.functionName === "getSupportedChains") {
          return encodeFunctionResult({ abi: TOPO, functionName: "getSupportedChains", result: w.supported?.[chain] ?? [HOME, ARB, BASE].filter((x) => x !== chain).map((x) => SEL[x as keyof typeof SEL]) });
        }
        if (call.functionName === "getRemotePools") {
          const remote = [HOME, ARB, BASE].find((x) => SEL[x as keyof typeof SEL] === call.args[0]) ?? "";
          const peer = pools[remote];
          const list = w.peers?.[chain]?.[remote] ?? (peer === undefined ? [] : [peer]);
          return encodeFunctionResult({ abi: TOPO, functionName: "getRemotePools", result: list.map((p) => pad(p, { size: 32 })) });
        }
        return undefined;
      });
    }
    return fake;
  }
  const spec = (log: ChainLog = grantLog(ATTACKER)) => ({ kind: "spec" as const, log });
  const grant = (account: Hex) => ({ kind: "grant" as const, chain: ARB, log: grantLog(account) });
  const consistentPools = { [HOME]: ADDR.home.pool, [ARB]: ADDR.arb.pool, [BASE]: ADDR.base.pool };

  it("raises EPOCH DRIFT SPEC_MISMATCH for a minter outside the spec, with a page keyed by the drift", () => {
    const fake = setup({});
    const budget = new ReadBudget();
    const out = runTopology(withBudget(fake, budget), c.w4, MULTICALL3, grant(ATTACKER), 2_000n);
    expect(out.findings.map((f) => f.kind === "minter" && f.account)).toEqual([ATTACKER]);
    const writes = decodedWrites(fake);
    expect(writes.map((w) => w.chain)).toEqual([HOME, ARB]);
    const r = writes[0]?.report;
    expect(r?.reportType === ReportType.EPOCH && [r.payload.status, r.payload.reason]).toEqual([Status.DRIFT, Reason.SPEC_MISMATCH]);
    expect(r?.reportType === ReportType.EPOCH && r.payload.epochId).toBe(2_000n);
    expect(out.text).toContain(ATTACKER);
    expect(out.driftKey).toBe(driftKey(c.w4.tokenId, out.findings));
    // 3 state + 3 pool-peer aggregate3 (the spec pools, no TokenAdminRegistry on Anvil-style configs)
    expect(budget.used).toBe(6);
  });

  it("ignores a grant to a spec minter and a grant that was already revoked", () => {
    expect(runTopology(setup({}), c.w4, MULTICALL3, grant(ADDR.arb.bridge), 1n).findings).toEqual([]);
    expect(runTopology(setup({ hasRole: false }), c.w4, MULTICALL3, grant(ATTACKER), 1n).findings).toEqual([]);
  });

  it("reloads the active spec: a registry hash different from the running spec is SPEC_MISMATCH, an equal one is clean", () => {
    const other: Hex = `0x${"ab".repeat(32)}`;
    const stale = runTopology(setup({ activeSpec: other }), c.w4, MULTICALL3, spec(), 1n);
    expect(stale.findings.map((f) => f.kind)).toEqual(["spec"]);
    expect(stale.text).toContain(other);
    const none = runTopology(setup({ activeSpec: `0x${"0".repeat(64)}` }), c.w4, MULTICALL3, spec(), 1n);
    expect(none.findings.map((f) => f.kind)).toEqual(["spec"]);
    expect(runTopology(setup({}), c.w4, MULTICALL3, spec(), 1n).findings).toEqual([]);
  });

  it("scans RoleGranted windows on every remote within the read budget on the cron path", () => {
    const fake = setup({});
    fake.logsByChain.set(ARB, [{ ...grantLog(ATTACKER), blockNumber: 590n }]);
    const budget = new ReadBudget();
    const out = runTopology(withBudget(fake, budget), c.w4, MULTICALL3, { kind: "scan" }, 2_000n);
    expect(out.findings).toHaveLength(1);
    expect(budget.used).toBe(2 + 2 * 3 + 3 + 3);
  });

  it("checks the CCIP pool and its peers from current state; all consistent is clean at 14 reads", () => {
    const budget = new ReadBudget();
    const out = runTopology(withBudget(setup({ pools: consistentPools }), budget), onTestnets(), MULTICALL3, { kind: "scan" }, 1n);
    expect(out.findings).toEqual([]);
    expect(budget.used).toBe(2 + 2 * 3 + 3 + 3);
  });

  it("flags a registry pool that is not a spec minter, a rogue peer pool and a peer chain outside the spec", () => {
    const swapped = runTopology(setup({ pools: { ...consistentPools, [ARB]: ROGUE } }), onTestnets(), MULTICALL3, { kind: "pool", chain: ARB, log: grantLog(ROGUE) }, 1n);
    expect(swapped.findings.some((f) => f.kind === "pool" && f.pool === ROGUE)).toBe(true);

    const peer = runTopology(setup({ pools: consistentPools, peers: { [HOME]: { [BASE]: [ADDR.base.pool, ROGUE] } } }), onTestnets(), MULTICALL3, { kind: "scan" }, 1n);
    expect(peer.findings.map((f) => f.kind === "peer" && f.detail)).toEqual([expect.stringContaining(ROGUE)]);

    const chain = runTopology(setup({ pools: consistentPools, supported: { [BASE]: [SEL[HOME], 4949039107694359620n] } }), onTestnets(), MULTICALL3, { kind: "scan" }, 1n);
    expect(chain.findings.map((f) => f.kind === "peer" && f.detail)).toEqual([expect.stringContaining("4949039107694359620")]);
  });

  it("derives one drift key for the same findings regardless of order", () => {
    const out = runTopology(setup({ activeSpec: `0x${"ab".repeat(32)}` }), c.w4, MULTICALL3, grant(ATTACKER), 1n);
    expect(out.findings).toHaveLength(2);
    expect(driftKey(c.w4.tokenId, [...out.findings].reverse())).toBe(out.driftKey);
  });
});

// ------------------------------------------------------------------ W2 Proof of Reserve

describe("W2 Proof of Reserve (PRD section 8 W2 step 4)", () => {
  const FEED: Hex = "0x00000000000000000000000000000000000f33d0";
  const AGG = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

  /** kETH's chains as a reserve-backed burn-and-mint token whose PoR feed (8 decimals) lives on home. */
  function backedConfig(porFeed: Hex | null): Configs["w2"] {
    return {
      ...c.w2,
      model: "burn_mint_multi",
      porFeed,
      reserveDecimals: 8,
      escrowHolders: [],
      spec: { ...c.w2.spec, model: "burn_mint_multi", reserves: { porFeed, decimals: 8 } },
    };
  }

  function setup(supplies: Record<string, bigint>, answer: bigint | null) {
    const fake = new FakeChain();
    const feedCalls: bigint[] = [];
    for (const chain of [HOME, ARB, BASE]) fake.setHead(chain, 500n, 600n);
    const tokens: Record<string, Hex> = { [HOME]: ADDR.home.token, [ARB]: ADDR.arb.token, [BASE]: ADDR.base.token };
    for (const [chain, token] of Object.entries(tokens)) {
      fake.on(chain, (to, data) => {
        if (to.toLowerCase() !== token.toLowerCase()) return undefined;
        return decodeFunctionData({ abi: ERC20_ABI, data }).functionName === "totalSupply"
          ? encodeFunctionResult({ abi: ERC20_ABI, functionName: "totalSupply", result: supplies[chain] ?? 0n })
          : encodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", result: 0n });
      });
    }
    serveLedger(fake, HOME, ADDR.home.ledger, ledgerState());
    serveLedger(fake, ARB, ADDR.arb.ledger, ledgerState());
    serveLedger(fake, BASE, ADDR.base.ledger, ledgerState());
    fake.on(HOME, (to, _data, block) => {
      if (to.toLowerCase() !== FEED) return undefined;
      if (block.tag === "number") feedCalls.push(block.number);
      if (answer === null) throw new Error("feed has no code");
      return encodeFunctionResult({ abi: AGG, functionName: "latestRoundData", result: [7n, answer, 1n, 1n, 7n] });
    });
    return { fake, feedCalls };
  }

  it("skips the PoR read cleanly when the spec has no feed (kETH): 12 reads, no feed call", () => {
    expect(c.w2.porFeed).toBeNull();
    const { fake, feedCalls } = setup({ [HOME]: 100n * ONE }, null);
    const budget = new ReadBudget();
    const out = runLoop(withBudget(fake, budget), c.w2, reviveSpec(c.w2.spec), 2_000_000_000n);
    expect(out.result.status).toBe(Status.CONSERVED);
    expect(out.result.delta).toBe(0n);
    expect(feedCalls).toEqual([]);
    expect(budget.used).toBe(12);
  });

  it("reads latestRoundData at the pinned home block and stays CONSERVED while the reserve covers every claim", () => {
    const config = backedConfig(FEED);
    // 60 + 30 + 10 = 100 tokens claimed; reserve 100.00000000 (8 decimals) rescales to exactly 100e18.
    const { fake, feedCalls } = setup({ [HOME]: 60n * ONE, [ARB]: 30n * ONE, [BASE]: 10n * ONE }, 100n * 10n ** 8n);
    const budget = new ReadBudget();
    const out = runLoop(withBudget(fake, budget), config, reviveSpec(config.spec), 2_000_000_000n);
    expect(feedCalls).toEqual([500n]);
    expect(out.result.status).toBe(Status.CONSERVED);
    expect(out.result.delta).toBe(0n);
    expect(budget.used).toBe(12);
  });

  it("breaks with RESERVE_SHORTFALL when claims exceed the reserve", () => {
    const config = backedConfig(FEED);
    const { fake } = setup({ [HOME]: 60n * ONE, [ARB]: 45n * ONE, [BASE]: 10n * ONE }, 100n * 10n ** 8n);
    const out = runLoop(fake, config, reviveSpec(config.spec), 2_000_000_000n);
    expect(out.result.status).toBe(Status.BROKEN);
    expect(out.result.reason).toBe(Reason.RESERVE_SHORTFALL);
    expect(out.result.delta).toBe(-15n * ONE);
    const first = decodedWrites(fake)[0]?.report;
    expect(first?.reportType === ReportType.BREACH && first.payload.amount).toBe(15n * ONE);
  });

  it("fails closed on a negative reserve answer and on a burn-and-mint token with no feed", () => {
    const config = backedConfig(FEED);
    const { fake } = setup({ [HOME]: ONE }, -1n);
    expect(() => runLoop(fake, config, reviveSpec(config.spec), 2_000_000_000n)).toThrow(/negative reserve/);
    const none = backedConfig(null);
    expect(() => runLoop(setup({}, null).fake, none, reviveSpec(none.spec), 1n)).toThrow(/without a PoR feed/);
  });
});
