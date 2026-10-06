import { blocksHash, Reason, ReportType, Status, type Hex, type PinnedBlock, type W4Config } from "@kirchhoff/engine";
import { decodeAbiParameters, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, stringToHex } from "viem";
import { ACCESS_CONTROL_ABI, LEDGER_ABI } from "./abi.ts";
import { CRE_LOG_QUERY_BLOCK_LIMIT, logWindow } from "./budget.ts";
import { ledgerTargets, sameAddress, statusLabel } from "./chains.ts";
import type { ChainIo, ChainLog } from "./io.ts";
import { decodeAggregate3, encodeAggregate3, successful, type Call, type CallResult } from "./multicall.ts";
import { writeToLedgers, type WriteResult } from "./reports.ts";

type TopologyChain = W4Config["chains"][number];

/**
 * 100-block RoleGranted windows scanned per remote chain on the cron / SpecActivated path. Budget with two remotes
 * and three chains: 2 latest headers + 2 x 3 filterLogs + 3 state Multicall3 + 3 pool-peer Multicall3 = 14 of 15. Grants older than the windows are caught by the per-chain RoleGranted triggers when they happen, and
 * pool / peer drift is read from current state, so it has no window at all.
 */
export const W4_WINDOWS_PER_CHAIN = 3;

export const TOPOLOGY_ABI = parseAbi([
  "function getPool(address token) view returns (address)",
  "function getSupportedChains() view returns (uint64[])",
  "function getRemotePools(uint64 remoteChainSelector) view returns (bytes[])",
  "function activeSpecHash(bytes32 tokenId) view returns (bytes32)",
  "event PoolSet(address indexed token, address indexed previousPool, address indexed newPool)",
]);

const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";
const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;

/** Chains whose token has mint roles to watch: every remote (the home canonical token is Ownable, not roles). */
export function watchedChains(config: W4Config): TopologyChain[] {
  return config.chains.filter((c) => !c.isHome);
}

/** Chains with a CCIP TokenAdminRegistry, in config order: the `PoolSet` triggers. */
export function poolSetChains(config: W4Config): (TopologyChain & { tokenAdminRegistry: Hex })[] {
  return config.chains.flatMap((c) => (c.tokenAdminRegistry === null ? [] : [{ ...c, tokenAdminRegistry: c.tokenAdminRegistry }]));
}

export type Finding =
  | { kind: "minter"; chain: TopologyChain; account: Hex }
  | { kind: "pool"; chain: TopologyChain; pool: Hex; expected: readonly Hex[] }
  | { kind: "peer"; chain: TopologyChain; detail: string }
  | { kind: "spec"; active: Hex; running: Hex };

export function describe(f: Finding): string {
  switch (f.kind) {
    case "minter":
      return `${f.chain.name}: ${f.account} holds MINTER_ROLE but is not a spec minter`;
    case "pool":
      return `${f.chain.name}: CCIP TokenAdminRegistry pool ${f.pool} is not the spec pool (${f.expected.join(", ") || "none"})`;
    case "peer":
      return `${f.chain.name}: ${f.detail}`;
    case "spec":
      return f.active === ZERO_HASH
        ? `registry has no active spec; workflows run ${f.running}`
        : `active spec ${f.active} differs from the spec the workflows run (${f.running})`;
  }
}

function topicAddress(topic: Hex | undefined): Hex | null {
  if (topic === undefined) return null;
  return `0x${topic.slice(-40)}`.toLowerCase() as Hex;
}

/** Accounts granted the minter role in the scanned logs. */
export function grantedMinters(config: W4Config, logs: readonly ChainLog[]): Hex[] {
  const out = new Map<string, Hex>();
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== config.roleGrantedTopic0.toLowerCase()) continue;
    if (log.topics[1]?.toLowerCase() !== config.minterRole.toLowerCase()) continue;
    const account = topicAddress(log.topics[2]);
    if (account !== null) out.set(account, account);
  }
  return [...out.values()];
}

export function unlisted(chain: TopologyChain, accounts: readonly Hex[]): Hex[] {
  return accounts.filter((a) => !chain.expectedMinters.some((m) => sameAddress(m, a)));
}

type LedgerView = { status: number; delta: bigint; latestEpochId: bigint };

/**
 * `pool` is the pool the chain actually routes CCIP through: the TokenAdminRegistry's answer where a registry is
 * deployed, else the spec pool (Anvil), so peer checks run everywhere. `registered` says which one it is.
 */
type ChainState = { chain: TopologyChain; ledger: LedgerView; minters: Hex[]; pool: Hex | null; registered: boolean; activeSpecHash: Hex | null };

type Read = { call: Call; use: (r: CallResult) => void };

/**
 * Round 1, one aggregate3 per chain at latest: ledger status and epoch, `hasRole(MINTER_ROLE, candidate)` per
 * unlisted candidate (a revoked grant is not a finding), the CCIP pool registered for the token, and on the
 * registry chain the active spec hash (PRD section 6 spec lifecycle: the workflows must run the activated spec).
 */
function readState(io: ChainIo, config: W4Config, multicall3: Hex, chain: TopologyChain, candidates: readonly Hex[]): ChainState {
  const specPool = chain.ccipPools[0];
  const state: ChainState = {
    chain,
    ledger: { status: 0, delta: 0n, latestEpochId: 0n },
    minters: [],
    pool: specPool === undefined ? null : (specPool.toLowerCase() as Hex),
    registered: false,
    activeSpecHash: null,
  };
  const reads: Read[] = [
    {
      call: { target: chain.ledger, callData: encodeFunctionData({ abi: LEDGER_ABI, functionName: "statusOf", args: [config.tokenId] }) },
      use: (r) => {
        const [status, delta] = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "statusOf", data: successful(r, `${chain.name} statusOf`) });
        state.ledger.status = status;
        state.ledger.delta = delta;
      },
    },
    {
      call: { target: chain.ledger, callData: encodeFunctionData({ abi: LEDGER_ABI, functionName: "latestEpoch", args: [config.tokenId] }) },
      use: (r) => {
        state.ledger.latestEpochId = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "latestEpoch", data: successful(r, `${chain.name} latestEpoch`) }).epochId;
      },
    },
    ...candidates.map((account) => ({
      call: { target: chain.token, callData: encodeFunctionData({ abi: ACCESS_CONTROL_ABI, functionName: "hasRole", args: [config.minterRole, account] }) },
      use: (r: CallResult) => {
        if (r.success && r.returnData !== "0x" && decodeFunctionResult({ abi: ACCESS_CONTROL_ABI, functionName: "hasRole", data: r.returnData })) state.minters.push(account);
      },
    })),
  ];
  const tokenAdminRegistry = chain.tokenAdminRegistry;
  if (tokenAdminRegistry !== null) {
    reads.push({
      call: { target: tokenAdminRegistry, callData: encodeFunctionData({ abi: TOPOLOGY_ABI, functionName: "getPool", args: [chain.token] }) },
      use: (r) => {
        const pool = decodeFunctionResult({ abi: TOPOLOGY_ABI, functionName: "getPool", data: successful(r, `${chain.name} getPool`) });
        state.pool = pool.toLowerCase() === ZERO_ADDRESS ? null : (pool.toLowerCase() as Hex);
        state.registered = true;
      },
    });
  }
  if (config.registry.chain === chain.name) {
    reads.push({
      call: { target: config.registry.address, callData: encodeFunctionData({ abi: TOPOLOGY_ABI, functionName: "activeSpecHash", args: [config.tokenId] }) },
      use: (r) => {
        state.activeSpecHash = decodeFunctionResult({ abi: TOPOLOGY_ABI, functionName: "activeSpecHash", data: successful(r, "activeSpecHash") }).toLowerCase() as Hex;
      },
    });
  }
  const results = decodeAggregate3(io.call(chain.name, multicall3, encodeAggregate3(reads.map((r) => r.call)), { tag: "latest" }), reads.length);
  results.forEach((r, i) => reads[i]?.use(r));
  return state;
}

function decodeRemotePool(raw: Hex): Hex | null {
  // EVM remote pools are abi.encode(address): exactly one 32-byte word.
  if (raw.length !== 66) return null;
  const [address] = decodeAbiParameters([{ type: "address" }], raw);
  return address.toLowerCase() as Hex;
}

/**
 * Pool checks from current state, so a pool swap or a peer added long ago is seen by every run:
 * - the pool registered in the CCIP TokenAdminRegistry must be one of the spec's pools on that chain;
 * - round 2 (one aggregate3 per chain with a known pool): its supported chains must all be spec chains, and for
 *   every other spec chain whose pool is known, its remote pools must be exactly that pool (the peer set).
 * Without a TokenAdminRegistry (Anvil) the spec pool's peers are still checked; a chain with no pool is skipped.
 */
function checkPools(io: ChainIo, config: W4Config, multicall3: Hex, states: readonly ChainState[]): Finding[] {
  const findings: Finding[] = [];
  const specSelectors = new Set(config.chains.map((c) => c.selector));
  for (const s of states) {
    if (s.pool === null) {
      io.log(`${s.chain.name}: no CCIP pool to check`);
      continue;
    }
    if (s.registered && !s.chain.ccipPools.some((p) => sameAddress(p, s.pool ?? ZERO_ADDRESS))) findings.push({ kind: "pool", chain: s.chain, pool: s.pool, expected: s.chain.ccipPools });
    const peers = states.filter((o) => o !== s && o.pool !== null);
    const reads: Read[] = [
      {
        call: { target: s.pool, callData: encodeFunctionData({ abi: TOPOLOGY_ABI, functionName: "getSupportedChains" }) },
        use: (r) => {
          const supported = decodeFunctionResult({ abi: TOPOLOGY_ABI, functionName: "getSupportedChains", data: successful(r, `${s.chain.name} getSupportedChains`) });
          for (const sel of supported) {
            if (!specSelectors.has(sel.toString())) findings.push({ kind: "peer", chain: s.chain, detail: `pool ${s.pool ?? ""} supports chain ${sel.toString()} outside the spec` });
          }
        },
      },
      ...peers.map((o) => ({
        call: { target: s.pool ?? ZERO_ADDRESS, callData: encodeFunctionData({ abi: TOPOLOGY_ABI, functionName: "getRemotePools", args: [BigInt(o.chain.selector)] }) },
        use: (r: CallResult) => {
          // A revert means the peer chain is not configured at all, which only removes a lane: not a mint path.
          if (!r.success) return;
          const pools = decodeFunctionResult({ abi: TOPOLOGY_ABI, functionName: "getRemotePools", data: r.returnData }).map((p) => decodeRemotePool(p));
          for (const p of pools) {
            if (p !== o.pool) findings.push({ kind: "peer", chain: s.chain, detail: `pool ${s.pool ?? ""} trusts remote pool ${p ?? "(non-EVM bytes)"} on ${o.chain.name}, expected ${o.pool ?? ""}` });
          }
        },
      })),
    ];
    const results = decodeAggregate3(io.call(s.chain.name, multicall3, encodeAggregate3(reads.map((r) => r.call)), { tag: "latest" }), reads.length);
    results.forEach((r, i) => reads[i]?.use(r));
  }
  return findings;
}

/** Idempotency key of a drift: the same findings page once, however many runs see them. */
export function driftKey(tokenId: Hex, findings: readonly Finding[]): Hex {
  const lines = findings.map(describe).sort();
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "string[]" }], [tokenId, lines]));
}

const TOPOLOGY_EVIDENCE = stringToHex("KIRCHHOFF_TOPOLOGY_V2", { size: 32 });

export type TopologyTrigger =
  | { kind: "scan" }
  | { kind: "spec"; log: ChainLog }
  | { kind: "grant"; chain: string; log: ChainLog }
  | { kind: "pool"; chain: string; log: ChainLog };

export type TopologyOutcome = { findings: Finding[]; writes: WriteResult[]; scanned: PinnedBlock[]; driftKey: Hex | null; text: string | null };

/**
 * PRD section 8 W4: reload the active spec, scan for new minters, pools and peers, raise DRIFT SPEC_MISMATCH and
 * hand the caller a page (text + idempotency key). The RoleGranted window scan runs only on the cron and
 * SpecActivated paths; a trigger log is evidence by itself. DRIFT goes to every ledger that is CONSERVED or DRIFT
 * (an UNKNOWN ledger cannot start in DRIFT; a contained one already fails every message).
 */
export function runTopology(io: ChainIo, config: W4Config, multicall3: Hex, trigger: TopologyTrigger, now: bigint): TopologyOutcome {
  const scanned: PinnedBlock[] = [];
  const candidates = new Map<string, Hex[]>();
  for (const chain of watchedChains(config)) {
    if (trigger.kind === "grant" || trigger.kind === "pool") {
      candidates.set(chain.name, trigger.kind === "grant" && trigger.chain === chain.name ? unlisted(chain, grantedMinters(config, [trigger.log])) : []);
      continue;
    }
    const head = io.header(chain.name, { tag: "latest" }).number;
    io.log(`${chain.name}: scanning RoleGranted(MINTER_ROLE) on ${chain.token} up to block ${head.toString()}`);
    scanned.push({ chain: BigInt(chain.selector), block: head });
    const logs: ChainLog[] = [];
    for (let w = 0; w < W4_WINDOWS_PER_CHAIN; w++) {
      const end = head - BigInt(w) * CRE_LOG_QUERY_BLOCK_LIMIT;
      if (end < 1n) break;
      logs.push(...io.logs(chain.name, { addresses: [chain.token], topics: [[config.roleGrantedTopic0], [config.minterRole]], ...logWindow(end) }));
    }
    candidates.set(chain.name, unlisted(chain, grantedMinters(config, logs)));
  }
  if (trigger.kind !== "scan") {
    const chainName = trigger.kind === "spec" ? config.registry.chain : trigger.chain;
    const chain = config.chains.find((c) => c.name === chainName);
    if (chain !== undefined) scanned.push({ chain: BigInt(chain.selector), block: trigger.log.blockNumber });
  }

  const states = config.chains.map((chain) => readState(io, config, multicall3, chain, candidates.get(chain.name) ?? []));
  const findings: Finding[] = [];
  const active = states.find((s) => s.activeSpecHash !== null)?.activeSpecHash ?? null;
  if (active !== null && active !== config.specHash.toLowerCase()) findings.push({ kind: "spec", active, running: config.specHash });
  for (const s of states) for (const account of s.minters) findings.push({ kind: "minter", chain: s.chain, account });
  findings.push(...checkPools(io, config, multicall3, states));

  if (findings.length === 0) {
    io.log(`topology matches spec ${config.specHash}: active spec, minters, pools and peers`);
    return { findings, writes: [], scanned, driftKey: null, text: null };
  }
  for (const f of findings) io.log(`SPEC_MISMATCH: ${describe(f)}`);

  const key = driftKey(config.tokenId, findings);
  const hash = blocksHash(scanned);
  const evidenceHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [TOPOLOGY_EVIDENCE, hash, key]));
  const latestId = states.reduce((m, s) => (s.ledger.latestEpochId > m ? s.ledger.latestEpochId : m), 0n);
  const epochId = latestId + 1n > now ? latestId + 1n : now;
  const writes: WriteResult[] = [];
  for (const target of ledgerTargets(config.chains)) {
    const ledger = states.find((s) => s.chain.name === target.chain)?.ledger;
    if (ledger === undefined || (ledger.status !== Status.CONSERVED && ledger.status !== Status.DRIFT)) {
      io.log(`skip SPEC_MISMATCH on ${target.chain}: ledger status ${ledger === undefined ? "unread" : statusLabel(ledger.status)}`);
      continue;
    }
    writes.push(
      ...writeToLedgers(io, [target], config.tokenId, {
        reportType: ReportType.EPOCH,
        payload: { epochId, delta: ledger.delta, blocksHash: hash, evidenceHash, status: Status.DRIFT, reason: Reason.SPEC_MISMATCH, settledMessageIds: [] },
      }),
    );
  }
  const text = [`KIRCHHOFF: ${config.token} DRIFT (SPEC_MISMATCH)`, ...findings.map((f) => `- ${describe(f)}`), "The token's mint topology differs from its approved KIRCH-SPEC."].join("\n");
  return { findings, writes, scanned, driftKey: key, text };
}
