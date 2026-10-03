import { decodeEventLog, parseAbiItem, toEventSelector, type AbiEvent } from "viem";
import { chainByAlias } from "../chains.ts";
import {
  EngineInputError,
  type BridgeEvents,
  type BridgeSpec,
  type ChainSel,
  type Credit,
  type Debit,
  type EventFieldMap,
  type Hex,
  type TokenSpec,
} from "../types.ts";
import type { BridgeAdapter, Log } from "./types.ts";

type ParsedEvent = { abi: AbiEvent; selector: Hex; fields: EventFieldMap };

const FIELD_TYPES: Record<keyof EventFieldMap, readonly string[]> = {
  messageId: ["bytes32"],
  amount: ["uint256"],
  recipient: ["address"],
  remoteChain: ["uint64"],
};

/** Parses a spec event signature such as `Burned(bytes32 indexed id, ...)` and checks the field map against it. */
export function parseBridgeEvent(signature: string, fields: EventFieldMap): ParsedEvent {
  let abi: AbiEvent;
  try {
    abi = parseAbiItem(`event ${signature}`) as AbiEvent;
  } catch (cause) {
    throw new EngineInputError(`invalid event signature "${signature}"`, { cause });
  }
  for (const key of ["messageId", "amount", "recipient", "remoteChain"] as const) {
    const name = fields[key];
    if (name === null) continue;
    const input = abi.inputs.find((i) => i.name === name);
    if (input === undefined || !FIELD_TYPES[key].includes(input.type)) {
      throw new EngineInputError(`event ${abi.name} needs a ${FIELD_TYPES[key].join("|")} parameter "${name}" for ${key}`);
    }
  }
  return { abi, selector: toEventSelector(abi), fields };
}

/** 1-based topic index of the message id; it must be indexed so filterLogs can select by it. */
export function messageIdTopic(event: ParsedEvent): 1 | 2 | 3 {
  const indexed = event.abi.inputs.filter((i) => i.indexed === true);
  const position = indexed.findIndex((i) => i.name === event.fields.messageId) + 1;
  if (position === 1 || position === 2 || position === 3) return position;
  throw new EngineInputError(`event ${event.abi.name} must index its message id parameter`);
}

function emitterMap(bridge: BridgeSpec): Readonly<Record<string, Hex>> {
  return bridge.kind === "ccip_v2" ? bridge.pools : bridge.contracts;
}

export type AddressMapName = "pools" | "onramps" | "offramps" | "contracts";

/** Every alias-keyed address map a bridge declares. */
export function bridgeAddressMaps(bridge: BridgeSpec): { name: AddressMapName; map: Readonly<Record<string, Hex>> }[] {
  return bridge.kind === "ccip_v2"
    ? [
        { name: "pools", map: bridge.pools },
        { name: "onramps", map: bridge.onramps },
        { name: "offramps", map: bridge.offramps },
      ]
    : [{ name: "contracts", map: bridge.contracts }];
}

/** The address an alias-keyed map assigns to a chain, if any. */
export function addressOn(spec: TokenSpec, map: Readonly<Record<string, Hex>>, chain: ChainSel): Hex | null {
  for (const [alias, address] of Object.entries(map)) {
    if (chainByAlias(spec, alias)?.selector === chain) return address;
  }
  return null;
}

/** The bridge contract that moves value on a chain (custom endpoint or CCIP pool), if deployed there. */
export function emitterOn(spec: TokenSpec, bridge: BridgeSpec, chain: ChainSel): Hex | null {
  return addressOn(spec, emitterMap(bridge), chain);
}

function findBridge(spec: TokenSpec, bridgeId: string): BridgeSpec {
  const bridge = spec.bridges.find((b) => b.id === bridgeId);
  if (bridge === undefined) throw new EngineInputError(`spec ${spec.token} has no bridge "${bridgeId}"`);
  return bridge;
}

type DecodedArgs = Readonly<Record<string, unknown>>;

function decodeArgs(event: ParsedEvent, log: Log): DecodedArgs | null {
  if (log.topics[0]?.toLowerCase() !== event.selector) return null;
  try {
    const decoded = decodeEventLog({
      abi: [event.abi],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
    return decoded.args;
  } catch {
    // A log that matches the selector but not the ABI (e.g. a different contract
    // reusing the event name with other indexing) is not one of our debits or credits.
    return null;
  }
}

export function hexArg(args: DecodedArgs, name: string): Hex {
  const value = args[name];
  if (typeof value !== "string" || !value.startsWith("0x")) throw new EngineInputError(`event arg ${name} is not hex`);
  // Lowercase so decoded ids and addresses compare and index identically everywhere downstream.
  return value.toLowerCase() as Hex;
}

export function bigintArg(args: DecodedArgs, name: string): bigint {
  const value = args[name];
  if (typeof value !== "bigint") throw new EngineInputError(`event arg ${name} is not an integer`);
  return value;
}

export type EventAdapterOptions = {
  id: string;
  spec: TokenSpec;
  bridgeId: string;
  events: BridgeEvents;
};

/**
 * Generic adapter for bridges whose debit and credit are single events keyed by
 * a message id. It only decodes logs emitted by the spec's own bridge contract
 * on each chain, which is how Junction condition 2 (token identity) is enforced.
 */
export function createEventAdapter(options: EventAdapterOptions): BridgeAdapter {
  const { spec, bridgeId } = options;
  const bridge = findBridge(spec, bridgeId);
  const debit = parseBridgeEvent(options.events.debitEvent, options.events.debitFields);
  const credit = parseBridgeEvent(options.events.creditEvent, options.events.creditFields);
  const topicIndex = messageIdTopic(debit);
  if (messageIdTopic(credit) !== topicIndex) {
    throw new EngineInputError(`bridge ${bridgeId}: debit and credit must carry the message id in the same topic`);
  }

  const fromEmitter = (log: Log, chain: ChainSel): boolean =>
    emitterOn(spec, bridge, chain)?.toLowerCase() === log.address.toLowerCase();
  const topicsOn = (s: TokenSpec, chain: ChainSel, selector: Hex): Hex[] => {
    const b = s.bridges.find((x) => x.id === bridgeId);
    return b !== undefined && emitterOn(s, b, chain) !== null ? [selector] : [];
  };
  const recipientOf = (args: DecodedArgs, fields: EventFieldMap): { recipient?: Hex } =>
    fields.recipient === null ? {} : { recipient: hexArg(args, fields.recipient) };

  const adapter: BridgeAdapter = {
    id: options.id,
    messageIdTopicIndex: topicIndex,
    maxDeliverySeconds: bridge.maxDeliverySeconds,
    debitTopics: (s, chain) => topicsOn(s, chain, debit.selector),
    creditTopics: (s, chain) => topicsOn(s, chain, credit.selector),
    decodeDebit(log, chain): Debit | null {
      if (!fromEmitter(log, chain)) return null;
      const args = decodeArgs(debit, log);
      if (args === null) return null;
      return {
        messageId: hexArg(args, debit.fields.messageId),
        srcChain: chain,
        dstChain: bigintArg(args, debit.fields.remoteChain),
        amount: bigintArg(args, debit.fields.amount),
        ...recipientOf(args, debit.fields),
        txHash: log.transactionHash,
        block: log.blockNumber,
      };
    },
    decodeCredit(log, chain): Credit | null {
      if (!fromEmitter(log, chain)) return null;
      const args = decodeArgs(credit, log);
      if (args === null) return null;
      return {
        messageId: hexArg(args, credit.fields.messageId),
        claimedSrcChain: bigintArg(args, credit.fields.remoteChain),
        dstChain: chain,
        amount: bigintArg(args, credit.fields.amount),
        ...recipientOf(args, credit.fields),
        txHash: log.transactionHash,
        block: log.blockNumber,
      };
    },
    decodeTxDebits: (logs, chain) => logs.flatMap((l) => adapter.decodeDebit(l, chain) ?? []),
    decodeTxCredits: (logs, chain) => logs.flatMap((l) => adapter.decodeCredit(l, chain) ?? []),
  };
  return adapter;
}
