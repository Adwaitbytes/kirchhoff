import { decodeEventLog, keccak256, parseAbi, stringToBytes, toEventSelector, type Abi, type AbiEvent, type AbiFunction, type Address, type Hex, type PublicClient } from "viem";
import { CHAINS, CHAIN_KEYS, bridgeAbi, chainBySelector, ccipAbi, erc20Abi, isChainKey, oftAbi, roleAbi, tokenAdminRegistryAbi, txUrl, addressUrl, type ChainKey, type CopilotTool } from "@kirchhoff/sdk";
import type { ToolDef } from "../provider.ts";
import type { ContractMeta, Explorer } from "./explorer.ts";

/**
 * The seven Spec Copilot tools of PRD section 11, exactly. All are read-only: they read chains and
 * explorers and run the deterministic engine. There is no tool that signs, proposes or writes.
 */

export type ToolOutcome = { ok: boolean; result: unknown; summary: string; href: string | null };

export type CopilotEnv = {
  clients: Partial<Record<ChainKey, PublicClient>>;
  explorer: Explorer;
  /** TokenAdminRegistry per chain when CCIP is live there (testnets); local Anvil has none. */
  tokenAdminRegistry: Partial<Record<ChainKey, Address>>;
  /** Live CCIP ramps per chain, from docs/research/ccip.md (testnets). */
  ramps: Partial<Record<ChainKey, { onRamp: Address; offRamp: Address }>>;
  validateSpec: (yaml: string) => Promise<{ ok: boolean; errors: string[]; warnings: string[] }>;
  backtestSpec: (yaml: string, fromBlock: bigint | null) => Promise<unknown>;
  /** Max blocks scanned backwards by log tools. */
  logLookback: bigint;
  explorerLinks: boolean;
};

export class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

const chainParam = { type: "string", enum: [...CHAIN_KEYS], description: "CRE chain name" } as const;
const addressParam = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } as const;

export const COPILOT_TOOL_DEFS: readonly (ToolDef & { name: CopilotTool })[] = [
  {
    name: "get_contract",
    description:
      "Bytecode hash, verified name and ABI events (Blockscout or Etherscan-family), ERC-20 metadata, address-typed public getters and EIP-1967 proxy implementation of a contract. For an EOA, lists the contracts it deployed on that chain.",
    parameters: { type: "object", additionalProperties: false, required: ["chain", "address"], properties: { chain: chainParam, address: addressParam } },
  },
  {
    name: "list_role_grants",
    description: "Every RoleGranted/RoleRevoked and minter/burner access change on a token, so hidden minters surface. Reports which grants are still active.",
    parameters: { type: "object", additionalProperties: false, required: ["chain", "token"], properties: { chain: chainParam, token: addressParam } },
  },
  {
    name: "list_ccip_pools",
    description:
      "The CCIP token pool registered for a token in the CCIP TokenAdminRegistry on a chain, with its lock box and OnRamp/OffRamp, and every remote lane the pool is configured for: remote chain, remote token, remote pools and that chain's ramps, cross-checked on the remote chain. Run it on the canonical token to discover the remotes.",
    parameters: { type: "object", additionalProperties: false, required: ["chain", "token"], properties: { chain: chainParam, token: addressParam } },
  },
  {
    name: "list_oft_peers",
    description: "Peers set on a LayerZero OFT (PeerSet events).",
    parameters: { type: "object", additionalProperties: false, required: ["chain", "oft"], properties: { chain: chainParam, oft: addressParam } },
  },
  {
    name: "sample_events",
    description: "Recent decoded events emitted by a contract for one topic0, to confirm debit and credit event signatures.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["chain", "address", "topic", "n"],
      properties: { chain: chainParam, address: addressParam, topic: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, n: { type: "integer", minimum: 1, maximum: 10 } },
    },
  },
  {
    name: "validate_spec",
    description: "Validates KIRCH-SPEC YAML: JSON Schema plus semantic checks (every remote has a minter, every minter maps to a bridge, every address has bytecode).",
    parameters: { type: "object", additionalProperties: false, required: ["yaml"], properties: { yaml: { type: "string", maxLength: 20_000 } } },
  },
  {
    name: "backtest_spec",
    description: "Runs the deterministic engine over the token's event history with this spec. Any BROKEN on real history blocks activation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["yaml", "from_block"],
      properties: { yaml: { type: "string", maxLength: 20_000 }, from_block: { type: ["integer", "null"], minimum: 0 } },
    },
  },
];

export const COPILOT_TOOL_NAMES: readonly CopilotTool[] = COPILOT_TOOL_DEFS.map((t) => t.name);

const ROLE_NAMES: Readonly<Record<string, string>> = {
  [keccak256(stringToBytes("MINTER_ROLE"))]: "MINTER_ROLE",
  [keccak256(stringToBytes("BURNER_ROLE"))]: "BURNER_ROLE",
  "0x0000000000000000000000000000000000000000000000000000000000000000": "DEFAULT_ADMIN_ROLE",
};
const ROLE_TOPICS: Hex[] = roleAbi.map((e) => toEventSelector(e));
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const typeAndVersionAbi = parseAbi(["function typeAndVersion() view returns (string)", "function getToken() view returns (address)"]);

function argChain(v: unknown): ChainKey {
  if (!isChainKey(v)) throw new ToolInputError(`chain must be one of ${CHAIN_KEYS.join(", ")}`);
  return v;
}
function argAddress(v: unknown, field: string): Address {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new ToolInputError(`${field} must be a 20-byte hex address`);
  return v.toLowerCase() as Address;
}

function client(env: CopilotEnv, chain: ChainKey): PublicClient {
  const c = env.clients[chain];
  if (!c) throw new ToolInputError(`no RPC configured for ${chain}`);
  return c;
}

type SimpleLog = { data: Hex; topics: [Hex, ...Hex[]] | []; blockNumber: bigint; transactionHash: Hex };

type RpcLog = { data: Hex; topics: Hex[]; blockNumber: Hex | null; transactionHash: Hex | null };

/** Longest history a log scan covers even when the contract is older (bounds RPC load). */
const MAX_HISTORY_BLOCKS = 5_000_000n;
const DEFAULT_LOG_STEP = 9_999n;

/** A smaller getLogs span after a range-limit error ("exceed maximum block range: 50000"), or null to give up. */
function smallerStep(err: unknown, step: bigint): bigint | null {
  const msg = err instanceof Error ? err.message : String(err);
  const limit = /(?:block range|range)[^0-9]{0,40}(\d{3,})/i.exec(msg)?.[1];
  if (limit !== undefined && BigInt(limit) - 1n < step) return BigInt(limit) - 1n;
  if (step > DEFAULT_LOG_STEP) return DEFAULT_LOG_STEP;
  if (step > 999n) return 999n;
  return null;
}

/**
 * Logs of `address` from `from` (its creation block when known, else head - lookback) to head.
 * Tries the whole span in one request, then narrows to the provider's range limit: role grants on a
 * remote token happen at deployment, often far outside any fixed recent window.
 */
async function chunkedLogs(c: PublicClient, address: Address, lookback: bigint, topics?: (Hex | Hex[] | null)[], createdAt: bigint | null = null): Promise<SimpleLog[]> {
  const head = await c.getBlockNumber();
  const windowFloor = head > lookback ? head - lookback : 0n;
  const historyFloor = head > MAX_HISTORY_BLOCKS ? head - MAX_HISTORY_BLOCKS : 0n;
  const floor = createdAt === null ? windowFloor : createdAt > historyFloor ? createdAt : historyFloor;
  const scan = async (step: bigint): Promise<SimpleLog[]> => {
    const out: SimpleLog[] = [];
    for (let to = head; to >= floor; to -= step + 1n) {
      const from = to - step > floor ? to - step : floor;
      const logs: RpcLog[] = await c.request({
        method: "eth_getLogs",
        params: [{ address, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, ...(topics ? { topics } : {}) }],
      });
      for (const l of logs) {
        if (l.blockNumber === null || l.transactionHash === null) continue;
        out.push({ data: l.data, topics: l.topics as SimpleLog["topics"], blockNumber: BigInt(l.blockNumber), transactionHash: l.transactionHash });
      }
      if (from === floor) break;
    }
    return out;
  };
  let step = head - floor;
  for (;;) {
    try {
      const out = await scan(step);
      return out.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
    } catch (e) {
      const next = smallerStep(e, step);
      if (next === null) throw e;
      step = next;
    }
  }
}

/** Creation block of a contract from the explorer's creation tx, confirmed by its onchain receipt. */
async function creationBlock(c: PublicClient, meta: ContractMeta | null): Promise<bigint | null> {
  if (!meta?.creationTx) return null;
  const receipt = await c.getTransactionReceipt({ hash: meta.creationTx }).catch(() => null);
  return receipt?.blockNumber ?? null;
}

const KNOWN_EVENT_ABI: Abi = [...bridgeAbi, ...ccipAbi, ...erc20Abi, ...roleAbi];

/** KIRCH-SPEC style event signature, e.g. `Burned(bytes32 indexed id, address indexed from, ...)`. */
export function signatureOf(e: AbiEvent): string {
  return `${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name ?? ""}`.trim()).join(", ")})`;
}

const link = (env: CopilotEnv, kind: "tx" | "address", chain: ChainKey, value: Hex): string | null =>
  env.explorerLinks ? (kind === "tx" ? txUrl(chain, value) : addressUrl(chain, value)) : null;

async function getContract(env: CopilotEnv, chain: ChainKey, address: Address): Promise<ToolOutcome> {
  const c = client(env, chain);
  const code = await c.getCode({ address });
  if (!code || code === "0x") {
    const deployed = await env.explorer.deployedBy(chain, address);
    return {
      ok: true,
      result: { chain, address, kind: "eoa", contractsDeployed: deployed },
      summary: `${address} is an EOA on ${CHAINS[chain].label}; it deployed ${deployed.length} contracts`,
      href: link(env, "address", chain, address),
    };
  }
  const meta = await env.explorer.contract(chain, address);
  const abi: Abi = meta?.abi ?? [];
  const events = abi.filter((x): x is AbiEvent => x.type === "event").map(signatureOf);
  const getters: Record<string, string> = {};
  const fns = abi.filter((x): x is AbiFunction => x.type === "function" && x.inputs.length === 0 && (x.stateMutability === "view" || x.stateMutability === "pure") && x.outputs.length === 1 && x.outputs[0]?.type === "address");
  for (const f of fns.slice(0, 12)) {
    const v: unknown = await c.readContract({ address, abi: [f], functionName: f.name }).catch(() => null);
    if (typeof v === "string") getters[f.name] = v.toLowerCase();
  }
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    c.readContract({ address, abi: erc20Abi, functionName: "name" }).catch(() => null),
    c.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
    c.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
    c.readContract({ address, abi: erc20Abi, functionName: "totalSupply" }).catch(() => null),
  ]);
  const implSlot = await c.getStorageAt({ address, slot: EIP1967_IMPL }).catch(() => null);
  const impl = implSlot && BigInt(implSlot) !== 0n ? (`0x${implSlot.slice(-40)}`) : null;
  const tv = await c.readContract({ address, abi: typeAndVersionAbi, functionName: "typeAndVersion" }).catch(() => null);
  // Deterministic evidence of what this contract DOES, not just what its ABI declares: events it
  // actually emitted, and ERC-20 balances it holds of tokens its getters point at (escrow holdings).
  const emitted = new Map<string, number>();
  for (const log of await chunkedLogs(c, address, env.logLookback).catch(() => [])) {
    const t0 = log.topics[0];
    if (t0 === undefined) continue;
    const ev = [...abi, ...KNOWN_EVENT_ABI].find((x): x is AbiEvent => x.type === "event" && toEventSelector(x) === t0);
    const sig = ev ? signatureOf(ev) : t0;
    emitted.set(sig, (emitted.get(sig) ?? 0) + 1);
  }
  const holdings: { token: string; getter: string; symbol: string; balance: string }[] = [];
  for (const [getter, tokenAddr] of Object.entries(getters)) {
    if (BigInt(tokenAddr) === 0n) continue;
    const sym = await c.readContract({ address: tokenAddr as Address, abi: erc20Abi, functionName: "symbol" }).catch(() => null);
    if (sym === null) continue;
    const bal = await c.readContract({ address: tokenAddr as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] }).catch(() => null);
    if (bal !== null) holdings.push({ token: tokenAddr, getter, symbol: sym, balance: bal.toString() });
  }
  return {
    ok: true,
    result: {
      chain,
      address,
      kind: "contract",
      codeSize: (code.length - 2) / 2,
      bytecodeHash: keccak256(code),
      verifiedName: meta?.name ?? null,
      verified: meta?.verified ?? false,
      explorer: meta?.source ?? null,
      typeAndVersion: tv,
      erc20: symbol !== null ? { name, symbol, decimals, totalSupply: totalSupply?.toString() ?? null } : null,
      addressGetters: getters,
      events: events.slice(0, 20),
      emittedEvents: [...emitted].map(([signature, count]) => ({ signature, count })).slice(0, 20),
      tokenHoldings: holdings,
      proxyImplementation: impl,
      deployer: meta?.creator ?? null,
      explorerComments: meta?.comments ?? null,
    },
    summary: `${meta?.name ?? "unverified contract"} at ${address} on ${CHAINS[chain].label}${symbol ? ` (${symbol})` : ""}`,
    href: link(env, "address", chain, address),
  };
}

async function listRoleGrants(env: CopilotEnv, chain: ChainKey, token: Address): Promise<ToolOutcome> {
  const c = client(env, chain);
  // Grants happen at deployment, usually far outside the recent window: scan from the token's creation,
  // filtered to access-control events so a busy token's Transfers do not flood the scan.
  const tokenMeta = await env.explorer.contract(chain, token).catch(() => null);
  const logs = await chunkedLogs(c, token, env.logLookback, [ROLE_TOPICS], await creationBlock(c, tokenMeta));
  const grants: { event: string; role: string | null; account: string; block: string; tx: string }[] = [];
  for (const log of logs) {
    try {
      const d = decodeEventLog({ abi: roleAbi, data: log.data, topics: log.topics });
      const args = d.args as Record<string, unknown>;
      const rawAccount = args.account ?? args.minter ?? args.burner;
      const account = typeof rawAccount === "string" ? rawAccount.toLowerCase() : "";
      const role = typeof args.role === "string" ? (ROLE_NAMES[args.role] ?? args.role) : null;
      grants.push({ event: d.eventName, role, account, block: log.blockNumber.toString(), tx: log.transactionHash });
    } catch {
      // Not a role event (Transfer, Approval, ...).
    }
  }
  const active = new Map<string, Set<string>>();
  for (const g of grants) {
    const key = g.account;
    const set = active.get(key) ?? new Set<string>();
    const cap = g.event.startsWith("Mint") || g.role === "MINTER_ROLE" ? "mint" : g.event.startsWith("Burn") || g.role === "BURNER_ROLE" ? "burn" : (g.role ?? g.event);
    if (g.event.includes('Granted')) set.add(cap);
    else set.delete(cap);
    active.set(key, set);
  }
  const holders: { account: string; capabilities: string[]; name: string | null }[] = [];
  for (const [account, caps] of active) {
    if (caps.size === 0) continue;
    const meta = await env.explorer.contract(chain, account as Address).catch(() => null);
    holders.push({ account, capabilities: [...caps].sort(), name: meta?.name ?? null });
  }
  const minters = holders.filter((h) => h.capabilities.includes("mint"));
  return {
    ok: true,
    result: { chain, token, activeHolders: holders, history: grants.slice(-30) },
    summary: `${minters.length} active minters on ${CHAINS[chain].label}`,
    href: link(env, "address", chain, token),
  };
}

/** CCIP TokenPool 2.0.0 remote configuration (docs/research/ccip.md); getRemotePool is the 1.5.0 fallback. */
const poolAbi = parseAbi([
  "function getToken() view returns (address)",
  "function getSupportedChains() view returns (uint64[])",
  "function getRemotePools(uint64 remoteChainSelector) view returns (bytes[])",
  "function getRemotePool(uint64 remoteChainSelector) view returns (bytes)",
  "function getRemoteToken(uint64 remoteChainSelector) view returns (bytes)",
  "function getLockBox() view returns (address)",
]);

/** An abi-encoded EVM address (32 bytes, left-padded) or a raw 20-byte one; anything else is a non-EVM remote. */
export function evmAddressFromBytes(b: Hex): Address | null {
  const hex = b.slice(2);
  if (hex.length === 40) return `0x${hex}`.toLowerCase() as Address;
  if (hex.length === 64 && /^0{24}/.test(hex)) return `0x${hex.slice(24)}`.toLowerCase() as Address;
  return null;
}

type RemoteLane = {
  chainSelector: string;
  chain: ChainKey | null;
  remoteToken: Address | null;
  remotePools: Address[];
  onRamp: Address | null;
  offRamp: Address | null;
  remoteTokenMeta: { symbol: string | null; decimals: number | null } | null;
  /** What the remote side says about itself, read on the remote chain. */
  remoteCheck: { registryPool: Address | null; poolToken: Address | null; poolPointsBack: boolean | null; consistent: boolean } | null;
};

const lower = (v: unknown): Address | null => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v.toLowerCase() as Address) : null);

async function registeredPool(env: CopilotEnv, c: PublicClient, chain: ChainKey, token: Address): Promise<Address | null> {
  const registry = env.tokenAdminRegistry[chain];
  if (!registry) return null;
  const p = await c.readContract({ address: registry, abi: tokenAdminRegistryAbi, functionName: "getPool", args: [token] });
  return BigInt(p) === 0n ? null : (p.toLowerCase() as Address);
}

async function remoteLane(env: CopilotEnv, c: PublicClient, pool: Address, localChain: ChainKey, token: Address, selector: bigint): Promise<RemoteLane> {
  const remoteChain = chainBySelector(selector)?.key ?? null;
  const tokenBytes = await c.readContract({ address: pool, abi: poolAbi, functionName: "getRemoteToken", args: [selector] }).catch(() => null);
  let poolBytes: readonly Hex[] = await c.readContract({ address: pool, abi: poolAbi, functionName: "getRemotePools", args: [selector] }).catch(() => []);
  if (poolBytes.length === 0) {
    const single = await c.readContract({ address: pool, abi: poolAbi, functionName: "getRemotePool", args: [selector] }).catch(() => null);
    if (single) poolBytes = [single];
  }
  const remoteToken = tokenBytes ? evmAddressFromBytes(tokenBytes) : null;
  const remotePools = poolBytes.map(evmAddressFromBytes).filter((x): x is Address => x !== null);
  const ramps = remoteChain ? (env.ramps[remoteChain] ?? null) : null;
  const lane: RemoteLane = {
    chainSelector: selector.toString(),
    chain: remoteChain,
    remoteToken,
    remotePools,
    onRamp: lower(ramps?.onRamp),
    offRamp: lower(ramps?.offRamp),
    remoteTokenMeta: null,
    remoteCheck: null,
  };
  const rc = remoteChain ? env.clients[remoteChain] : undefined;
  if (!rc || !remoteChain || !remoteToken) return lane;
  // Cross-check on the remote chain: the lane is only trustworthy when both ends agree.
  const [symbol, decimals, registryPool] = await Promise.all([
    rc.readContract({ address: remoteToken, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
    rc.readContract({ address: remoteToken, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
    registeredPool(env, rc, remoteChain, remoteToken).catch(() => null),
  ]);
  lane.remoteTokenMeta = { symbol, decimals };
  const remotePool = registryPool ?? remotePools[0] ?? null;
  const poolToken = remotePool ? lower(await rc.readContract({ address: remotePool, abi: poolAbi, functionName: "getToken" }).catch(() => null)) : null;
  const back = remotePool ? await rc.readContract({ address: remotePool, abi: poolAbi, functionName: "getRemoteToken", args: [CHAINS[localChain].selector] }).catch(() => null) : null;
  const poolPointsBack = back === null ? null : evmAddressFromBytes(back) === token;
  lane.remoteCheck = {
    registryPool,
    poolToken,
    poolPointsBack,
    consistent: poolToken === remoteToken && poolPointsBack === true && (registryPool === null || remotePools.includes(registryPool)),
  };
  return lane;
}

async function listCcipPools(env: CopilotEnv, chain: ChainKey, token: Address): Promise<ToolOutcome> {
  const c = client(env, chain);
  let pool: Address | null = null;
  let via = "TokenAdminRegistry";
  const registry = env.tokenAdminRegistry[chain] ?? null;
  if (registry) {
    pool = await registeredPool(env, c, chain, token);
  } else {
    // No registry on this chain (local Anvil): find pools among the token deployer's contracts whose getToken() is the token.
    via = "deployer contracts (no TokenAdminRegistry on this chain)";
    const meta = await env.explorer.contract(chain, token);
    const deployed = meta?.creator ? await env.explorer.deployedBy(chain, meta.creator) : [];
    for (const d of deployed) {
      const t = await c.readContract({ address: d.address, abi: typeAndVersionAbi, functionName: "getToken" }).catch(() => null);
      if (typeof t === "string" && t.toLowerCase() === token) {
        pool = d.address;
        break;
      }
    }
  }
  const ramps = env.ramps[chain] ?? null;
  const base = { chain, token, registry, lookup: via, onRamp: lower(ramps?.onRamp), offRamp: lower(ramps?.offRamp) };
  if (!pool) {
    return { ok: true, result: { ...base, pool: null, remotes: [] }, summary: `no CCIP pool registered for this token on ${CHAINS[chain].label}`, href: null };
  }
  const [tv, lockBox, selectors] = await Promise.all([
    c.readContract({ address: pool, abi: typeAndVersionAbi, functionName: "typeAndVersion" }).catch(() => null),
    c.readContract({ address: pool, abi: poolAbi, functionName: "getLockBox" }).catch(() => null),
    c.readContract({ address: pool, abi: poolAbi, functionName: "getSupportedChains" }).catch(() => [] as readonly bigint[]),
  ]);
  const remotes = await Promise.all(selectors.map((sel) => remoteLane(env, c, pool, chain, token, sel)));
  const known = remotes.filter((r) => r.chain !== null);
  return {
    ok: true,
    result: { ...base, pool, poolTypeAndVersion: tv, lockBox: lower(lockBox), remotes },
    summary: `CCIP pool ${pool} on ${CHAINS[chain].label}; ${remotes.length} remote lane${remotes.length === 1 ? "" : "s"}${known.length > 0 ? ` (${known.map((r) => (r.chain ? CHAINS[r.chain].label : r.chainSelector)).join(", ")})` : ""}`,
    href: link(env, "address", chain, pool),
  };
}

async function listOftPeers(env: CopilotEnv, chain: ChainKey, oft: Address): Promise<ToolOutcome> {
  const c = client(env, chain);
  const meta = await env.explorer.contract(chain, oft).catch(() => null);
  const logs = await chunkedLogs(c, oft, env.logLookback, [toEventSelector("PeerSet(uint32,bytes32)")], await creationBlock(c, meta));
  const peers = new Map<number, string>();
  for (const log of logs) {
    try {
      const d = decodeEventLog({ abi: oftAbi, data: log.data, topics: log.topics });
      const a = d.args;
      peers.set(a.eid, a.peer);
    } catch {
      // ignore undecodable logs
    }
  }
  const list = [...peers].map(([eid, peer]) => ({ eid, peer }));
  return { ok: true, result: { chain, oft, peers: list }, summary: `${list.length} OFT peers on ${CHAINS[chain].label}`, href: link(env, "address", chain, oft) };
}


async function sampleEvents(env: CopilotEnv, chain: ChainKey, address: Address, topic: Hex, n: number): Promise<ToolOutcome> {
  const c = client(env, chain);
  const meta = await env.explorer.contract(chain, address).catch(() => null);
  const abi: Abi = [...(meta?.abi ?? []), ...KNOWN_EVENT_ABI];
  const logs = (await chunkedLogs(c, address, env.logLookback, [topic])).slice(-n);
  const events = logs.map((log) => {
    try {
      const d = decodeEventLog({ abi, data: log.data, topics: log.topics });
      const name = d.eventName as string | undefined;
      const ev = abi.find((x): x is AbiEvent => x.type === "event" && x.name === name);
      const signature = ev ? signatureOf(ev) : d.eventName;
      return { signature, args: d.args as unknown, tx: log.transactionHash, block: log.blockNumber.toString() };
    } catch {
      return { signature: null, topics: log.topics, tx: log.transactionHash, block: log.blockNumber.toString() };
    }
  });
  return { ok: true, result: { chain, address, topic, events }, summary: `${events.length} events sampled on ${CHAINS[chain].label}`, href: link(env, "address", chain, address) };
}

/** Executes one tool call. Input is untrusted model output: validated here, and failures are returned as data. */
export async function runCopilotTool(env: CopilotEnv, name: string, rawArgs: string): Promise<ToolOutcome> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArgs || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ToolInputError("arguments must be an object");
    args = parsed as Record<string, unknown>;
  } catch (e) {
    return { ok: false, result: { error: e instanceof Error ? e.message : "invalid JSON arguments" }, summary: "invalid arguments", href: null };
  }
  try {
    switch (name) {
      case "get_contract":
        return await getContract(env, argChain(args.chain), argAddress(args.address, "address"));
      case "list_role_grants":
        return await listRoleGrants(env, argChain(args.chain), argAddress(args.token, "token"));
      case "list_ccip_pools":
        return await listCcipPools(env, argChain(args.chain), argAddress(args.token, "token"));
      case "list_oft_peers":
        return await listOftPeers(env, argChain(args.chain), argAddress(args.oft, "oft"));
      case "sample_events": {
        const topic = typeof args.topic === "string" && /^0x[0-9a-fA-F]{64}$/.test(args.topic) ? (args.topic.toLowerCase() as Hex) : null;
        if (!topic) throw new ToolInputError("topic must be a bytes32 topic0");
        const n = typeof args.n === "number" && Number.isInteger(args.n) ? Math.min(10, Math.max(1, args.n)) : 5;
        return await sampleEvents(env, argChain(args.chain), argAddress(args.address, "address"), topic, n);
      }
      case "validate_spec": {
        if (typeof args.yaml !== "string" || args.yaml.length > 20_000) throw new ToolInputError("yaml must be a string under 20000 characters");
        const v = await env.validateSpec(args.yaml);
        return { ok: true, result: v, summary: v.ok ? "spec valid" : `${v.errors.length} validation errors`, href: null };
      }
      case "backtest_spec": {
        if (typeof args.yaml !== "string" || args.yaml.length > 20_000) throw new ToolInputError("yaml must be a string under 20000 characters");
        const from = typeof args.from_block === "number" && Number.isSafeInteger(args.from_block) && args.from_block >= 0 ? BigInt(args.from_block) : null;
        const r = await env.backtestSpec(args.yaml, from);
        const ok = typeof r === "object" && r !== null && (r as { ok?: unknown }).ok === true;
        return { ok: true, result: r, summary: ok ? "backtest clean: no BROKEN on history" : "backtest found breaches or failed", href: null };
      }
      default:
        // Principle 4: there are no other tools. Requests for anything else are refused as data.
        return { ok: false, result: { error: `unknown tool "${name.slice(0, 64)}": only ${COPILOT_TOOL_NAMES.join(", ")} exist, all read-only` }, summary: "refused unknown tool", href: null };
    }
  } catch (e) {
    const msg = e instanceof ToolInputError ? e.message : `tool failed: ${(e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200)}`;
    return { ok: false, result: { error: msg }, summary: msg, href: null };
  }
}
