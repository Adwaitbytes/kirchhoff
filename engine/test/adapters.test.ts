import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  pad,
  parseAbiItem,
  toEventSelector,
  toFunctionSelector,
  toHex,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_REGISTRY_ABI,
  CCIP_TOPICS,
  NO_TX,
  WEAKBRIDGE_EVENTS,
  adaptersForSpec,
  creditFromRegistry,
  debitFromRegistry,
  encodeCreditOf,
  encodeDebitOf,
  createCcipV2Adapter,
  createEventAdapter,
  createWeakbridgeAdapter,
  emitterOn,
  messageIdTopic,
  parseBridgeEvent,
  type Log,
} from "../src/adapters/index.ts";
import { topicAt } from "../src/adapters/ccip.ts";
import { bigintArg, hexArg } from "../src/adapters/event.ts";
import { EngineInputError, type BridgeEvents, type TokenSpec } from "../src/types.ts";
import {
  ALICE,
  ARB,
  BASE,
  ESCROW,
  HOME,
  OFFRAMP_ARB,
  OFFRAMP_HOME,
  ONRAMP_ARB,
  POOL_ARB,
  POOL_HOME,
  REMOTE_ARB,
  WB_ARB,
  addr,
  hash,
  makeSpec,
  units,
} from "./fixtures.ts";

const burned = parseAbiItem("event Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)");
const released = parseAbiItem("event Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain)");
const ID = hash("wb-1");

function burnedLog(address: Hex, over: Partial<Log> = {}): Log {
  return {
    address,
    topics: encodeEventTopics({ abi: [burned], eventName: "Burned", args: { id: ID, from: ALICE } }) as Hex[],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint64" }], [ALICE, units(3n), ARB]),
    transactionHash: hash("tx-burn"),
    blockNumber: 77n,
    ...over,
  };
}

function releasedLog(address: Hex): Log {
  return {
    address,
    topics: encodeEventTopics({ abi: [released], eventName: "Released", args: { id: ID, to: ALICE } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [units(3n), HOME]),
    transactionHash: hash("tx-release"),
    blockNumber: 88n,
  };
}

describe("weakbridge adapter", () => {
  const spec = makeSpec();
  const wb = createWeakbridgeAdapter(spec);

  it("exposes the PRD adapter contract", () => {
    expect(wb.id).toBe("weakbridge");
    expect(wb.messageIdTopicIndex).toBe(1);
    expect(wb.maxDeliverySeconds).toBe(1200);
    expect(wb.debitTopics(spec, ARB)).toEqual([toEventSelector(burned)]);
    expect(wb.creditTopics(spec, HOME)).toEqual([toEventSelector(released)]);
  });

  it("returns no topics on a chain without the bridge, or for a spec without it", () => {
    const noBase: TokenSpec = {
      ...spec,
      bridges: spec.bridges.map((b) => (b.kind === "custom" ? { ...b, contracts: { home: ESCROW } } : b)),
    };
    expect(wb.debitTopics(noBase, BASE)).toEqual([]);
    expect(wb.creditTopics({ ...spec, bridges: [] }, ARB)).toEqual([]);
  });

  it("decodes a remote burn as a debit", () => {
    expect(wb.decodeDebit(burnedLog(WB_ARB), ARB)).toEqual({
      messageId: ID,
      srcChain: ARB,
      dstChain: ARB,
      amount: units(3n),
      recipient: ALICE,
      txHash: hash("tx-burn"),
      block: 77n,
    });
  });

  it("decodes a home release from the escrow adapter as a credit", () => {
    const credit = wb.decodeCredit(releasedLog(ESCROW), HOME);
    expect(credit).toMatchObject({ messageId: ID, claimedSrcChain: HOME, dstChain: HOME, amount: units(3n) });
    expect(credit?.recipient?.toLowerCase()).toBe(ALICE);
  });

  it("ignores logs from any other emitter (Junction condition 2: token identity)", () => {
    expect(wb.decodeDebit(burnedLog(addr(0xdead)), ARB)).toBeNull();
    expect(wb.decodeDebit(burnedLog(WB_ARB), HOME)).toBeNull();
    expect(wb.decodeCredit(releasedLog(addr(0xdead)), HOME)).toBeNull();
  });

  it("ignores other events and malformed logs from the right emitter", () => {
    expect(wb.decodeDebit(releasedLog(WB_ARB), ARB)).toBeNull();
    expect(wb.decodeCredit(burnedLog(ESCROW), HOME)).toBeNull();
    expect(wb.decodeDebit(burnedLog(WB_ARB, { topics: [] }), ARB)).toBeNull();
    expect(wb.decodeDebit(burnedLog(WB_ARB, { data: "0x1234" }), ARB)).toBeNull();
  });

  it("refuses a spec whose weakbridge events differ from the frozen ones", () => {
    const edited: TokenSpec = {
      ...spec,
      bridges: spec.bridges.map((b) =>
        b.kind === "custom" ? { ...b, events: { ...b.events, creditEvent: "Released(bytes32 indexed id, uint256 amount, uint64 srcChain)" } } : b,
      ),
    };
    expect(() => createWeakbridgeAdapter(edited)).toThrow(EngineInputError);
    const editedDebit: TokenSpec = {
      ...spec,
      bridges: spec.bridges.map((b) => (b.kind === "custom" ? { ...b, events: { ...b.events, debitEvent: "Burned(bytes32 indexed id)" } } : b)),
    };
    expect(() => createWeakbridgeAdapter(editedDebit)).toThrow(EngineInputError);
    expect(() => createWeakbridgeAdapter(spec, "ccip")).toThrow(EngineInputError);
  });

  it("accepts the frozen events with different whitespace", () => {
    const spaced: TokenSpec = {
      ...spec,
      bridges: spec.bridges.map((b) =>
        b.kind === "custom" ? { ...b, events: { ...b.events, debitEvent: `  ${b.events.debitEvent.replaceAll(" ", "  ")} ` } } : b,
      ),
    };
    expect(createWeakbridgeAdapter(spaced).id).toBe("weakbridge");
  });
});

describe("ccip_v2 adapter (CCIP 2.0.0 events, docs/research/ccip.md)", () => {
  const spec = makeSpec();
  const ccip = createCcipV2Adapter(spec);
  const lockedOrBurned = parseAbiItem("event LockedOrBurned(uint64 indexed remoteChainSelector, address token, address sender, uint256 amount)");
  const releasedOrMinted = parseAbiItem(
    "event ReleasedOrMinted(uint64 indexed remoteChainSelector, address token, address sender, address recipient, uint256 amount)",
  );
  const executionStateChanged = parseAbiItem(
    "event ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed messageNumber, bytes32 indexed messageId, uint8 state, bytes returnData)",
  );
  const MSG = hash("ccip-msg");
  const tx = hash("ccip-tx");
  const log = (address: Hex, topics: Hex[], data: Hex): Log => ({ address, topics, data, transactionHash: tx, blockNumber: 9n });

  const poolDebit = (pool: Hex, remote: bigint, amount: bigint): Log =>
    log(
      pool,
      encodeEventTopics({ abi: [lockedOrBurned], eventName: "LockedOrBurned", args: { remoteChainSelector: remote } }) as Hex[],
      encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [REMOTE_ARB, ONRAMP_ARB, amount]),
    );
  // CCIPMessageSent data is not decoded (only its topics are), so an empty body is enough for the pairing tests.
  const sent = (onramp: Hex, dest: bigint, id: Hex): Log =>
    log(onramp, [CCIP_TOPICS.CCIPMessageSent, pad(toHex(dest)), pad(ALICE), id], "0x");
  const poolCredit = (pool: Hex, remote: bigint, amount: bigint): Log =>
    log(
      pool,
      encodeEventTopics({ abi: [releasedOrMinted], eventName: "ReleasedOrMinted", args: { remoteChainSelector: remote } }) as Hex[],
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
        [REMOTE_ARB, OFFRAMP_ARB, ALICE, amount],
      ),
    );
  const executed = (offramp: Hex, src: bigint, id: Hex): Log =>
    log(
      offramp,
      encodeEventTopics({
        abi: [executionStateChanged],
        eventName: "ExecutionStateChanged",
        args: { sourceChainSelector: src, messageNumber: 1n, messageId: id },
      }) as Hex[],
      encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [2, "0x"]),
    );

  it("uses the topic hashes verified against live Sepolia logs", () => {
    expect(CCIP_TOPICS).toEqual({
      LockedOrBurned: "0xf33bc26b4413b0e7f19f1ea739fdf99098c0061f1f87d954b11f5293fad9ae10",
      ReleasedOrMinted: "0xfc5e3a5bddc11d92c2dc20fae6f7d5eb989f056be35239f7de7e86150609abc0",
      CCIPMessageSent: "0x371bc2ff0a006f4ef863b1d27a065d4e9f938b6d883eb154572b4aea593b32cc",
      ExecutionStateChanged: "0x8c324ce1367b83031769f6a813e3bb4c117aba2185789d66b98b791405be6df2",
    });
  });

  it("filters debits on the OnRamp and credits on the OffRamp by message id topic 3", () => {
    expect(ccip.id).toBe("ccip_v2");
    expect(ccip.messageIdTopicIndex).toBe(3);
    expect(ccip.maxDeliverySeconds).toBe(1200);
    expect(ccip.debitTopics(spec, ARB)).toEqual([CCIP_TOPICS.CCIPMessageSent]);
    expect(ccip.creditTopics(spec, HOME)).toEqual([CCIP_TOPICS.ExecutionStateChanged]);
    expect(ccip.debitTopics(spec, 1n)).toEqual([]);
    expect(ccip.creditTopics({ ...spec, bridges: [] }, HOME)).toEqual([]);
  });

  it("never decodes a single log: the id and the value are on different logs", () => {
    expect(ccip.decodeDebit(poolDebit(POOL_ARB, HOME, 5n), ARB)).toBeNull();
    expect(ccip.decodeCredit(executed(OFFRAMP_HOME, ARB, MSG), HOME)).toBeNull();
  });

  it("pairs LockedOrBurned with CCIPMessageSent in the same transaction", () => {
    const logs = [poolDebit(POOL_ARB, HOME, 5n), sent(ONRAMP_ARB, HOME, MSG)];
    expect(ccip.decodeTxDebits(logs, ARB)).toEqual([
      { messageId: MSG, srcChain: ARB, dstChain: HOME, amount: 5n, txHash: tx, block: 9n },
    ]);
  });

  it("pairs each ramp log with the nearest preceding pool log", () => {
    const other = hash("second");
    const logs = [poolDebit(POOL_ARB, HOME, 5n), sent(ONRAMP_ARB, HOME, MSG), poolDebit(POOL_ARB, BASE, 7n), sent(ONRAMP_ARB, BASE, other)];
    expect(ccip.decodeTxDebits(logs, ARB).map((d) => [d.messageId, d.amount, d.dstChain])).toEqual([
      [MSG, 5n, HOME],
      [other, 7n, BASE],
    ]);
  });

  it("ignores pool and ramp logs from other contracts, unpaired ramps and undecodable pool data", () => {
    expect(ccip.decodeTxDebits([poolDebit(addr(0xdead), HOME, 5n), sent(ONRAMP_ARB, HOME, MSG)], ARB)).toEqual([]);
    expect(ccip.decodeTxDebits([poolDebit(POOL_ARB, HOME, 5n), sent(addr(0xdead), HOME, MSG)], ARB)).toEqual([]);
    expect(ccip.decodeTxDebits([sent(ONRAMP_ARB, HOME, MSG)], ARB)).toEqual([]);
    expect(ccip.decodeTxDebits([{ ...poolDebit(POOL_ARB, HOME, 5n), data: "0x12" }, sent(ONRAMP_ARB, HOME, MSG)], ARB)).toEqual([]);
    const short = { ...sent(ONRAMP_ARB, HOME, MSG), topics: [CCIP_TOPICS.CCIPMessageSent] };
    expect(ccip.decodeTxDebits([poolDebit(POOL_ARB, HOME, 5n), short], ARB)).toEqual([]);
    const noTopics = { ...poolDebit(POOL_ARB, HOME, 5n), topics: [] };
    expect(ccip.decodeTxDebits([noTopics, sent(ONRAMP_ARB, HOME, MSG)], ARB)).toEqual([]);
    expect(ccip.decodeTxDebits([poolDebit(POOL_ARB, HOME, 5n), sent(ONRAMP_ARB, HOME, MSG)], 1n)).toEqual([]);
  });

  it("pairs ReleasedOrMinted with ExecutionStateChanged and keeps the pool's recipient", () => {
    const logs = [poolCredit(POOL_HOME, ARB, 5n), executed(OFFRAMP_HOME, ARB, MSG)];
    expect(ccip.decodeTxCredits(logs, HOME)).toEqual([
      { messageId: MSG, claimedSrcChain: ARB, dstChain: HOME, amount: 5n, recipient: ALICE, txHash: tx, block: 9n },
    ]);
  });

  it("drops a credit whose pool lane disagrees with the OffRamp source", () => {
    expect(ccip.decodeTxCredits([poolCredit(POOL_HOME, BASE, 5n), executed(OFFRAMP_HOME, ARB, MSG)], HOME)).toEqual([]);
  });

  it("an execution with no pool release (failed execution reverts it) is no credit", () => {
    expect(ccip.decodeTxCredits([executed(OFFRAMP_HOME, ARB, MSG)], HOME)).toEqual([]);
  });

  it("refuses a bridge id that is not ccip_v2", () => {
    expect(() => createCcipV2Adapter(spec, "weakbridge")).toThrow(EngineInputError);
  });

  it("topicAt rejects a missing topic", () => {
    expect(() => topicAt(log(POOL_ARB, [], "0x"), 1)).toThrow(EngineInputError);
  });

  it("adaptersForSpec builds ccip, weakbridge and generic adapters", () => {
    const testEvents: BridgeEvents = {
      ...WEAKBRIDGE_EVENTS,
      debitEvent: "Sent(bytes32 indexed id, address to, uint256 amount, uint64 dstChain)",
      creditEvent: "Got(bytes32 indexed id, address to, uint256 amount, uint64 srcChain)",
    };
    const custom: TokenSpec = {
      ...spec,
      bridges: [
        ...spec.bridges,
        { id: "mybridge", kind: "custom", contracts: { arb: addr(9) }, events: testEvents, searchWindowBlocks: 1n, maxDeliverySeconds: 60 },
        {
          id: "halfwb",
          kind: "custom",
          contracts: {},
          events: { ...WEAKBRIDGE_EVENTS, creditEvent: testEvents.creditEvent },
          searchWindowBlocks: 1n,
          maxDeliverySeconds: 60,
        },
      ],
    };
    const adapters = adaptersForSpec(custom);
    expect(adapters.map((a) => a.id)).toEqual(["ccip_v2", "weakbridge", "mybridge", "halfwb"]);
    expect(adapters[1]?.decodeTxDebits([burnedLog(WB_ARB), releasedLog(WB_ARB)], ARB)).toHaveLength(1);
    expect(adapters[1]?.decodeTxCredits([burnedLog(ESCROW), releasedLog(ESCROW)], HOME)).toHaveLength(1);
  });
});

describe("debit and credit registries (INTERFACES.md revision 2, item 3)", () => {
  const ret = (fn: "debitOf" | "creditOf", amount: bigint, chain: bigint) =>
    encodeFunctionResult({ abi: BRIDGE_REGISTRY_ABI, functionName: fn, result: [amount, ALICE, chain, 77n] });

  it("encodes the calls", () => {
    expect(encodeDebitOf(ID).slice(0, 10)).toBe(toFunctionSelector("debitOf(bytes32)"));
    expect(encodeCreditOf(ID).slice(0, 10)).toBe(toFunctionSelector("creditOf(bytes32)"));
  });

  it("turns a debitOf read into the same Debit shape a log yields", () => {
    expect(debitFromRegistry(ID, ARB, ret("debitOf", units(3n), HOME))).toEqual({
      messageId: ID,
      srcChain: ARB,
      dstChain: HOME,
      amount: units(3n),
      recipient: ALICE,
      txHash: NO_TX,
      block: 77n,
    });
    expect(debitFromRegistry(ID, ARB, ret("debitOf", 0n, 0n))).toBeNull();
    expect(debitFromRegistry(ID, ARB, ret("debitOf", 1n, HOME), hash("t"))?.txHash).toBe(hash("t"));
  });

  it("turns a creditOf read into a Credit", () => {
    expect(creditFromRegistry(ID, HOME, ret("creditOf", 5n, ARB))).toMatchObject({ claimedSrcChain: ARB, dstChain: HOME, amount: 5n, recipient: ALICE });
    expect(creditFromRegistry(ID, HOME, ret("creditOf", 0n, 0n))).toBeNull();
    expect(creditFromRegistry(ID, HOME, ret("creditOf", 1n, ARB), hash("t"))?.txHash).toBe(hash("t"));
  });
});

describe("event parsing helpers", () => {
  const fields = WEAKBRIDGE_EVENTS.debitFields;
  it("rejects invalid signatures and field maps", () => {
    expect(() => parseBridgeEvent("not an event((", fields)).toThrow(/invalid event signature/);
    expect(() => parseBridgeEvent("Burned(bytes32 indexed id, uint256 amount, uint64 dstChain)", fields)).toThrow(/"to"/);
    expect(() => parseBridgeEvent("Burned(bytes32 indexed id, address to, uint128 amount, uint64 dstChain)", fields)).toThrow(/amount/);
  });
  it("finds the message id topic and requires it indexed", () => {
    const second = parseBridgeEvent("X(address indexed to, bytes32 indexed id, uint256 amount, uint64 dstChain)", fields);
    expect(messageIdTopic(second)).toBe(2);
    const third = parseBridgeEvent("X(address indexed to, uint64 indexed dstChain, bytes32 indexed id, uint256 amount)", fields);
    expect(messageIdTopic(third)).toBe(3);
    const unindexed = parseBridgeEvent("X(bytes32 id, address to, uint256 amount, uint64 dstChain)", fields);
    expect(() => messageIdTopic(unindexed)).toThrow(/must index/);
  });
  it("requires debit and credit to share the message id topic", () => {
    const spec = makeSpec();
    const events: BridgeEvents = {
      ...WEAKBRIDGE_EVENTS,
      creditEvent: "Released(address indexed to, bytes32 indexed id, uint256 amount, uint64 srcChain)",
    };
    expect(() => createEventAdapter({ id: "x", spec, bridgeId: "weakbridge", events })).toThrow(/same topic/);
    expect(() => createEventAdapter({ id: "x", spec, bridgeId: "nope", events })).toThrow(/no bridge/);
  });
  it("emitterOn skips aliases that name no spec chain", () => {
    const spec = makeSpec();
    const bridge = { ...spec.bridges[1], kind: "custom", contracts: { mars: addr(1), arb: WB_ARB } } as TokenSpec["bridges"][number];
    expect(emitterOn(spec, bridge, ARB)).toBe(WB_ARB);
    expect(emitterOn(spec, bridge, BASE)).toBeNull();
  });
});

describe("generic event adapter", () => {
  it("decodes a bridge that does not carry the recipient", () => {
    const events: BridgeEvents = {
      debitEvent: "Sent(bytes32 indexed id, uint256 amount, uint64 dstChain)",
      creditEvent: "Got(bytes32 indexed id, uint256 amount, uint64 srcChain)",
      debitFields: { messageId: "id", amount: "amount", recipient: null, remoteChain: "dstChain" },
      creditFields: { messageId: "id", amount: "amount", recipient: null, remoteChain: "srcChain" },
    };
    const adapter = createEventAdapter({ id: "plain", spec: makeSpec(), bridgeId: "weakbridge", events });
    const sentAbi = parseAbiItem("event Sent(bytes32 indexed id, uint256 amount, uint64 dstChain)");
    const log: Log = {
      address: WB_ARB,
      topics: encodeEventTopics({ abi: [sentAbi], eventName: "Sent", args: { id: ID } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [4n, HOME]),
      transactionHash: hash("t"),
      blockNumber: 3n,
    };
    expect(adapter.decodeDebit(log, ARB)).toEqual({ messageId: ID, srcChain: ARB, dstChain: HOME, amount: 4n, txHash: hash("t"), block: 3n });
  });
});

describe("decoded argument narrowing", () => {
  it("rejects values of the wrong runtime type", () => {
    expect(hexArg({ id: "0xAB" }, "id")).toBe("0xab");
    expect(() => hexArg({ id: 5n }, "id")).toThrow(EngineInputError);
    expect(() => hexArg({ id: "zz" }, "id")).toThrow(EngineInputError);
    expect(bigintArg({ n: 5n }, "n")).toBe(5n);
    expect(() => bigintArg({ n: "5" }, "n")).toThrow(EngineInputError);
  });
});
