import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  concat,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  keccak256,
  pad,
  parseEventLogs,
  stringToBytes,
  toHex,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { safeAbi, safeFactoryAbi } from "./abi.ts";
import { account, hasCode, read, send, TxError, type Call, type Chain, type Sent, type Signer } from "./chain.ts";
import { DEMO_ROOT } from "./env.ts";
import { log } from "./events.ts";

/**
 * Safe v1.4.1 canonical deployments (safe-global/safe-deployments). Checked onchain 2026-10-04: identical code on
 * Ethereum Sepolia, Arbitrum Sepolia and Base Sepolia, `VERSION()` = "1.4.1" (fixtures/safe-v1.4.1.json).
 */
export const SAFE = {
  factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  singletonL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
} as const satisfies Record<string, Address>;

/** Same salt and initializer on every chain, so the issuer Safe has one address on all three. */
export const SAFE_SALT_NONCE = BigInt(keccak256(stringToBytes("KIRCHHOFF issuer Safe (testnet simulation) v1")));

export const SAFE_OWNERS: readonly Signer[] = ["SAFE_SIGNER_1", "SAFE_SIGNER_2", "SAFE_SIGNER_3"];
export const SAFE_THRESHOLD = 2;
/** The two owners that co-sign every demo Safe transaction (2-of-3). */
export const SAFE_COSIGNERS: readonly Signer[] = ["SAFE_SIGNER_1", "SAFE_SIGNER_2"];

type Fixture = Record<"SafeProxyFactory" | "SafeL2" | "CompatibilityFallbackHandler", { address: Address; code: Hex }>;

/** On Anvil the canonical Safe contracts are installed from their verified testnet bytecode (same addresses). */
export async function installSafeOnAnvil(chain: Chain): Promise<void> {
  const fixture = JSON.parse(readFileSync(join(DEMO_ROOT, "fixtures", "safe-v1.4.1.json"), "utf8")) as Fixture;
  for (const item of [fixture.SafeProxyFactory, fixture.SafeL2, fixture.CompatibilityFallbackHandler]) {
    if (await hasCode(chain, item.address)) continue;
    await chain.client.request({ method: "anvil_setCode" as never, params: [item.address, item.code] as never });
  }
}

export function safeInitializer(owners: readonly Address[]): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [owners, BigInt(SAFE_THRESHOLD), "0x0000000000000000000000000000000000000000", "0x", SAFE.fallbackHandler, "0x0000000000000000000000000000000000000000", 0n, "0x0000000000000000000000000000000000000000"],
  });
}

/** CREATE2 address SafeProxyFactory 1.4.1 `createProxyWithNonce` yields for this initializer and salt. */
export function predictSafe(proxyCreationCode: Hex, initializer: Hex, saltNonce: bigint): Address {
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(initializer), saltNonce]));
  const initCode = concat([proxyCreationCode, pad(SAFE.singletonL2, { size: 32 })]);
  return getContractAddress({ opcode: "CREATE2", from: SAFE.factory, salt, bytecode: initCode });
}

export function ownerAddresses(): Address[] {
  return SAFE_OWNERS.map((s) => account(s).address);
}

/** Deploys the 2-of-3 issuer Safe if it is not there yet and checks its owners and threshold either way. */
export async function ensureSafe(chain: Chain): Promise<{ address: Address; sent: Sent | null }> {
  for (const [name, address] of Object.entries(SAFE)) {
    if (!(await hasCode(chain, address))) throw new TxError(`Safe ${name} ${address} has no code on ${chain.config.label}`);
  }
  const owners = ownerAddresses();
  const initializer = safeInitializer(owners);
  const creationCode = await read<Hex>(chain, { to: SAFE.factory, abi: safeFactoryAbi, functionName: "proxyCreationCode" });
  const address = predictSafe(creationCode, initializer, SAFE_SALT_NONCE);
  let sent: Sent | null = null;
  if (!(await hasCode(chain, address))) {
    sent = await send(
      chain,
      account("DEPLOYER"),
      { to: SAFE.factory, abi: safeFactoryAbi, functionName: "createProxyWithNonce", args: [SAFE.singletonL2, initializer, SAFE_SALT_NONCE] },
      "deploy issuer Safe (2-of-3)",
    );
    const created = parseEventLogs({ abi: safeFactoryAbi, logs: sent.receipt.logs, eventName: "ProxyCreation" })[0];
    if (created === undefined || getAddress(created.args.proxy) !== address) throw new TxError("Safe proxy address differs from prediction");
  }
  const onchainOwners = await read<readonly Address[]>(chain, { to: address, abi: safeAbi, functionName: "getOwners" });
  const threshold = await read<bigint>(chain, { to: address, abi: safeAbi, functionName: "getThreshold" });
  const expected = owners.map((o) => o.toLowerCase()).sort();
  const actual = onchainOwners.map((o) => o.toLowerCase()).sort();
  if (threshold !== BigInt(SAFE_THRESHOLD) || expected.join() !== actual.join()) {
    throw new TxError(`Safe ${address} on ${chain.config.label} is not the expected 2-of-3`);
  }
  return { address, sent };
}

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** Safe signatures must be sorted by signer address, ascending, each r||s||v (v 27/28 for EOA ECDSA). */
export function packSignatures(signed: readonly { signer: Address; signature: Hex }[]): Hex {
  const sorted = [...signed].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  return concat(sorted.map((s) => s.signature));
}

/**
 * Executes one Safe transaction with 2-of-3 owner signatures (EIP-712, signed offchain by SAFE_SIGNER_1 and _2).
 * The deployer relays it, so the owners need no gas. safeTxGas = 0 makes an inner revert revert the whole call.
 */
export async function execSafe(chain: Chain, safe: Address, call: Call, label: string, relayer: Account = account("DEPLOYER")): Promise<Sent> {
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] });
  const nonce = await read<bigint>(chain, { to: safe, abi: safeAbi, functionName: "nonce" });
  const message = {
    to: call.to,
    value: call.value ?? 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce,
  } as const;
  const onchainHash = await read<Hex>(chain, {
    to: safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [message.to, message.value, message.data, message.operation, 0n, 0n, 0n, ZERO, ZERO, nonce],
  });
  const signed = await Promise.all(
    SAFE_COSIGNERS.map(async (s) => {
      const signer = account(s);
      if (signer.signTypedData === undefined) throw new TxError(`${s} cannot sign typed data`);
      const signature = await signer.signTypedData({
        domain: { chainId: chain.config.chainId, verifyingContract: safe },
        types: SAFE_TX_TYPES,
        primaryType: "SafeTx",
        message,
      });
      return { signer: signer.address, signature };
    }),
  );
  log(`${chain.config.label}: Safe tx ${onchainHash} (nonce ${nonce}) signed by ${SAFE_COSIGNERS.join(" + ")}`);
  const sent = await send(
    chain,
    relayer,
    {
      to: safe,
      abi: safeAbi,
      functionName: "execTransaction",
      args: [message.to, message.value, message.data, message.operation, 0n, 0n, 0n, ZERO, ZERO, packSignatures(signed)],
    },
    `Safe 2-of-3: ${label}`,
  );
  const ok = parseEventLogs({ abi: safeAbi, logs: sent.receipt.logs, eventName: "ExecutionSuccess" }).some((l) => l.args.txHash === onchainHash);
  if (!ok) throw new TxError(`Safe tx ${onchainHash} did not emit ExecutionSuccess`);
  return sent;
}

export const safeSaltHex = (): Hex => toHex(SAFE_SALT_NONCE, { size: 32 });
