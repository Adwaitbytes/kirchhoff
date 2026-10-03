import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAbi, type Abi, type AbiItem } from "viem";
import { CONTRACTS_ROOT } from "./env.ts";

/** Subsets of the frozen KIRCHHOFF ABIs (contracts/src) that the demo scripts call. */
export const ledgerAbi = parseAbi([
  "function statusOf(bytes32 tokenId) view returns (uint8 status, int256 delta, uint64 updatedAt, bool stale)",
  "function activeIncident(bytes32 tokenId) view returns (bytes32)",
  "function recoveryEndsAt(bytes32 tokenId) view returns (uint64)",
  "function stalenessSeconds(bytes32 tokenId) view returns (uint64)",
  "function revisionOf(bytes32 tokenId) view returns (uint64)",
  "struct Epoch { uint64 epochId; int256 delta; uint64 evaluatedAt; bytes32 blocksHash; bytes32 evidenceHash; uint8 status; uint16 reason; }",
  "function latestEpoch(bytes32 tokenId) view returns (Epoch)",
  "struct Breach { bytes32 tokenId; uint64 epochId; int256 delta; bytes32 blocksHash; bytes32 evidenceHash; uint16 reason; uint64 offendingChain; bytes32 offendingTx; address recipient; uint256 amount; bytes32 messageId; uint64 recordedAt; }",
  "function breachOf(bytes32 incidentId) view returns (Breach)",
  "function setStalenessSeconds(bytes32 tokenId, uint64 stalenessSeconds)",
  "event BreachRecorded(bytes32 indexed tokenId, uint16 reason, bytes32 evidenceHash, uint64 offendingChain, bytes32 offendingTx, address recipient, uint256 amount)",
  "event StatusChanged(bytes32 indexed tokenId, uint8 from, uint8 to, uint16 reason)",
]);

export const quarantineAbi = parseAbi([
  "function isFrozen(bytes32 tokenId) view returns (bool)",
  "function isTainted(bytes32 tokenId, address account) view returns (bool)",
  "function issuerOf(bytes32 tokenId) view returns (address)",
  "function recoveryTimelockOf(bytes32 tokenId) view returns (uint64)",
  "function resolve(bytes32 tokenId, bytes32 incidentId)",
  "function untaint(bytes32 tokenId, address[] accounts)",
  "function setRecoveryTimelock(bytes32 tokenId, uint64 recoveryTimelockSeconds)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export const kethAbi = parseAbi(["function mint(address to, uint256 amount)", "function owner() view returns (address)"]);

export const remoteKethAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

export const weakBridgeAbi = parseAbi([
  "function send(address to, uint256 amount, uint64 dstChain) returns (bytes32 id)",
  "function credit(bytes32 id, address to, uint256 amount, uint64 srcChain, bytes signature)",
  "function creditDigest(bytes32 id, address to, uint256 amount, uint64 srcChain) view returns (bytes32)",
  "function nonce() view returns (uint256)",
  "function debitOf(bytes32 id) view returns (uint256 amount, address recipient, uint64 dstChain, uint64 blockNumber)",
  "function creditOf(bytes32 id) view returns (uint256 amount, address recipient, uint64 srcChain, uint64 blockNumber)",
  "event Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)",
  "event Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain)",
]);

export const lendingAbi = parseAbi(["function borrow(uint256 amount)", "function deposit(uint256 amount)"]);

export const poolAbi = parseAbi([
  "function kirchhoffCheck(address sender, address receiver) view",
  "function getLockBox() view returns (address)",
  "function isSupportedChain(uint64 remoteChainSelector) view returns (bool)",
  "struct LockOrBurnInV1 { bytes receiver; uint64 remoteChainSelector; address originalSender; uint256 amount; address localToken; }",
  "struct LockOrBurnOutV1 { bytes destTokenAddress; bytes destPoolData; }",
  "function lockOrBurn(LockOrBurnInV1 lockOrBurnIn) returns (LockOrBurnOutV1)",
  "struct ReleaseOrMintInV1 { bytes originalSender; uint64 remoteChainSelector; address receiver; uint256 sourceDenominatedAmount; address localToken; bytes sourcePoolAddress; bytes sourcePoolData; bytes offchainTokenData; }",
  "struct ReleaseOrMintOutV1 { uint256 destinationAmount; }",
  "function releaseOrMint(ReleaseOrMintInV1 releaseOrMintIn) returns (ReleaseOrMintOutV1)",
]);

export const localRouterAbi = parseAbi([
  "function setOnRamp(uint64 destChainSelector, address onRamp)",
  "function setOffRamp(uint64 sourceChainSelector, address offRamp, bool allowed)",
  "function getOnRamp(uint64 destChainSelector) view returns (address)",
  "function isOffRamp(uint64 sourceChainSelector, address offRamp) view returns (bool)",
]);

export const routerAbi = parseAbi([
  "struct EVMTokenAmount { address token; uint256 amount; }",
  "struct EVM2AnyMessage { bytes receiver; bytes data; EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }",
  "function getFee(uint64 destinationChainSelector, EVM2AnyMessage message) view returns (uint256 fee)",
  "function ccipSend(uint64 destinationChainSelector, EVM2AnyMessage message) payable returns (bytes32)",
  "function isChainSupported(uint64 destChainSelector) view returns (bool)",
  "function getOnRamp(uint64 destChainSelector) view returns (address)",
  "event CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId, address feeToken, uint256 tokenAmountBeforeTokenPoolFees, bytes encodedMessage, (address issuer, uint32 destGasLimit, uint32 destBytesOverhead, uint256 feeTokenAmount, bytes extraArgs)[] receipts, bytes[] verifierBlobs)",
]);

export const mockForwarderAbi = parseAbi([
  "function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)",
  "event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)",
]);

export const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
  "event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash, uint256 payment)",
]);

export const safeFactoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "function proxyCreationCode() pure returns (bytes)",
  "event ProxyCreation(address indexed proxy, address singleton)",
]);

let errorAbiCache: Abi | undefined;

/**
 * Every custom error in the compiled suite (contracts/out), so a revert from any KIRCHHOFF, CCIP or OpenZeppelin
 * contract decodes to its name. Built from forge artifacts at runtime; `forge build` must have run.
 */
export function errorAbi(): Abi {
  if (errorAbiCache !== undefined) return errorAbiCache;
  const seen = new Map<string, AbiItem>();
  const out = join(CONTRACTS_ROOT, "out");
  for (const dir of readdirSync(out)) {
    const path = join(out, dir);
    if (!statSync(path).isDirectory() || dir === "build-info") continue;
    for (const file of readdirSync(path)) {
      if (!file.endsWith(".json")) continue;
      const artifact = JSON.parse(readFileSync(join(path, file), "utf8")) as { abi?: AbiItem[] };
      for (const item of artifact.abi ?? []) {
        if (item.type !== "error") continue;
        const key = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
        if (!seen.has(key)) seen.set(key, item);
      }
    }
  }
  errorAbiCache = [...seen.values()];
  return errorAbiCache;
}

/** Deployed (runtime) bytecode of a compiled contract, for anvil_setCode. */
export function deployedBytecode(sourceFile: string, contract: string): `0x${string}` {
  const artifact = JSON.parse(readFileSync(join(CONTRACTS_ROOT, "out", sourceFile, `${contract}.json`), "utf8")) as {
    deployedBytecode: { object: `0x${string}` };
  };
  return artifact.deployedBytecode.object;
}
