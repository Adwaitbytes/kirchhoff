import { keccak256, stringToBytes, toFunctionSelector } from "viem";
import { CCIP_EVENTS, CCIP_TOPICS } from "./adapters/ccip.ts";
import { bridgeAddressMaps, emitterOn, messageIdTopic, parseBridgeEvent, type AddressMapName } from "./adapters/event.ts";
import { bridgeForMinter, chainByAlias, confidenceOn, specChains } from "./chains.ts";
import { MULTICALL3, eventTopic } from "./contract-events.ts";
import type { BridgeSpec, ChainRef, Confidence, Hex, TokenSpec } from "./types.ts";

/** Per-chain deployment record written by demo/deploy-all into deployments/<network>.json. */
export type ChainDeployment = {
  chainId: number;
  ledger: Hex;
  quarantine: Hex;
  feed: Hex;
  /** Home chain only. */
  registry?: Hex;
  /** CCIP 2.0.0 ramps on this chain (one OnRamp and one OffRamp serve every lane). */
  ccip?: { onRamp: Hex; offRamp: Hex };
  tokens: Readonly<
    Record<
      string,
      {
        /** Canonical token on home, remote representation elsewhere. */
        token: Hex;
        /** Home chain escrow adapter (lock_release_home). */
        escrow?: Hex;
        /** Home chain ERC20LockBox behind the CCIP lock-release pool. */
        lockbox?: Hex;
        /** Bridge contract per spec bridge id: CCIP pool or custom bridge endpoint. */
        bridges?: Readonly<Record<string, Hex>>;
      }
    >
  >;
};

export type Deployments = { network: string; chains: Readonly<Record<string, ChainDeployment>> };

export type WorkflowName = "w1-junction" | "w2-loop" | "w3-responder" | "w4-topology";

/** CRE log trigger confidence levels. */
export type TriggerConfidence = "LATEST" | "SAFE" | "FINALIZED";
/** CRE chain read confidence: chain reads have no SAFE level. */
export type ReadConfidence = "latest" | "finalized";

/** CRE `ChainRead.LogQueryBlockLimit` (docs/research/cre.md). */
export const CRE_LOG_QUERY_BLOCK_LIMIT = 100n;

/**
 * Spec confidence to CRE: log triggers support SAFE natively; chain reads only
 * accept latest or finalized, so `safe` reads use finalized, the stricter
 * choice (INTERFACES.md revision 2 item 4).
 */
export function creConfidence(c: Confidence): { trigger: TriggerConfidence; read: ReadConfidence } {
  if (c === "latest") return { trigger: "LATEST", read: "latest" };
  return { trigger: c === "safe" ? "SAFE" : "FINALIZED", read: "finalized" };
}

type ChainEntry = {
  name: string;
  /** Decimal string: JSON cannot carry a uint64 losslessly as a number. */
  selector: string;
  chainId: number;
  alias: string;
  isHome: boolean;
  /** As written in the spec. */
  confidence: Confidence;
  triggerConfidence: TriggerConfidence;
  readConfidence: ReadConfidence;
  decimals: number;
  token: Hex;
  ledger: Hex;
  quarantine: Hex;
  feed: Hex;
};

type EventWatch = { chain: string; bridgeId: string; adapter: string; address: Hex; event: string; topic0: Hex };

/** CCIP 2.0 value movements sit on the pool; the id sits on the ramp log of the same tx. */
type PairedWatch = EventWatch & { pairWith: { address: Hex; event: string; topic0: Hex } | null };

type DebitLookup = PairedWatch & {
  messageIdTopicIndex: 1 | 2 | 3;
  /** Blocks per filterLogs query, capped at CRE's limit. */
  searchWindowBlocks: string;
  /** `debitOf(bytes32)` selector when the bridge exposes the debit registry, else null. */
  registry: { debitOf: Hex; creditOf: Hex } | null;
};

export type W1Config = {
  workflow: "w1-junction";
  token: string;
  tokenId: Hex;
  specHash: Hex;
  chains: ChainEntry[];
  creditTriggers: PairedWatch[];
  debitLookups: DebitLookup[];
  matchWindowSeconds: string;
};

export type W2Config = {
  workflow: "w2-loop";
  token: string;
  tokenId: Hex;
  specHash: Hex;
  model: TokenSpec["model"];
  unit: TokenSpec["unit"];
  schedule: string;
  multicall3: Hex;
  chains: ChainEntry[];
  /** Read selectors: shares instead of balances for rebasing tokens (PRD section 10). */
  reads: { supply: string; balance: string };
  escrowHolders: Hex[];
  supplyTriggers: { chain: string; address: Hex; topic0: Hex }[];
  debitEvents: PairedWatch[];
  creditEvents: PairedWatch[];
  logQueryBlockLimit: string;
  porFeed: Hex | null;
  reserveDecimals: number;
  toleranceWei: string;
  breachConfirmations: number;
  flowLimitPerHour: string | null;
  matchWindowSeconds: string;
};

export type W3Config = {
  workflow: "w3-responder";
  token: string;
  tokenId: Hex;
  specHash: Hex;
  home: string;
  breachTrigger: { chain: string; address: Hex; topic0: Hex; confidence: TriggerConfidence };
  chains: ChainEntry[];
  onBroken: TokenSpec["response"]["onBroken"];
  /** CRE secret names only; values never appear in config. */
  notifySecrets: string[];
};

export type W4Config = {
  workflow: "w4-topology";
  token: string;
  tokenId: Hex;
  specHash: Hex;
  schedule: string;
  registry: { chain: string; address: Hex; specActivatedTopic0: Hex };
  roleGrantedTopic0: Hex;
  minterRole: Hex;
  chains: (ChainEntry & { expectedMinters: Hex[] })[];
};

export type WorkflowConfigs = {
  "w1-junction": W1Config;
  "w2-loop": W2Config;
  "w3-responder": W3Config;
  "w4-topology": W4Config;
};

export type CompileResult =
  | { ok: true; spec: TokenSpec; specHash: Hex; configs: WorkflowConfigs; warnings: string[] }
  | { ok: false; errors: string[] };

const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const isZero = (a: Hex): boolean => a.toLowerCase() === ZERO;

/** Placeholder addresses take the deployed value; a real address must agree with the deployment. */
function pick(label: string, specValue: Hex, deployed: Hex | undefined, errors: string[]): Hex {
  if (deployed === undefined) {
    if (isZero(specValue)) errors.push(`${label}: placeholder address and no deployment entry`);
    return specValue;
  }
  if (!isZero(specValue) && specValue.toLowerCase() !== deployed.toLowerCase()) {
    errors.push(`${label}: spec has ${specValue} but deployments has ${deployed}`);
  }
  return isZero(specValue) ? deployed : specValue;
}

function deployedFor(spec: TokenSpec, bridge: BridgeSpec, name: AddressMapName, chain: ChainRef, d: Deployments): Hex | undefined {
  const dep = d.chains[chain.name];
  if (name === "onramps") return dep?.ccip?.onRamp;
  if (name === "offramps") return dep?.ccip?.offRamp;
  return dep?.tokens[spec.token]?.bridges?.[bridge.id];
}

function resolveMap(
  spec: TokenSpec,
  bridge: BridgeSpec,
  name: AddressMapName,
  map: Readonly<Record<string, Hex>>,
  deployments: Deployments,
  errors: string[],
): Record<string, Hex> {
  const out: Record<string, Hex> = {};
  for (const [alias, address] of Object.entries(map)) {
    const chain = chainByAlias(spec, alias);
    const deployed = chain === undefined ? undefined : deployedFor(spec, bridge, name, chain, deployments);
    out[alias] = pick(`bridges.${bridge.id}.${name}.${alias}`, address, deployed, errors);
  }
  return out;
}

function resolveBridge(spec: TokenSpec, bridge: BridgeSpec, deployments: Deployments, errors: string[]): BridgeSpec {
  const maps = Object.fromEntries(
    bridgeAddressMaps(bridge).map(({ name, map }) => [name, resolveMap(spec, bridge, name, map, deployments, errors)]),
  ) as Record<AddressMapName, Record<string, Hex>>;
  if (bridge.kind === "custom") return { ...bridge, contracts: maps.contracts };
  const lockbox = deployments.chains[spec.home.chain.name]?.tokens[spec.token]?.lockbox;
  return {
    ...bridge,
    pools: maps.pools,
    onramps: maps.onramps,
    offramps: maps.offramps,
    lockbox: bridge.lockbox === null ? null : pick(`bridges.${bridge.id}.lockbox`, bridge.lockbox, lockbox, errors),
  };
}

/** Replaces every placeholder address in the spec with its deployed address. */
export function resolveSpec(spec: TokenSpec, deployments: Deployments): { spec: TokenSpec; errors: string[] } {
  const errors: string[] = [];
  const tokenOnChain = (chain: ChainRef) => deployments.chains[chain.name]?.tokens[spec.token];
  const homeToken = tokenOnChain(spec.home.chain);
  const resolved: TokenSpec = {
    ...spec,
    home: {
      ...spec.home,
      canonical: pick("home.canonical", spec.home.canonical, homeToken?.token, errors),
      escrow: spec.home.escrow === null ? null : pick("home.escrow", spec.home.escrow, homeToken?.escrow, errors),
    },
    remotes: spec.remotes.map((r) => ({
      ...r,
      token: pick(`remotes.${r.chain.alias}.token`, r.token, tokenOnChain(r.chain)?.token, errors),
    })),
    bridges: spec.bridges.map((b) => resolveBridge(spec, b, deployments, errors)),
  };
  return { spec: resolved, errors };
}

function chainEntries(spec: TokenSpec, deployments: Deployments, errors: string[]): { ref: ChainRef; entry: ChainEntry }[] {
  const entries: { ref: ChainRef; entry: ChainEntry }[] = [];
  for (const chain of specChains(spec)) {
    const dep = deployments.chains[chain.name];
    if (dep === undefined) {
      errors.push(`deployments has no entry for chain ${chain.name}`);
      continue;
    }
    const remote = spec.remotes.find((r) => r.chain.selector === chain.selector);
    const confidence = confidenceOn(spec, chain.selector);
    const cre = creConfidence(confidence);
    entries.push({
      ref: chain,
      entry: {
        name: chain.name,
        selector: chain.selector.toString(),
        chainId: dep.chainId,
        alias: chain.alias,
        isHome: chain.selector === spec.home.chain.selector,
        confidence,
        triggerConfidence: cre.trigger,
        readConfidence: cre.read,
        decimals: remote?.decimals ?? spec.home.decimals,
        token: remote?.token ?? spec.home.canonical,
        ledger: dep.ledger,
        quarantine: dep.quarantine,
        feed: dep.feed,
      },
    });
  }
  return entries;
}

type BridgeWatch = { debit: DebitLookup; credit: PairedWatch };

const REGISTRY = {
  debitOf: toFunctionSelector("debitOf(bytes32)"),
  creditOf: toFunctionSelector("creditOf(bytes32)"),
};

function windowOf(bridge: BridgeSpec, warnings: string[]): bigint {
  if (bridge.searchWindowBlocks <= CRE_LOG_QUERY_BLOCK_LIMIT) return bridge.searchWindowBlocks;
  warnings.push(
    `bridge ${bridge.id}: search_window_blocks ${bridge.searchWindowBlocks.toString()} exceeds CRE's ${CRE_LOG_QUERY_BLOCK_LIMIT.toString()}-block filterLogs limit; queries use ${CRE_LOG_QUERY_BLOCK_LIMIT.toString()}`,
  );
  return CRE_LOG_QUERY_BLOCK_LIMIT;
}

function bridgeWatches(spec: TokenSpec, warnings: string[]): BridgeWatch[] {
  const watches: BridgeWatch[] = [];
  for (const bridge of spec.bridges) {
    const window = windowOf(bridge, warnings).toString();
    if (bridge.kind === "custom") {
      const debit = parseBridgeEvent(bridge.events.debitEvent, bridge.events.debitFields);
      const credit = parseBridgeEvent(bridge.events.creditEvent, bridge.events.creditFields);
      for (const [alias, address] of Object.entries(bridge.contracts)) {
        const chain = chainByAlias(spec, alias);
        if (chain === undefined) continue;
        const common = { chain: chain.name, bridgeId: bridge.id, adapter: bridge.id, address, pairWith: null };
        watches.push({
          debit: {
            ...common,
            event: bridge.events.debitEvent,
            topic0: debit.selector,
            messageIdTopicIndex: messageIdTopic(debit),
            searchWindowBlocks: window,
            registry: REGISTRY,
          },
          credit: { ...common, event: bridge.events.creditEvent, topic0: credit.selector },
        });
      }
      continue;
    }
    for (const [alias, pool] of Object.entries(bridge.pools)) {
      const chain = chainByAlias(spec, alias);
      const onramp = bridge.onramps[alias];
      const offramp = bridge.offramps[alias];
      // validateSpec warns about pools without ramps; such a chain cannot be matched by id.
      if (chain === undefined || onramp === undefined || offramp === undefined) continue;
      const common = { chain: chain.name, bridgeId: bridge.id, adapter: "ccip_v2" };
      watches.push({
        debit: {
          ...common,
          address: onramp,
          event: CCIP_EVENTS.CCIPMessageSent,
          topic0: CCIP_TOPICS.CCIPMessageSent,
          pairWith: { address: pool, event: CCIP_EVENTS.LockedOrBurned, topic0: CCIP_TOPICS.LockedOrBurned },
          messageIdTopicIndex: 3,
          searchWindowBlocks: window,
          registry: null,
        },
        credit: {
          ...common,
          address: offramp,
          event: CCIP_EVENTS.ExecutionStateChanged,
          topic0: CCIP_TOPICS.ExecutionStateChanged,
          pairWith: { address: pool, event: CCIP_EVENTS.ReleasedOrMinted, topic0: CCIP_TOPICS.ReleasedOrMinted },
        },
      });
    }
  }
  return watches;
}

function expectedMinters(spec: TokenSpec, chain: ChainRef, errors: string[]): Hex[] {
  const remote = spec.remotes.find((r) => r.chain.selector === chain.selector);
  if (remote === undefined) return [];
  const minters: Hex[] = [];
  for (const minter of remote.minters) {
    const bridge = bridgeForMinter(spec, minter, chain.alias);
    const address = bridge === undefined ? null : emitterOn(spec, bridge, chain.selector);
    if (address === null) errors.push(`minter ${minter} on ${chain.name} has no bridge address`);
    else minters.push(address);
  }
  return minters;
}

/**
 * Every home address holding locked backing: the escrow adapter plus the
 * ERC20LockBox behind each CCIP lock-release pool (V2 pools do not hold the
 * locked tokens themselves).
 */
function escrowHolders(spec: TokenSpec): Hex[] {
  if (spec.model !== "lock_release_home" || spec.home.escrow === null) return [];
  const holders: Hex[] = [spec.home.escrow];
  for (const bridge of spec.bridges) {
    if (bridge.kind === "ccip_v2" && bridge.lockbox !== null) holders.push(bridge.lockbox);
  }
  return holders;
}

const NOTIFY_SECRETS = ["NOTIFY_TELEGRAM_BOT_TOKEN", "NOTIFY_TELEGRAM_CHAT_ID", "NOTIFY_SLACK_WEBHOOK_URL"];

/**
 * PRD section 8: generates every workflow config from the active spec plus
 * the deployment record. Nobody edits workflow config by hand.
 */
export function compileWorkflows(spec: TokenSpec, deployments: Deployments, specHash: Hex): CompileResult {
  const warnings: string[] = [];
  const { spec: resolved, errors } = resolveSpec(spec, deployments);
  const entries = chainEntries(resolved, deployments, errors).map((e) => ({
    ...e,
    minters: expectedMinters(resolved, e.ref, errors),
  }));
  const home = deployments.chains[resolved.home.chain.name];
  const registry = home?.registry;
  if (registry === undefined) errors.push(`home chain ${resolved.home.chain.name} has no registry deployment`);
  if (errors.length > 0 || home === undefined || registry === undefined) return { ok: false, errors };
  const chains = entries.map((e) => e.entry);

  const watches = bridgeWatches(resolved, warnings);
  const header = { token: resolved.token, tokenId: resolved.tokenId, specHash };
  const matchWindowSeconds = resolved.rules.junction.matchWindowSeconds.toString();
  const shares = resolved.unit === "shares";

  const configs: WorkflowConfigs = {
    "w1-junction": {
      workflow: "w1-junction",
      ...header,
      chains,
      creditTriggers: watches.map((w) => w.credit),
      debitLookups: watches.map((w) => w.debit),
      matchWindowSeconds,
    },
    "w2-loop": {
      workflow: "w2-loop",
      ...header,
      model: resolved.model,
      unit: resolved.unit,
      schedule: "*/30 * * * * *",
      multicall3: MULTICALL3,
      chains,
      reads: shares
        ? { supply: "getTotalShares()", balance: "sharesOf(address)" }
        : { supply: "totalSupply()", balance: "balanceOf(address)" },
      escrowHolders: escrowHolders(resolved),
      supplyTriggers: chains.map((c) => ({ chain: c.name, address: c.token, topic0: eventTopic("Transfer") })),
      debitEvents: watches.map(({ debit: { messageIdTopicIndex, searchWindowBlocks, registry: r, ...watch } }) => watch),
      creditEvents: watches.map((w) => w.credit),
      logQueryBlockLimit: CRE_LOG_QUERY_BLOCK_LIMIT.toString(),
      porFeed: resolved.reserves.porFeed,
      reserveDecimals: resolved.reserves.decimals,
      toleranceWei: resolved.rules.loop.toleranceWei.toString(),
      breachConfirmations: resolved.rules.loop.breachConfirmations,
      flowLimitPerHour: resolved.rules.soft.flowLimitPerHour?.toString() ?? null,
      matchWindowSeconds,
    },
    "w3-responder": {
      workflow: "w3-responder",
      ...header,
      home: resolved.home.chain.name,
      breachTrigger: {
        chain: resolved.home.chain.name,
        address: home.ledger,
        topic0: eventTopic("BreachRecorded"),
        confidence: creConfidence(confidenceOn(resolved, resolved.home.chain.selector)).trigger,
      },
      chains,
      onBroken: resolved.response.onBroken,
      notifySecrets: resolved.response.onBroken.includes("page_issuer") ? NOTIFY_SECRETS : [],
    },
    "w4-topology": {
      workflow: "w4-topology",
      ...header,
      schedule: "0 */10 * * * *",
      registry: {
        chain: resolved.home.chain.name,
        address: registry,
        specActivatedTopic0: eventTopic("SpecActivated"),
      },
      roleGrantedTopic0: eventTopic("RoleGranted"),
      minterRole: keccak256(stringToBytes("MINTER_ROLE")),
      chains: entries.map(({ entry, minters }) => ({ ...entry, expectedMinters: minters })),
    },
  };
  return { ok: true, spec: resolved, specHash, configs, warnings };
}
