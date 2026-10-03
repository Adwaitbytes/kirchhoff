/**
 * PRD section 9 step 3: the Judge's only state. Specs come from local files (the registry stores
 * hashes, not documents), are resolved against the deployment record exactly as the spec compiler
 * does, and hashed with the engine's canonical hash. A timer reads KirchhoffRegistry.activeSpecHash
 * through both home-chain providers; the engine compares the two hashes per message.
 */
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { specChains, type Hex, type OnStale, type SpecCacheEntry, type TokenSpec } from "@kirchhoff/engine";
import { resolveSpec, type Deployments } from "@kirchhoff/engine";
import { DEPLOYMENTS_SCHEMA, parseSpec, specHash } from "@kirchhoff/engine/spec";
import { REGISTRY_ABI } from "./abi.ts";
import type { ChainProviders } from "./rpc.ts";
import { agreeOn, readBoth } from "./rpc.ts";

export type ChainContracts = {
  selector: bigint;
  name: string;
  ledger: Hex;
  quarantine: Hex;
  token: Hex;
  /** CCIP pool for the token on this chain; null when the spec has no CCIP lane here. */
  pool: Hex | null;
  /** CCIP 2.0.0 OnRamp on this chain, from the resolved spec. */
  onRamp: Hex | null;
};

export type ProtectedToken = {
  entry: SpecCacheEntry;
  symbol: string;
  tokenId: Hex;
  cachedSpecHash: Hex;
  onStale: OnStale;
  chains: ReadonlyMap<bigint, ChainContracts>;
  registry: { selector: bigint; address: Hex };
};

export class SpecLoadError extends Error {
  override readonly name = "SpecLoadError";
}

const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;

const validateDeployments = new Ajv({ allErrors: true, strict: true }).compile<Deployments>(DEPLOYMENTS_SCHEMA);

function lower(address: Hex): Hex {
  return address.toLowerCase() as Hex;
}

export function buildToken(spec: TokenSpec, deployments: Deployments): ProtectedToken {
  const { spec: resolved, errors } = resolveSpec(spec, deployments);
  if (errors.length > 0) throw new SpecLoadError(`${spec.token}: ${errors.join("; ")}`);
  const ccip = resolved.bridges.find((b) => b.kind === "ccip_v2");
  const chains = new Map<bigint, ChainContracts>();
  const addresses = new Map<bigint, Hex>();
  for (const chain of specChains(resolved)) {
    const dep = deployments.chains[chain.name];
    if (dep === undefined) throw new SpecLoadError(`${spec.token}: deployments has no chain ${chain.name}`);
    const remote = resolved.remotes.find((r) => r.chain.selector === chain.selector);
    const token = lower(remote?.token ?? resolved.home.canonical);
    const pool = ccip?.kind === "ccip_v2" ? ccip.pools[chain.alias] : undefined;
    const onRamp = ccip?.kind === "ccip_v2" ? ccip.onramps[chain.alias] : undefined;
    addresses.set(chain.selector, token);
    chains.set(chain.selector, {
      selector: chain.selector,
      name: chain.name,
      ledger: lower(dep.ledger),
      quarantine: lower(dep.quarantine),
      token,
      pool: pool === undefined ? null : lower(pool),
      onRamp: onRamp === undefined ? null : lower(onRamp),
    });
  }
  const registry = deployments.chains[resolved.home.chain.name]?.registry;
  if (registry === undefined) throw new SpecLoadError(`${spec.token}: home chain has no registry deployment`);
  return {
    entry: { symbol: resolved.token, tokenId: resolved.tokenId, addresses },
    symbol: resolved.token,
    tokenId: resolved.tokenId,
    // Same document the spec compiler hashes into spec.resolved.json and the registry proposal.
    cachedSpecHash: specHash(resolved),
    onStale: resolved.rules.onStale,
    chains,
    registry: { selector: resolved.home.chain.selector, address: lower(registry) },
  };
}

export function loadTokens(specPaths: readonly string[], deploymentsPath: string): ProtectedToken[] {
  let deployments: unknown;
  try {
    deployments = JSON.parse(readFileSync(deploymentsPath, "utf8"));
  } catch (e) {
    throw new SpecLoadError(`deployments ${deploymentsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!validateDeployments(deployments)) {
    throw new SpecLoadError(`deployments ${deploymentsPath}: ${JSON.stringify(validateDeployments.errors)}`);
  }
  return specPaths.map((path) => {
    const parsed = parseSpec(readFileSync(path, "utf8"));
    if (!parsed.ok) throw new SpecLoadError(`${path}: ${parsed.errors.join("; ")}`);
    return buildToken(parsed.spec, deployments);
  });
}

export type ActiveSpec = { state: "synced"; activeSpecHash: Hex | null } | { state: "unsynced"; note: string };

type SyncState = { activeSpecHash: Hex | null; syncedAt: number } | null;

export class SpecCache {
  readonly tokens: readonly ProtectedToken[];
  private readonly state = new Map<Hex, SyncState>();
  private readonly lastError = new Map<Hex, string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly providersFor: (selector: bigint) => ChainProviders;
  private readonly syncMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly onSyncError: (token: ProtectedToken, note: string) => void;

  constructor(options: {
    tokens: readonly ProtectedToken[];
    providersFor: (selector: bigint) => ChainProviders;
    syncMs: number;
    maxAgeMs: number;
    now?: () => number;
    onSyncError?: (token: ProtectedToken, note: string) => void;
  }) {
    this.tokens = options.tokens;
    this.providersFor = options.providersFor;
    this.syncMs = options.syncMs;
    this.maxAgeMs = options.maxAgeMs;
    this.now = options.now ?? Date.now;
    this.onSyncError = options.onSyncError ?? (() => undefined);
    for (const t of this.tokens) this.state.set(t.tokenId, null);
  }

  get entries(): readonly SpecCacheEntry[] {
    return this.tokens.map((t) => t.entry);
  }

  byTokenId(tokenId: Hex): ProtectedToken | undefined {
    return this.tokens.find((t) => t.tokenId === tokenId);
  }

  /** One registry read per token through both providers; a disagreement keeps the previous value. */
  async syncOnce(): Promise<void> {
    await Promise.all(
      this.tokens.map(async (t) => {
        const chain = this.providersFor(t.registry.selector);
        const pair = await readBoth(chain, (client) =>
          client.readContract({ address: t.registry.address, abi: REGISTRY_ABI, functionName: "activeSpecHash", args: [t.tokenId] }),
        );
        const agreed = agreeOn(pair, (a, b) => a.toLowerCase() === b.toLowerCase(), "registry activeSpecHash");
        if (!agreed.ok) {
          const detail = pair.map((r) => (r.ok ? r.value : r.error)).join(" | ");
          this.lastError.set(t.tokenId, `${agreed.note}: ${detail}`);
          this.onSyncError(t, `${agreed.note}: ${detail}`);
          return;
        }
        const hash = agreed.value.toLowerCase() as Hex;
        this.state.set(t.tokenId, { activeSpecHash: hash === ZERO_HASH ? null : hash, syncedAt: this.now() });
        this.lastError.delete(t.tokenId);
      }),
    );
  }

  active(tokenId: Hex): ActiveSpec {
    const s = this.state.get(tokenId);
    if (s === undefined || s === null) {
      return { state: "unsynced", note: `spec cache never synced${this.errorSuffix(tokenId)}` };
    }
    if (this.now() - s.syncedAt > this.maxAgeMs) {
      return { state: "unsynced", note: `spec cache older than ${this.maxAgeMs}ms${this.errorSuffix(tokenId)}` };
    }
    return { state: "synced", activeSpecHash: s.activeSpecHash };
  }

  ready(): boolean {
    return this.tokens.every((t) => this.active(t.tokenId).state === "synced");
  }

  ageMs(tokenId: Hex): number | null {
    const s = this.state.get(tokenId);
    return s === undefined || s === null ? null : this.now() - s.syncedAt;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.syncOnce(), this.syncMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private errorSuffix(tokenId: Hex): string {
    const error = this.lastError.get(tokenId);
    return error === undefined ? "" : ` (${error})`;
  }
}
