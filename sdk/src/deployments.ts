import type { Address, ChainKey } from "./api-types.ts";
import { CHAINS, chainByChainId, isChainKey, type NetworkMode } from "./chains.ts";

/** Every address KIRCHHOFF reads on one chain, normalized from deployments/<network>.json. */
export type ChainDeploymentInfo = {
  chain: ChainKey;
  chainId: number;
  mode: NetworkMode;
  role: "home" | "remote";
  tokenSymbol: string;
  ledger: Address;
  quarantine: Address;
  feed: Address;
  guard: Address | null;
  registry: Address | null;
  /** Canonical kETH on home, RemoteKETH on remotes. */
  token: Address;
  /** HomeEscrowAdapter (home only). */
  escrow: Address | null;
  weakBridge: Address | null;
  ccipPool: Address | null;
  ccipLockBox: Address | null;
  onRamp: Address | null;
  offRamp: Address | null;
  tokenAdminRegistry: Address | null;
  lendingMarket: Address | null;
  issuerSafe: Address | null;
  deployedAtBlock: bigint | null;
};

export type DeploymentSet = {
  mode: NetworkMode;
  chains: Partial<Record<ChainKey, ChainDeploymentInfo>>;
};

export class DeploymentError extends Error {
  override readonly name = "DeploymentError";
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function addr(doc: Json, key: string, where: string): Address {
  const v = doc[key];
  if (typeof v !== "string" || !ADDRESS.test(v) || v === ZERO) throw new DeploymentError(`${where}: missing address "${key}"`);
  return v.toLowerCase() as Address;
}

function optAddr(doc: Json | undefined, key: string): Address | null {
  const v = doc?.[key];
  return typeof v === "string" && ADDRESS.test(v) && v !== ZERO ? (v.toLowerCase() as Address) : null;
}

function optBlock(doc: Json, key: string): bigint | null {
  const v = doc[key];
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

/** The per-chain flat file written by contracts/script/Deploy.s.sol. */
function fromFlat(doc: Json, where: string): ChainDeploymentInfo {
  const chainId = doc.chainId;
  if (typeof chainId !== "number") throw new DeploymentError(`${where}: chainId missing`);
  const known = chainByChainId(chainId);
  if (known === undefined) throw new DeploymentError(`${where}: chain id ${chainId} is not one of the three KIRCHHOFF chains`);
  const role = known.info.alias === "home" ? "home" : "remote";
  const symbol = typeof doc.tokenSymbol === "string" ? doc.tokenSymbol : "kETH";
  const token = role === "home" ? addr(doc, "kETH", where) : addr(doc, "remoteKETH", where);
  return {
    chain: known.info.key,
    chainId,
    mode: known.mode,
    role,
    tokenSymbol: symbol,
    ledger: addr(doc, "conservationLedger", where),
    quarantine: addr(doc, "quarantineController", where),
    feed: addr(doc, "conservationFeed", where),
    guard: optAddr(doc, "kirchhoffGuard"),
    registry: optAddr(doc, "kirchhoffRegistry"),
    token,
    escrow: optAddr(doc, "homeEscrowAdapter"),
    weakBridge: optAddr(doc, "weakBridge"),
    ccipPool: optAddr(doc, "kirchhoffTokenPool"),
    ccipLockBox: optAddr(doc, "ccipLockBox"),
    onRamp: optAddr(doc, "ccipOnRamp") ?? (known.mode === "testnet" ? known.info.ccip.onRamp : null),
    offRamp: optAddr(doc, "ccipOffRamp") ?? (known.mode === "testnet" ? known.info.ccip.offRamp : null),
    tokenAdminRegistry: optAddr(doc, "ccipTokenAdminRegistry"),
    lendingMarket: optAddr(doc, "demoLendingMarket"),
    issuerSafe: optAddr(doc, "issuerSafe"),
    deployedAtBlock: optBlock(doc, "deployedAtBlock"),
  };
}

/** The merged `{ network, chains }` format consumed by engine/compile.ts. */
function fromMerged(doc: Json, where: string, symbol: string): ChainDeploymentInfo[] {
  const chains = doc.chains;
  if (!isObject(chains)) throw new DeploymentError(`${where}: "chains" must be an object`);
  const out: ChainDeploymentInfo[] = [];
  for (const [name, raw] of Object.entries(chains)) {
    if (!isChainKey(name) || !isObject(raw)) continue;
    const at = `${where} chains.${name}`;
    const chainId = raw.chainId;
    if (typeof chainId !== "number") throw new DeploymentError(`${at}: chainId missing`);
    const known = chainByChainId(chainId);
    const tokens = isObject(raw.tokens) ? raw.tokens : {};
    const tok = tokens[symbol];
    if (!isObject(tok)) throw new DeploymentError(`${at}: token ${symbol} missing`);
    const bridges = isObject(tok.bridges) ? tok.bridges : undefined;
    const ccip = isObject(raw.ccip) ? raw.ccip : undefined;
    out.push({
      chain: name,
      chainId,
      mode: known?.mode ?? "testnet",
      role: CHAINS[name].alias === "home" ? "home" : "remote",
      tokenSymbol: symbol,
      ledger: addr(raw, "ledger", at),
      quarantine: addr(raw, "quarantine", at),
      feed: addr(raw, "feed", at),
      guard: optAddr(raw, "guard"),
      registry: optAddr(raw, "registry"),
      token: addr(tok, "token", at),
      escrow: optAddr(tok, "escrow"),
      weakBridge: optAddr(bridges, "weakbridge"),
      ccipPool: optAddr(bridges, "ccip"),
      ccipLockBox: optAddr(tok, "lockbox"),
      onRamp: optAddr(ccip, "onRamp") ?? (known?.mode === "testnet" ? CHAINS[name].ccip.onRamp : null),
      offRamp: optAddr(ccip, "offRamp") ?? (known?.mode === "testnet" ? CHAINS[name].ccip.offRamp : null),
      tokenAdminRegistry: optAddr(raw, "tokenAdminRegistry"),
      lendingMarket: optAddr(raw, "lendingMarket"),
      issuerSafe: optAddr(raw, "issuerSafe"),
      deployedAtBlock: optBlock(raw, "deployedAtBlock"),
    });
  }
  return out;
}

/**
 * Normalizes any mix of deployment documents (per-chain flat files from Deploy.s.sol or the merged
 * engine format) into one set for `mode`. Documents for the other mode are ignored, so local and
 * testnet files can sit side by side in deployments/.
 */
export function parseDeployments(docs: readonly { name: string; json: unknown }[], mode: NetworkMode, symbol = "kETH"): DeploymentSet {
  const chains: Partial<Record<ChainKey, ChainDeploymentInfo>> = {};
  for (const { name, json } of docs) {
    if (!isObject(json)) continue;
    const infos = "chains" in json ? fromMerged(json, name, symbol) : "conservationLedger" in json ? [fromFlat(json, name)] : [];
    for (const info of infos) {
      if (info.mode !== mode || info.tokenSymbol !== symbol) continue;
      // deployments/local.json (engine schema) and local-*.raw.json (contract keys) describe the same
      // chain: merge field by field so the richer file fills what the other lacks.
      const prev = chains[info.chain];
      chains[info.chain] = prev ? (Object.fromEntries(Object.entries(info).map(([k, v]) => [k, v ?? prev[k as keyof ChainDeploymentInfo]])) as ChainDeploymentInfo) : info;
    }
  }
  return { mode, chains };
}

export function homeDeployment(set: DeploymentSet): ChainDeploymentInfo {
  const home = Object.values(set.chains).find((c) => c.role === "home");
  if (home === undefined) throw new DeploymentError(`no home chain deployment for ${set.mode}`);
  return home;
}
