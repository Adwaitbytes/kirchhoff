import { blocksHash, Reason, ReportType, Status, type Hex, type PinnedBlock, type W4Config } from "@kirchhoff/engine";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { ACCESS_CONTROL_ABI, LEDGER_ABI } from "./abi.ts";
import { CRE_LOG_QUERY_BLOCK_LIMIT, logWindow } from "./budget.ts";
import { ledgerTargets, sameAddress, statusLabel } from "./chains.ts";
import type { ChainIo, ChainLog } from "./io.ts";
import { decodeAggregate3, encodeAggregate3, successful, type Call } from "./multicall.ts";
import { topologyEvidence, writeToLedgers, type WriteResult } from "./reports.ts";

type TopologyChain = W4Config["chains"][number];

/**
 * 100-block RoleGranted windows scanned per remote chain on the cron / SpecActivated path. Budget with two
 * remotes: 2 latest headers + 2 x 4 filterLogs + 3 aggregate3 (hasRole + ledger state) = 13 of 15 reads.
 * Grants older than 400 blocks are caught by the per-chain RoleGranted log triggers when they happen.
 */
export const W4_WINDOWS_PER_CHAIN = 4;

/** Chains whose token has mint roles to watch: every remote (the home canonical token is Ownable, not roles). */
export function watchedChains(config: W4Config): TopologyChain[] {
  return config.chains.filter((c) => !c.isHome);
}

export type Finding = { chain: TopologyChain; minter: Hex };

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
 * One aggregate3 per chain at the latest block: `hasRole(MINTER_ROLE, candidate)` for each unlisted candidate (a
 * revoked grant is not a finding) plus the ledger status and latest epoch.
 */
function confirm(io: ChainIo, config: W4Config, multicall3: Hex, chain: TopologyChain, candidates: readonly Hex[]): { minters: Hex[]; ledger: LedgerView } {
  const calls: Call[] = [
    { target: chain.ledger, callData: encodeFunctionData({ abi: LEDGER_ABI, functionName: "statusOf", args: [config.tokenId] }) },
    { target: chain.ledger, callData: encodeFunctionData({ abi: LEDGER_ABI, functionName: "latestEpoch", args: [config.tokenId] }) },
    ...candidates.map((account) => ({
      target: chain.token,
      callData: encodeFunctionData({ abi: ACCESS_CONTROL_ABI, functionName: "hasRole", args: [config.minterRole, account] }),
    })),
  ];
  const results = decodeAggregate3(io.call(chain.name, multicall3, encodeAggregate3(calls), { tag: "latest" }), calls.length);
  const [status, delta] = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "statusOf", data: successful(results[0], `${chain.name} statusOf`) });
  const epoch = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "latestEpoch", data: successful(results[1], `${chain.name} latestEpoch`) });
  const minters = candidates.filter((_, i) => {
    const r = results[i + 2];
    return r !== undefined && r.success && decodeFunctionResult({ abi: ACCESS_CONTROL_ABI, functionName: "hasRole", data: r.returnData });
  });
  return { minters, ledger: { status, delta, latestEpochId: epoch.epochId } };
}

export type TopologyOutcome = { findings: Finding[]; writes: WriteResult[]; scanned: PinnedBlock[] };

/**
 * PRD section 8 W4. `grants` is either the RoleGranted log that triggered this run (exact, no scan) or null for
 * the cron / SpecActivated path, which scans the latest windows. An unlisted minter that still holds the role
 * raises EPOCH DRIFT with reason SPEC_MISMATCH on every ledger that is CONSERVED or DRIFT (an UNKNOWN ledger
 * cannot start in DRIFT; a contained one is already failing every message).
 */
export function runTopology(io: ChainIo, config: W4Config, multicall3: Hex, grant: { chain: string; log: ChainLog } | null, now: bigint): TopologyOutcome {
  const scanned: PinnedBlock[] = [];
  const candidates = new Map<string, Hex[]>();
  for (const chain of watchedChains(config)) {
    if (grant !== null) {
      candidates.set(chain.name, grant.chain === chain.name ? unlisted(chain, grantedMinters(config, [grant.log])) : []);
      if (grant.chain === chain.name) scanned.push({ chain: BigInt(chain.selector), block: grant.log.blockNumber });
      continue;
    }
    const head = io.header(chain.name, { tag: "latest" }).number;
    io.log(`${chain.name}: scanning RoleGranted(MINTER_ROLE) on ${chain.token} up to block ${head.toString()}`);
    scanned.push({ chain: BigInt(chain.selector), block: head });
    const logs: ChainLog[] = [];
    for (let w = 0; w < W4_WINDOWS_PER_CHAIN; w++) {
      const end = head - BigInt(w) * CRE_LOG_QUERY_BLOCK_LIMIT;
      if (end < 0n) break;
      logs.push(
        ...io.logs(chain.name, {
          addresses: [chain.token],
          topics: [[config.roleGrantedTopic0], [config.minterRole]],
          ...logWindow(end),
        }),
      );
    }
    candidates.set(chain.name, unlisted(chain, grantedMinters(config, logs)));
  }

  const findings: Finding[] = [];
  const ledgers = new Map<string, LedgerView>();
  for (const chain of config.chains) {
    const { minters, ledger } = confirm(io, config, multicall3, chain, candidates.get(chain.name) ?? []);
    ledgers.set(chain.name, ledger);
    for (const minter of minters) findings.push({ chain, minter });
  }
  if (findings.length === 0) {
    io.log("topology matches the spec: no unlisted minter holds the role");
    return { findings, writes: [], scanned };
  }
  for (const f of findings) io.log(`SPEC_MISMATCH: ${f.minter} can mint ${config.token} on ${f.chain.name} but is not in the spec`);

  const hash = blocksHash(scanned);
  const evidenceHash = topologyEvidence({ blocksHash: hash, findings: findings.map((f) => ({ chain: BigInt(f.chain.selector), minter: f.minter })) });
  const latestId = [...ledgers.values()].reduce((m, l) => (l.latestEpochId > m ? l.latestEpochId : m), 0n);
  const epochId = latestId + 1n > now ? latestId + 1n : now;
  const writes: WriteResult[] = [];
  for (const target of ledgerTargets(config.chains)) {
    const ledger = ledgers.get(target.chain);
    if (ledger === undefined || (ledger.status !== Status.CONSERVED && ledger.status !== Status.DRIFT)) {
      io.log(`skip SPEC_MISMATCH on ${target.chain}: ledger status ${ledger === undefined ? "unread" : statusLabel(ledger.status)}`);
      continue;
    }
    writes.push(
      ...writeToLedgers(io, [target], config.tokenId, {
        reportType: ReportType.EPOCH,
        payload: {
          epochId,
          delta: ledger.delta,
          blocksHash: hash,
          evidenceHash,
          status: Status.DRIFT,
          reason: Reason.SPEC_MISMATCH,
          settledMessageIds: [],
        },
      }),
    );
  }
  return { findings, writes, scanned };
}
