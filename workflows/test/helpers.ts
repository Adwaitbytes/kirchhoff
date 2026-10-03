import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex, W1Config, W2Config, W3Config, W4Config } from "@kirchhoff/engine";
import { compileSpecDocuments } from "@kirchhoff/engine/spec";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import type { BlockHeader, BlockRef, ChainIo, ChainLog, LogQuery, WriteOutcome } from "../src/io.ts";
import { w1ConfigSchema, w2ConfigSchema, w3ConfigSchema, w4ConfigSchema } from "../src/config.ts";
import { MULTICALL3_ABI } from "../src/multicall.ts";
import { fromDeployRecords, type DeployRecord } from "../scripts/lib/deployments.ts";

export const HOME = "ethereum-testnet-sepolia";
export const ARB = "ethereum-testnet-sepolia-arbitrum-1";
export const BASE = "ethereum-testnet-sepolia-base-1";
export const SEL = { [HOME]: 16015286601757825753n, [ARB]: 3478487238524512106n, [BASE]: 10344971235874465080n } as const;

const a = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;

/** Addresses per chain: 0x..<chain digit><role digits>. */
export const ADDR = {
  home: { ledger: a(0x1a01), quarantine: a(0x1a02), feed: a(0x1a03), registry: a(0x1a04), token: a(0x1001), escrow: a(0x1002), lockbox: a(0x1003), pool: a(0x1004), bridge: a(0x1005), router: a(0x1006) },
  arb: { ledger: a(0x2a01), quarantine: a(0x2a02), feed: a(0x2a03), token: a(0x2001), pool: a(0x2004), bridge: a(0x2005), router: a(0x2006) },
  base: { ledger: a(0x3a01), quarantine: a(0x3a02), feed: a(0x3a03), token: a(0x3001), pool: a(0x3004), bridge: a(0x3005), router: a(0x3006) },
} as const;

export function deployRecords(): DeployRecord[] {
  return [
    {
      role: "home", chainId: 31337, chainSelector: SEL[HOME].toString(), tokenSymbol: "kETH",
      conservationLedger: ADDR.home.ledger, quarantineController: ADDR.home.quarantine, conservationFeed: ADDR.home.feed,
      ccipRouter: ADDR.home.router, kirchhoffTokenPool: ADDR.home.pool, weakBridge: ADDR.home.bridge,
      kirchhoffRegistry: ADDR.home.registry, kETH: ADDR.home.token, homeEscrowAdapter: ADDR.home.escrow, ccipLockBox: ADDR.home.lockbox,
    },
    {
      role: "remote", chainId: 31338, chainSelector: SEL[ARB].toString(), tokenSymbol: "kETH",
      conservationLedger: ADDR.arb.ledger, quarantineController: ADDR.arb.quarantine, conservationFeed: ADDR.arb.feed,
      ccipRouter: ADDR.arb.router, kirchhoffTokenPool: ADDR.arb.pool, weakBridge: ADDR.arb.bridge, remoteKETH: ADDR.arb.token,
    },
    {
      role: "remote", chainId: 31339, chainSelector: SEL[BASE].toString(), tokenSymbol: "kETH",
      conservationLedger: ADDR.base.ledger, quarantineController: ADDR.base.quarantine, conservationFeed: ADDR.base.feed,
      ccipRouter: ADDR.base.router, kirchhoffTokenPool: ADDR.base.pool, weakBridge: ADDR.base.bridge, remoteKETH: ADDR.base.token,
    },
  ];
}

export type Configs = { w1: W1Config; w2: W2Config; w3: W3Config; w4: W4Config };

/** Configs exactly as gen-config produces them: the engine compiler over engine/specs/kETH.yaml. */
export async function compiledConfigs(): Promise<Configs> {
  const spec = readFileSync(join(import.meta.dirname, "../../engine/specs/kETH.yaml"), "utf8");
  const result = await compileSpecDocuments(spec, JSON.stringify(fromDeployRecords("test", deployRecords())), "test");
  if (!result.ok) throw new Error(result.errors.join("\n"));
  const read = (name: string): unknown => JSON.parse(result.files[`${name}/config.test.json`] ?? "null");
  return {
    w1: w1ConfigSchema.parse(read("w1-junction")),
    w2: w2ConfigSchema.parse(read("w2-loop")),
    w3: w3ConfigSchema.parse(read("w3-responder")),
    w4: w4ConfigSchema.parse(read("w4-topology")),
  };
}

type CallHandler = (to: Hex, data: Hex, block: BlockRef) => Hex | undefined;

/**
 * Programmable ChainIo. Calls to Multicall3 are unpacked and each sub-call answered by the registered handlers,
 * exactly like the real aggregate3, so workflow code is exercised byte for byte.
 */
export class FakeChain implements ChainIo {
  readonly headers = new Map<string, { finalized: BlockHeader; latest: BlockHeader; byNumber: Map<bigint, BlockHeader> }>();
  readonly logsByChain = new Map<string, ChainLog[]>();
  readonly receipts = new Map<string, ChainLog[]>();
  readonly handlers = new Map<string, CallHandler[]>();
  readonly writes: { chain: string; receiver: Hex; payload: Hex }[] = [];
  readonly messages: string[] = [];
  failWritesOn = new Set<string>();

  setHead(chain: string, finalized: bigint, latest: bigint, timestamp = 1_000n): void {
    const h = (n: bigint): BlockHeader => ({ number: n, timestamp: timestamp + n, hash: `0x${n.toString(16).padStart(64, "0")}` });
    this.headers.set(chain, { finalized: h(finalized), latest: h(latest), byNumber: new Map() });
  }

  on(chain: string, handler: CallHandler): void {
    const list = this.handlers.get(chain) ?? [];
    list.push(handler);
    this.handlers.set(chain, list);
  }

  header(chain: string, block: BlockRef): BlockHeader {
    const h = this.headers.get(chain);
    if (h === undefined) throw new Error(`no headers for ${chain}`);
    if (block.tag === "latest") return h.latest;
    if (block.tag === "finalized") return h.finalized;
    return { number: block.number, timestamp: h.finalized.timestamp - h.finalized.number + block.number, hash: `0x${block.number.toString(16).padStart(64, "0")}` };
  }

  private answer(chain: string, to: Hex, data: Hex, block: BlockRef): Hex {
    for (const handler of this.handlers.get(chain) ?? []) {
      const out = handler(to, data, block);
      if (out !== undefined) return out;
    }
    throw new Error(`unhandled call on ${chain} to ${to} data ${data.slice(0, 10)}`);
  }

  call(chain: string, to: Hex, data: Hex, block: BlockRef): Hex {
    if (to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11") {
      const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data });
      const results = args[0].map((c): { success: boolean; returnData: Hex } => {
        try {
          return { success: true, returnData: this.answer(chain, c.target, c.callData, block) };
        } catch {
          return { success: false, returnData: "0x" };
        }
      });
      return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", result: results });
    }
    return this.answer(chain, to, data, block);
  }

  logs(chain: string, query: LogQuery): ChainLog[] {
    if (query.toBlock - query.fromBlock + 1n > 100n) throw new Error("filterLogs range above the CRE limit");
    return (this.logsByChain.get(chain) ?? []).filter((l) => {
      if (l.blockNumber < query.fromBlock || l.blockNumber > query.toBlock) return false;
      if (!query.addresses.some((x) => x.toLowerCase() === l.address.toLowerCase())) return false;
      return query.topics.every((slot, i) => slot.length === 0 || slot.some((t) => t.toLowerCase() === l.topics[i]?.toLowerCase()));
    });
  }

  receiptLogs(_chain: string, txHash: Hex): ChainLog[] {
    return this.receipts.get(txHash.toLowerCase()) ?? [];
  }

  writeReport(chain: string, receiver: Hex, payload: Hex): WriteOutcome {
    this.writes.push({ chain, receiver, payload });
    if (this.failWritesOn.has(chain)) return { ok: false, error: "receiver reverted" };
    return { ok: true, txHash: `0x${this.writes.length.toString(16).padStart(64, "0")}` };
  }

  log(message: string): void {
    this.messages.push(message);
  }
}

export const sameHex = (x: Hex, y: Hex): boolean => x.toLowerCase() === y.toLowerCase();
