import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { errorAbi } from "./abi.ts";
import { privateKey } from "./env.ts";
import { log } from "./events.ts";
import { txUrl, type ChainConfig } from "./networks.ts";

export type Signer = "DEPLOYER" | "ATTACKER" | "WEAKBRIDGE_VERIFIER" | "SAFE_SIGNER_1" | "SAFE_SIGNER_2" | "SAFE_SIGNER_3";

export function account(signer: Signer): Account {
  return privateKeyToAccount(privateKey(`${signer}_PRIVATE_KEY`));
}

export type Chain = { config: ChainConfig; client: PublicClient; local: boolean };

export function connect(config: ChainConfig): Chain {
  const chain = defineChain({
    id: config.chainId,
    name: config.label,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(config.rpcUrl, { retryCount: 3, timeout: 30_000 }) });
  return { config, client, local: config.explorer === null };
}

export class TxError extends Error {
  override readonly name = "TxError";
}

/**
 * Fee policy for small testnet budgets: priority tip is tiny (testnets include it fine), max fee is 1.5x the current
 * base fee, so a spike delays a transaction instead of overpaying for it.
 */
export async function fees(chain: Chain): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const block = await chain.client.getBlock({ blockTag: "latest" });
  const base = block.baseFeePerGas ?? (await chain.client.getGasPrice());
  const tip = chain.local ? 1_000_000_000n : 10_000_000n;
  return { maxFeePerGas: (base * 3n) / 2n + tip, maxPriorityFeePerGas: tip };
}

export type Call = { to: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint };

export type Sent = { hash: Hex; receipt: TransactionReceipt; url: string | null; costWei: bigint };

/** Decodes any revert into `ErrorName(args)` using every error in the compiled suite. */
export function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data !== undefined) {
      const args = (reverted.data.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a)));
      return `${reverted.data.errorName}(${args.join(", ")})`;
    }
    const raw = e.walk((err) => typeof (err as { data?: unknown }).data === "string") as { data?: Hex } | null;
    if (raw?.data !== undefined && raw.data.length >= 10) {
      try {
        const decoded = decodeErrorResult({ abi: errorAbi(), data: raw.data });
        const args = (decoded.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a)));
        return `${decoded.errorName}(${args.join(", ")})`;
      } catch {
        return `revert data ${raw.data.slice(0, 10)}`;
      }
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

const withErrors = (abi: Abi): Abi => [...abi, ...errorAbi()];

/** Simulates (decoded revert on failure), estimates, sends with the fee policy and waits for a successful receipt. */
export async function send(chain: Chain, from: Account, call: Call, label: string): Promise<Sent> {
  const abi = withErrors(call.abi);
  const data = encodeFunctionData({ abi, functionName: call.functionName, args: call.args ?? [] });
  try {
    await chain.client.call({ account: from, to: call.to, data, value: call.value ?? 0n });
  } catch (e) {
    throw new TxError(`${label} on ${chain.config.label} would revert: ${revertReason(e)}`);
  }
  return sendRaw(chain, from, { to: call.to, data, value: call.value ?? 0n }, label);
}

export async function sendRaw(
  chain: Chain,
  from: Account,
  tx: { to: Address | null; data: Hex; value?: bigint; gas?: bigint },
  label: string,
): Promise<Sent> {
  const wallet = createWalletClient({ account: from, chain: chain.client.chain, transport: http(chain.config.rpcUrl) });
  const gas =
    tx.gas ??
    ((await chain.client.estimateGas({ account: from, ...(tx.to === null ? {} : { to: tx.to }), data: tx.data, value: tx.value ?? 0n })) * 12n) / 10n;
  const fee = await fees(chain);
  const hash = await wallet.sendTransaction({
    account: from,
    chain: chain.client.chain,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gas,
    ...fee,
  });
  const receipt = await chain.client.waitForTransactionReceipt({ hash, timeout: 300_000 });
  const costWei = receipt.gasUsed * receipt.effectiveGasPrice;
  log(`${chain.config.label}: ${label} ${hash} gas=${receipt.gasUsed} cost=${formatEther(costWei)} ETH ${receipt.status}`);
  if (receipt.status !== "success" && tx.gas === undefined) throw new TxError(`${label} reverted onchain: ${hash}`);
  return { hash, receipt, url: txUrl(chain.config, hash), costWei };
}

export type Refusal = { reason: string; hash: Hex | null; url: string | null; costWei: bigint };

/**
 * A call that MUST revert. The reason comes from an eth_call; with `broadcast` the transaction is also sent with a
 * fixed gas limit so the refusal exists onchain as a failed transaction with an explorer link.
 * Throws if the call would succeed.
 */
export async function expectRevert(chain: Chain, from: Account, call: Call, label: string, broadcast: boolean, gas = 400_000n): Promise<Refusal> {
  const abi = withErrors(call.abi);
  const data = encodeFunctionData({ abi, functionName: call.functionName, args: call.args ?? [] });
  let reason: string | undefined;
  try {
    await chain.client.call({ account: from, to: call.to, data, value: call.value ?? 0n });
  } catch (e) {
    reason = revertReason(e);
  }
  if (reason === undefined) throw new TxError(`${label} on ${chain.config.label} did NOT revert; containment failed`);
  if (!broadcast) return { reason, hash: null, url: null, costWei: 0n };
  const sent = await sendRaw(chain, from, { to: call.to, data, value: call.value ?? 0n, gas }, `${label} (expected revert)`);
  if (sent.receipt.status === "success") throw new TxError(`${label} succeeded onchain; containment failed (${sent.hash})`);
  return { reason, hash: sent.hash, url: sent.url, costWei: sent.costWei };
}

export async function read<T>(chain: Chain, call: Omit<Call, "value">): Promise<T> {
  return (await chain.client.readContract({
    address: call.to,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args ?? [],
  })) as T;
}

export async function hasCode(chain: Chain, address: Address): Promise<boolean> {
  const code = await chain.client.getCode({ address });
  return code !== undefined && code !== "0x";
}

/** Tops `to` up to `target` wei from the deployer only when it is below `minimum`. */
export async function fundIfBelow(chain: Chain, to: Address, minimum: bigint, target: bigint, label: string): Promise<Sent | null> {
  const balance = await chain.client.getBalance({ address: to });
  if (balance >= minimum) return null;
  return sendRaw(chain, account("DEPLOYER"), { to, data: "0x", value: target - balance }, `fund ${label}`);
}
