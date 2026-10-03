/**
 * Captures real CCIP 2.0 sends from Ethereum Sepolia into policy hook v1 request fixtures.
 *
 *   node scripts/capture-real.ts <txHash> [<txHash> ...]
 *
 * Reads the receipt through BOTH RPC_ETH_SEPOLIA_1 and RPC_ETH_SEPOLIA_2 (refuses on disagreement),
 * decodes the OnRamp 2.0.0 CCIPMessageSent and its MessageV1Codec payload, and builds the request
 * exactly as chainlink-ccv verifier/pkg/policy/contract.go NewEvaluateRequest does (addresses
 * left-padded to 32 bytes, decoded finality, summed receipt fees). finalized_block_number is the
 * Sepolia finalized head at capture time, because the verifier's value is not published onchain.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeAbiParameters, hexToBigInt, http, sliceHex, size, type Hex, type Log } from "viem";
import { TOPIC_CCIP_MESSAGE_SENT, TOPIC_LOCKED_OR_BURNED } from "../src/abi.ts";
import type { EvaluateRequest, Finality, TokenTransfer } from "../src/schema.ts";

const OUT = fileURLToPath(new URL("../test/fixtures/real/", import.meta.url));
const SEPOLIA_ONRAMP = "0x8dcf17f298c881a547d91ca4aa3c2ad7568c6777";

class Reader {
  private offset = 0;
  private readonly hex: Hex;
  constructor(hex: Hex) {
    this.hex = hex;
  }
  take(bytes: number): Hex {
    const out = sliceHex(this.hex, this.offset, this.offset + bytes, { strict: true });
    this.offset += bytes;
    return out;
  }
  uint(bytes: number): bigint {
    return hexToBigInt(this.take(bytes));
  }
  bytes(lengthBytes: 1 | 2): Hex {
    const length = Number(this.uint(lengthBytes));
    return length === 0 ? "0x" : this.take(length);
  }
  done(): boolean {
    return this.offset === size(this.hex);
  }
}

function padded(address: Hex): string {
  if (address === "0x") return "0x";
  const digits = address.slice(2).toLowerCase();
  return `0x${digits.padStart(Math.max(64, digits.length), "0")}`;
}

/** protocol/finality.go Requirement(): 0 finalized, 1..65535 block depth, 65536 safe, else finalized. */
function finality(raw: bigint): Finality {
  if (raw >= 1n && raw <= 65535n) return { mode: "blockDepth", block_depth: Number(raw), safe: false };
  if (raw === 65536n) return { mode: "finalized", block_depth: 0, safe: true };
  return { mode: "finalized", block_depth: 0, safe: false };
}

function decodeMessage(encoded: Hex) {
  const r = new Reader(encoded);
  const version = Number(r.uint(1));
  const sourceChainSelector = r.uint(8);
  const destChainSelector = r.uint(8);
  const messageNumber = r.uint(8);
  const executionGasLimit = Number(r.uint(4));
  const ccipReceiveGasLimit = Number(r.uint(4));
  const finalityRaw = r.uint(4);
  const ccvAndExecutorHash = r.take(32);
  const onRamp = r.bytes(1);
  const offRamp = r.bytes(1);
  const sender = r.bytes(1);
  const receiver = r.bytes(1);
  const destBlob = r.bytes(2);
  const tokenTransferBytes = r.bytes(2);
  const data = r.bytes(2);
  if (!r.done()) throw new Error("trailing bytes after MessageV1");
  let tokenTransfer: TokenTransfer | undefined;
  if (tokenTransferBytes !== "0x") {
    const t = new Reader(tokenTransferBytes);
    const ttVersion = Number(t.uint(1));
    const amount = t.uint(32);
    const sourcePool = t.bytes(1);
    const sourceToken = t.bytes(1);
    const destToken = t.bytes(1);
    const tokenReceiver = t.bytes(1);
    const extraData = t.bytes(2);
    if (!t.done()) throw new Error("trailing bytes after TokenTransferV1");
    tokenTransfer = {
      version: ttVersion,
      amount: amount.toString(),
      source_pool_address: padded(sourcePool),
      source_token_address: padded(sourceToken),
      dest_token_address: padded(destToken),
      token_receiver: padded(tokenReceiver),
      extra_data: extraData,
    };
  }
  return {
    version,
    sourceChainSelector,
    destChainSelector,
    messageNumber,
    executionGasLimit,
    ccipReceiveGasLimit,
    finalityRaw,
    ccvAndExecutorHash,
    onRamp,
    offRamp,
    sender,
    receiver,
    destBlob,
    data,
    tokenTransfer,
  };
}

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const txs = process.argv.slice(2) as Hex[];
  if (txs.length === 0) throw new Error("usage: capture-real.ts <txHash> ...");
  const clients = [env("RPC_ETH_SEPOLIA_1"), env("RPC_ETH_SEPOLIA_2")].map((url) => createPublicClient({ transport: http(url) }));
  const [p1, p2] = clients;
  if (p1 === undefined || p2 === undefined) throw new Error("two providers required");
  const finalized = await p1.getBlock({ blockTag: "finalized" });

  for (const hash of txs) {
    const [r1, r2] = await Promise.all([p1.getTransactionReceipt({ hash }), p2.getTransactionReceipt({ hash })]);
    const relevant = (logs: Log[]) =>
      logs
        .filter((l) => l.topics[0] === TOPIC_CCIP_MESSAGE_SENT || l.topics[0] === TOPIC_LOCKED_OR_BURNED)
        .map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex, blockNumber: l.blockNumber?.toString() }));
    const logs = relevant(r1.logs);
    if (JSON.stringify(logs) !== JSON.stringify(relevant(r2.logs))) throw new Error(`${hash}: providers disagree on receipt logs`);
    const sent = r1.logs.find((l) => l.address.toLowerCase() === SEPOLIA_ONRAMP && l.topics[0] === TOPIC_CCIP_MESSAGE_SENT);
    if (sent === undefined) throw new Error(`${hash}: no CCIPMessageSent from the Sepolia OnRamp`);
    const [feeToken, , encodedMessage, receipts] = decodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes" },
        { type: "tuple[]", components: [{ type: "address" }, { type: "uint32" }, { type: "uint32" }, { type: "uint256" }, { type: "bytes" }] },
        { type: "bytes[]" },
      ],
      sent.data,
    );
    const m = decodeMessage(encodedMessage);
    const messageId = sent.topics[3];
    if (messageId === undefined) throw new Error("no message id topic");
    const block = await p1.getBlock({ blockNumber: r1.blockNumber });
    const fee = receipts.reduce((sum, rec) => sum + rec[3], 0n);
    const request: EvaluateRequest = {
      schema_version: "v1",
      verifier_id: "kirchhoff-cell-1",
      message_id: messageId,
      source_tx_hash: hash,
      source_block_number: Number(r1.blockNumber),
      source_block_timestamp: new Date(Number(block.timestamp) * 1000).toISOString().replace(".000Z", "Z"),
      fee_token: padded(feeToken.toLowerCase() as Hex),
      fee_token_amount: fee.toString(),
      finalized_block_number: Number(finalized.number),
      block_depth: Math.max(0, Number(finalized.number) - Number(r1.blockNumber)),
      message: {
        version: m.version,
        source_chain_selector: m.sourceChainSelector.toString(),
        dest_chain_selector: m.destChainSelector.toString(),
        sequence_number: Number(m.messageNumber),
        on_ramp_address: padded(m.onRamp),
        off_ramp_address: padded(m.offRamp),
        sender: padded(m.sender),
        receiver: padded(m.receiver),
        data: m.data,
        dest_blob: m.destBlob,
        execution_gas_limit: m.executionGasLimit,
        ccip_receive_gas_limit: m.ccipReceiveGasLimit,
        finality: finality(m.finalityRaw),
        ccv_and_executor_hash: m.ccvAndExecutorHash,
        ...(m.tokenTransfer === undefined ? {} : { token_transfer: m.tokenTransfer }),
      },
    };
    const fixture = {
      source: {
        kind: "real",
        chain: "ethereum-testnet-sepolia",
        txHash: hash,
        explorer: `https://sepolia.etherscan.io/tx/${hash}`,
        ccipExplorer: `https://ccip.chain.link/#/side-drawer/msg/${messageId}`,
        capturedAt: new Date().toISOString(),
        providers: ["RPC_ETH_SEPOLIA_1", "RPC_ETH_SEPOLIA_2"],
        derivation: "chainlink-ccv verifier/pkg/policy/contract.go NewEvaluateRequest @ d7b7b63; finalized_block_number is the head at capture time",
      },
      logs,
      request,
    };
    const name = `sepolia-${hash.slice(2, 10)}.json`;
    writeFileSync(`${OUT}${name}`, `${JSON.stringify(fixture, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
    process.stdout.write(`${name} message ${messageId} -> ${m.destChainSelector.toString()} token=${m.tokenTransfer?.amount ?? "none"}\n`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
