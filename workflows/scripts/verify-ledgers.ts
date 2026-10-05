/**
 * Reads a set of report transactions and the resulting ledger state on the public testnets (provider 2 RPCs, so
 * verification never shares provider 1's rate limit with the workflow run).
 *
 *   node scripts/verify-ledgers.ts <home tx> <arb tx> <base tx>
 */
import { join } from "node:path";
import { createPublicClient, http, keccak256, parseAbi, toHex, type Hex } from "viem";
import { loadEnv, required } from "./lib/env.ts";
import { readFileSync } from "node:fs";

const REPO = join(import.meta.dirname, "../..");
const env = loadEnv(join(REPO, ".env"));
const deployments = JSON.parse(readFileSync(join(REPO, "deployments/testnet.json"), "utf8")) as { chains: Record<string, { ledger: Hex }> };
const TOKEN_ID = keccak256(toHex("kETH"));
const REPORT_PROCESSED = "0x3617b009e9785c42daebadb6d3fb553243a4bf586d07ea72d65d80013ce116b5";
const LEDGER = parseAbi([
  "struct Epoch { uint64 epochId; int256 delta; uint64 evaluatedAt; bytes32 blocksHash; bytes32 evidenceHash; uint8 status; uint16 reason; }",
  "function statusOf(bytes32) view returns (uint8 status, int256 delta, uint64 updatedAt, bool stale)",
  "function latestEpoch(bytes32) view returns (Epoch)",
]);
const CHAINS = [
  { name: "ethereum-testnet-sepolia", rpc: required(env, "RPC_ETH_SEPOLIA_2"), explorer: "https://sepolia.etherscan.io/tx/" },
  { name: "ethereum-testnet-sepolia-arbitrum-1", rpc: required(env, "RPC_ARB_SEPOLIA_2"), explorer: "https://sepolia.arbiscan.io/tx/" },
  { name: "ethereum-testnet-sepolia-base-1", rpc: required(env, "RPC_BASE_SEPOLIA_2"), explorer: "https://sepolia.basescan.org/tx/" },
];

const txs = process.argv.slice(2) as Hex[];
for (const [i, chain] of CHAINS.entries()) {
  const client = createPublicClient({ transport: http(chain.rpc) });
  const ledger = deployments.chains[chain.name]?.ledger;
  if (ledger === undefined) throw new Error(`no ledger for ${chain.name}`);
  const tx = txs[i];
  if (tx !== undefined) {
    const r = await client.getTransactionReceipt({ hash: tx });
    const processed = r.logs.filter((l) => l.topics[0] === REPORT_PROCESSED).map((l) => BigInt(l.data) === 1n);
    process.stdout.write(
      `${chain.name}: ${chain.explorer}${tx} status=${r.status} block=${r.blockNumber} gasUsed=${r.gasUsed} gasPrice=${r.effectiveGasPrice} ReportProcessed.result=${processed.join(",")}\n`,
    );
  }
  const [status, delta, updatedAt, stale] = await client.readContract({ address: ledger, abi: LEDGER, functionName: "statusOf", args: [TOKEN_ID] });
  const epoch = await client.readContract({ address: ledger, abi: LEDGER, functionName: "latestEpoch", args: [TOKEN_ID] });
  process.stdout.write(
    `  ledger ${ledger}: status=${status} delta=${delta} updatedAt=${updatedAt} stale=${stale} latestEpoch=${epoch.epochId} reason=${epoch.reason} blocksHash=${epoch.blocksHash}\n`,
  );
}
