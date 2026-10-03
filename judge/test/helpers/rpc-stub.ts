/**
 * In-process JSON-RPC stub standing in for one RPC provider of one chain. It answers the exact
 * calls the Judge makes (eth_call against the ledger, quarantine and registry ABIs, eth_getLogs)
 * from a mutable state object, supports JSON-RPC batches, and can fail on demand.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, type Abi, type Hex } from "viem";
import { LEDGER_ABI, MULTICALL3, QUARANTINE_ABI, REGISTRY_ABI, TOPIC_CCIP_MESSAGE_SENT, TOPIC_LOCKED_OR_BURNED } from "../../src/abi.ts";

/** Widened on purpose: the stub chooses result shapes per function at runtime. */
const ABI: Abi = [...LEDGER_ABI, ...QUARANTINE_ABI, ...REGISTRY_ABI];
const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

export type LedgerState = {
  status: number;
  delta: bigint;
  updatedAt: bigint;
  stale: boolean;
  epochId: bigint;
  epochReason: number;
  activeIncident: Hex;
  breachReason: number;
};

export type StubLog = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
};

export type StubState = {
  ledgers: Map<string, LedgerState>;
  quarantines: Map<string, { frozen: boolean; tainted: Set<string> }>;
  registries: Map<string, Hex>;
  logs: StubLog[];
};

export type FailureMode = "none" | "rpc-error" | "http-500" | "hang";

export const ZERO32: Hex = `0x${"0".repeat(64)}`;

export function conservedLedger(overrides: Partial<LedgerState> = {}): LedgerState {
  return {
    status: 1,
    delta: 0n,
    updatedAt: 1_700_000_000n,
    stale: false,
    epochId: 4182n,
    epochReason: 0,
    activeIncident: ZERO32,
    breachReason: 0,
    ...overrides,
  };
}

type RpcRequest = { jsonrpc: "2.0"; id: number | string | null; method: string; params?: unknown[] };

export class RpcStub {
  state: StubState = { ledgers: new Map(), quarantines: new Map(), registries: new Map(), logs: [] };
  failure: FailureMode = "none";
  delayMs = 0;
  calls = 0;
  private server: Server | undefined;
  private port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.calls += 1;
        if (this.failure === "hang") return;
        const reply = (): void => {
          if (this.failure === "http-500") {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("upstream exploded");
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcRequest | RpcRequest[];
          const out = Array.isArray(body) ? body.map((r) => this.answer(r)) : this.answer(body);
          const payload = JSON.stringify(out);
          res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
          res.end(payload);
        };
        if (this.delayMs > 0) setTimeout(reply, this.delayMs);
        else reply();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(port, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  }

  private answer(req: RpcRequest): unknown {
    if (this.failure === "rpc-error") return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "stub provider failure" } };
    try {
      return { jsonrpc: "2.0", id: req.id, result: this.dispatch(req) };
    } catch (e) {
      return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } };
    }
  }

  private dispatch(req: RpcRequest): unknown {
    const params = req.params ?? [];
    switch (req.method) {
      case "eth_chainId":
        return "0x7a69";
      case "eth_blockNumber":
        return "0x100";
      case "eth_call": {
        const call = params[0] as { to: Hex; data: Hex };
        return this.call(call.to.toLowerCase(), call.data);
      }
      case "eth_getLogs":
        return this.getLogs(params[0] as { fromBlock: Hex; toBlock: Hex; address: Hex[]; topics: (Hex[] | Hex | null)[] });
      default:
        throw new Error(`method ${req.method} not supported by stub`);
    }
  }

  /** Multicall3.aggregate3 semantics: a failing inner call is (false, revert data) unless allowFailure is false. */
  private aggregate3(data: Hex): Hex {
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data });
    const results = args[0].map((c): { success: boolean; returnData: Hex } => {
      try {
        return { success: true, returnData: this.call(c.target.toLowerCase(), c.callData) };
      } catch (e) {
        if (!c.allowFailure) throw e;
        return { success: false, returnData: "0x" };
      }
    });
    return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", result: results });
  }

  private call(to: string, data: Hex): Hex {
    if (to === MULTICALL3.toLowerCase()) return this.aggregate3(data);
    const { functionName, args } = decodeFunctionData({ abi: ABI, data });
    const result = (value: unknown): Hex => encodeFunctionResult({ abi: ABI, functionName, result: value });
    switch (functionName) {
      case "statusOf": {
        const l = this.ledger(to);
        return result([l.status, l.delta, l.updatedAt, l.stale]);
      }
      case "latestEpoch": {
        const l = this.ledger(to);
        return result({ epochId: l.epochId, delta: l.delta, evaluatedAt: l.updatedAt, blocksHash: ZERO32, evidenceHash: ZERO32, status: l.status, reason: l.epochReason });
      }
      case "activeIncident":
        return result(this.ledger(to).activeIncident);
      case "breachOf": {
        const l = this.ledger(to);
        return result({
          tokenId: ZERO32,
          epochId: 0n,
          delta: l.delta,
          blocksHash: ZERO32,
          evidenceHash: ZERO32,
          reason: l.breachReason,
          offendingChain: 0n,
          offendingTx: ZERO32,
          recipient: "0x0000000000000000000000000000000000000000",
          amount: 0n,
          messageId: ZERO32,
          recordedAt: 1n,
        });
      }
      case "isFrozen":
        return result(this.quarantine(to).frozen);
      case "isTainted": {
        const account = String(args?.[1]).toLowerCase();
        return result(this.quarantine(to).tainted.has(account));
      }
      case "activeSpecHash": {
        const hash = this.state.registries.get(to);
        if (hash === undefined) throw new Error(`execution reverted: no registry at ${to}`);
        return result(hash);
      }
      default:
        throw new Error(`execution reverted: ${functionName} not supported by stub`);
    }
  }

  private ledger(address: string): LedgerState {
    const l = this.state.ledgers.get(address);
    if (l === undefined) throw new Error(`execution reverted: no ledger at ${address}`);
    return l;
  }

  private quarantine(address: string): { frozen: boolean; tainted: Set<string> } {
    const q = this.state.quarantines.get(address);
    if (q === undefined) throw new Error(`execution reverted: no quarantine at ${address}`);
    return q;
  }

  private getLogs(filter: { fromBlock: Hex; toBlock: Hex; address: Hex[]; topics: (Hex[] | Hex | null)[] }): unknown[] {
    const from = BigInt(filter.fromBlock);
    const to = BigInt(filter.toBlock);
    const addresses = new Set(filter.address.map((a) => a.toLowerCase()));
    const t0 = filter.topics[0];
    const topic0 = t0 === null || t0 === undefined ? null : new Set(Array.isArray(t0) ? t0 : [t0]);
    return this.state.logs
      .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
      .filter((l) => addresses.has(l.address.toLowerCase()))
      .filter((l) => topic0 === null || (l.topics[0] !== undefined && topic0.has(l.topics[0])))
      .map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: `0x${l.blockNumber.toString(16)}`,
        blockHash: `0x${"ab".repeat(32)}`,
        transactionHash: l.transactionHash,
        transactionIndex: "0x0",
        logIndex: `0x${l.logIndex.toString(16)}`,
        removed: false,
      }));
  }
}

function topicU64(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function topicAddress(address: Hex): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

/** The two logs a CCIP 2.0.0 send emits on the source chain: pool LockedOrBurned, then OnRamp CCIPMessageSent. */
export function ccipSendLogs(args: {
  pool: Hex;
  onRamp: Hex;
  token: Hex;
  sender: Hex;
  destSelector: bigint;
  messageId: Hex;
  amount: bigint;
  txHash: Hex;
  blockNumber: bigint;
  firstLogIndex?: number;
}): StubLog[] {
  const first = args.firstLogIndex ?? 3;
  return [
    {
      address: args.pool,
      topics: [TOPIC_LOCKED_OR_BURNED, topicU64(args.destSelector)],
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }],
        [args.token, args.onRamp, args.amount],
      ),
      blockNumber: args.blockNumber,
      transactionHash: args.txHash,
      logIndex: first,
    },
    {
      address: args.onRamp,
      topics: [TOPIC_CCIP_MESSAGE_SENT, topicU64(args.destSelector), topicAddress(args.sender), args.messageId],
      // Data is never decoded by the Judge; an empty tail keeps the stub honest about that.
      data: "0x",
      blockNumber: args.blockNumber,
      transactionHash: args.txHash,
      logIndex: first + 1,
    },
  ];
}
