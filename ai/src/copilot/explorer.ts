import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { keccak256, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { CHAINS, type ChainKey } from "@kirchhoff/sdk";

/**
 * Verified-contract metadata, the way block explorers expose it. Everything returned here is
 * UNTRUSTED (names and comments are attacker-controllable) and only ever reaches a model as data.
 */
export type ContractMeta = {
  name: string | null;
  verified: boolean;
  abi: Abi | null;
  source: "blockscout" | "etherscan" | "local-artifacts";
  /** Free text the explorer shows (verified-source header comments, labels). */
  comments: string | null;
  creator: Address | null;
  /** Creation transaction, so log scans can start at the contract's first block instead of a fixed window. */
  creationTx: Hex | null;
};

/** A contract created directly by an EOA, with the creation transaction as provenance. */
export type DeployedContract = { address: Address; name: string | null; tx: Hex | null; block: string | null };

export interface Explorer {
  readonly id: string;
  contract(chain: ChainKey, address: Address): Promise<ContractMeta | null>;
  /**
   * Contracts created by `deployer` on `chain`, newest first. Throws when the lookup itself failed,
   * so "deployed nothing" is never reported for an explorer that did not answer.
   */
  deployedBy(chain: ChainKey, deployer: Address): Promise<DeployedContract[]>;
}

type FetchJson = (url: string, signal: AbortSignal) => Promise<unknown>;

const defaultFetchJson =
  (fetchImpl: typeof fetch): FetchJson =>
  async (url, signal) => {
    const res = await fetchImpl(url, { signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Cap on contracts reported per deployer: enough for a full bridge topology, small enough for a prompt. */
export const MAX_DEPLOYED = 60;
const TXLIST_PAGE = 1_000;
const TXLIST_MAX_PAGES = 5;

/**
 * Contract creations in an Etherscan-compatible `account/txlist` page (Etherscan V2 and Blockscout's
 * RPC API share the shape: `to` is "" and `contractAddress` is set on a creation). Failed creations
 * (isError "1") left no code and are skipped. Returns null when the body is not a txlist answer.
 */
export function creationsFromTxlist(body: unknown, deployer: Address): { creations: DeployedContract[]; rows: number } | null {
  if (!isObj(body)) return null;
  // Both APIs answer "no transactions" with status "0" and an empty array (or a message string).
  if (body.status === "0" && typeof body.message === "string" && /no transactions found/i.test(body.message)) return { creations: [], rows: 0 };
  if (!Array.isArray(body.result)) return null;
  const creations: DeployedContract[] = [];
  for (const tx of body.result) {
    if (!isObj(tx)) continue;
    const isCreation = (tx.to === "" || tx.to === null) && typeof tx.contractAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(tx.contractAddress);
    if (!isCreation || tx.isError === "1") continue;
    if (typeof tx.from === "string" && tx.from.toLowerCase() !== deployer.toLowerCase()) continue;
    creations.push({
      address: (tx.contractAddress as string).toLowerCase() as Address,
      name: null,
      tx: typeof tx.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx.hash) ? (tx.hash.toLowerCase() as Hex) : null,
      block: typeof tx.blockNumber === "string" ? tx.blockNumber : null,
    });
  }
  return { creations, rows: body.result.length };
}

/** Pages a txlist endpoint newest-first until a short page; throws on a non-txlist answer. */
async function pagedCreations(get: FetchJson, urlFor: (page: number) => string, deployer: Address, label: string): Promise<DeployedContract[]> {
  const out: DeployedContract[] = [];
  for (let page = 1; page <= TXLIST_MAX_PAGES && out.length < MAX_DEPLOYED; page++) {
    const body = await get(urlFor(page), AbortSignal.timeout(12_000));
    const parsed = creationsFromTxlist(body, deployer);
    if (!parsed) {
      const msg = isObj(body) && typeof body.result === "string" ? body.result : isObj(body) && typeof body.message === "string" ? body.message : "unexpected response";
      throw new Error(`${label} txlist: ${msg.slice(0, 120)}`);
    }
    out.push(...parsed.creations);
    if (parsed.rows < TXLIST_PAGE) break;
  }
  return out.slice(0, MAX_DEPLOYED);
}

/** Header comment lines of verified source: the place injected instructions usually hide. */
function headerComments(source: unknown): string | null {
  if (typeof source !== "string") return null;
  const lines = source.split("\n").slice(0, 40).filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l));
  return lines.length > 0 ? lines.join("\n").slice(0, 1_500) : null;
}

/** Keyless Blockscout REST v2 (docs/research/explorers.md). */
export class BlockscoutExplorer implements Explorer {
  readonly id = "blockscout";
  private readonly get: FetchJson;
  constructor(fetchImpl: typeof fetch = fetch) {
    this.get = defaultFetchJson(fetchImpl);
  }
  async contract(chain: ChainKey, address: Address): Promise<ContractMeta | null> {
    const base = CHAINS[chain].blockscout;
    const signal = AbortSignal.timeout(8_000);
    const sc = await this.get(`${base}/api/v2/smart-contracts/${address}`, signal).catch(() => null);
    const addr = await this.get(`${base}/api/v2/addresses/${address}`, signal).catch(() => null);
    if (!isObj(sc) && !isObj(addr)) return null;
    const abi = isObj(sc) && Array.isArray(sc.abi) ? (sc.abi as Abi) : null;
    return {
      name: (isObj(sc) && typeof sc.name === "string" ? sc.name : null) ?? (isObj(addr) && typeof addr.name === "string" ? addr.name : null),
      verified: isObj(sc) && sc.is_verified === true,
      abi,
      source: "blockscout",
      comments: isObj(sc) ? headerComments(sc.source_code) : null,
      creator: isObj(addr) && typeof addr.creator_address_hash === "string" ? (addr.creator_address_hash.toLowerCase() as Address) : null,
      creationTx: isObj(addr) && typeof addr.creation_transaction_hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(addr.creation_transaction_hash) ? (addr.creation_transaction_hash.toLowerCase() as Hex) : null,
    };
  }
  deployedBy(chain: ChainKey, deployer: Address): Promise<DeployedContract[]> {
    const base = CHAINS[chain].blockscout;
    return pagedCreations(this.get, (page) => `${base}/api?module=account&action=txlist&address=${deployer}&sort=desc&offset=${TXLIST_PAGE}&page=${page}`, deployer, "blockscout");
  }
}

/** Etherscan API V2: one key for all three testnets; source and ABI work on the free tier everywhere. */
export class EtherscanExplorer implements Explorer {
  readonly id = "etherscan";
  private readonly get: FetchJson;
  private readonly apiKey: string;
  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.get = defaultFetchJson(fetchImpl);
  }
  async contract(chain: ChainKey, address: Address): Promise<ContractMeta | null> {
    const url = `https://api.etherscan.io/v2/api?chainid=${CHAINS[chain].testnetChainId}&module=contract&action=getsourcecode&address=${address}&apikey=${this.apiKey}`;
    const r = await this.get(url, AbortSignal.timeout(8_000)).catch(() => null);
    const first = isObj(r) && Array.isArray(r.result) ? (r.result[0] as unknown) : null;
    if (!isObj(first)) return null;
    let abi: Abi | null = null;
    if (typeof first.ABI === "string" && first.ABI.startsWith("[")) {
      try {
        abi = JSON.parse(first.ABI) as Abi;
      } catch {
        abi = null;
      }
    }
    const name = typeof first.ContractName === "string" && first.ContractName.length > 0 ? first.ContractName : null;
    return { name, verified: name !== null, abi, source: "etherscan", comments: headerComments(first.SourceCode), creator: null, creationTx: null };
  }
  deployedBy(chain: ChainKey, deployer: Address): Promise<DeployedContract[]> {
    // account/txlist answers on the free tier for all three testnets (checked live 2026-10-06).
    const id = CHAINS[chain].testnetChainId;
    return pagedCreations(
      this.get,
      (page) => `https://api.etherscan.io/v2/api?chainid=${id}&module=account&action=txlist&address=${deployer}&startblock=0&endblock=99999999&sort=desc&offset=${TXLIST_PAGE}&page=${page}&apikey=${this.apiKey}`,
      deployer,
      "etherscan",
    );
  }
}

type Creation = { address: Address; from: Address; tx: Hex; block: string };

const LOCAL_SCAN_MAX_BLOCKS = 200_000n;
const LOCAL_SCAN_CONCURRENCY = 32n;
const NAME_LOOKUP_CONCURRENCY = 4;

/** Order-preserving map with at most `limit` calls in flight. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type LocalArtifact = { name: string; abi: Abi; runtime: string; immutables: { start: number; length: number }[] };

/**
 * Local "explorer" for Anvil chains: matches runtime bytecode against contracts/out artifacts with
 * immutable references masked, and finds contract creations by scanning blocks. Same shape as a
 * verified-source lookup, so the Copilot behaves identically on Anvil and testnets.
 */
export class LocalArtifactExplorer implements Explorer {
  readonly id = "local-artifacts";
  private readonly clients: Partial<Record<ChainKey, PublicClient>>;
  private artifacts: LocalArtifact[] | null = null;
  private readonly outDir: string;
  private readonly creations = new Map<ChainKey, Promise<Creation[]>>();
  private readonly comments: Partial<Record<string, string>>;

  constructor(clients: Partial<Record<ChainKey, PublicClient>>, options: { outDir?: string; comments?: Partial<Record<string, string>> } = {}) {
    this.clients = clients;
    this.outDir = options.outDir ?? join(import.meta.dirname, "..", "..", "..", "contracts", "out");
    this.comments = options.comments ?? {};
  }

  private load(): LocalArtifact[] {
    if (this.artifacts) return this.artifacts;
    const list: LocalArtifact[] = [];
    if (existsSync(this.outDir)) {
      for (const dir of readdirSync(this.outDir)) {
        if (!dir.endsWith(".sol") || dir.endsWith(".t.sol") || dir.endsWith(".s.sol")) continue;
        for (const file of readdirSync(join(this.outDir, dir))) {
          if (!file.endsWith(".json")) continue;
          try {
            const j = JSON.parse(readFileSync(join(this.outDir, dir, file), "utf8")) as {
              abi?: Abi;
              deployedBytecode?: { object?: string; immutableReferences?: Record<string, { start: number; length: number }[]> };
            };
            const runtime = j.deployedBytecode?.object;
            if (!runtime || runtime.length <= 2 || !j.abi) continue;
            list.push({ name: file.replace(/\.json$/, ""), abi: j.abi, runtime: runtime.toLowerCase(), immutables: Object.values(j.deployedBytecode?.immutableReferences ?? {}).flat() });
          } catch {
            // A partially written artifact during a concurrent forge build is skipped, not fatal.
          }
        }
      }
    }
    this.artifacts = list;
    return list;
  }

  private static mask(code: string, immutables: { start: number; length: number }[]): string {
    const bytes = code.startsWith("0x") ? code.slice(2) : code;
    const chars = bytes.split("");
    for (const r of immutables) for (let i = r.start * 2; i < (r.start + r.length) * 2 && i < chars.length; i++) chars[i] = "0";
    return chars.join("");
  }

  async contract(chain: ChainKey, address: Address): Promise<ContractMeta | null> {
    const client = this.clients[chain];
    if (!client) return null;
    const code = (await client.getCode({ address }))?.toLowerCase();
    if (!code || code === "0x") return null;
    const match = this.load().find((a) => a.runtime.length === code.length && LocalArtifactExplorer.mask(a.runtime, a.immutables) === LocalArtifactExplorer.mask(code, a.immutables));
    const creations = await this.scan(chain);
    const creation = creations.find((c) => c.address === address.toLowerCase());
    return {
      name: match?.name ?? null,
      verified: match !== undefined,
      abi: match?.abi ?? null,
      source: "local-artifacts",
      comments: this.comments[`${chain}:${address.toLowerCase()}`] ?? null,
      creator: creation?.from ?? null,
      creationTx: creation?.tx ?? null,
    };
  }

  /**
   * Every contract creation on the chain, newest first. Anvil chains here mine a block per second, so
   * a fixed recent window misses the deployment blocks near genesis: scan from genesis (bounded) with
   * a few blocks in flight at a time.
   */
  private scan(chain: ChainKey): Promise<Creation[]> {
    const cached = this.creations.get(chain);
    if (cached) return cached;
    const client = this.clients[chain];
    const p = (async () => {
      if (!client) return [];
      const head = await client.getBlockNumber();
      const floor = head > LOCAL_SCAN_MAX_BLOCKS ? head - LOCAL_SCAN_MAX_BLOCKS : 0n;
      const out: Creation[] = [];
      for (let from = floor; from <= head; from += LOCAL_SCAN_CONCURRENCY) {
        const numbers: bigint[] = [];
        for (let n = from; n < from + LOCAL_SCAN_CONCURRENCY && n <= head; n++) numbers.push(n);
        const blocks = await Promise.all(numbers.map((blockNumber) => client.getBlock({ blockNumber, includeTransactions: true })));
        for (const block of blocks) {
          for (const tx of block.transactions) {
            if (tx.to !== null) continue;
            const receipt = await client.getTransactionReceipt({ hash: tx.hash });
            if (receipt.contractAddress && receipt.status === "success") {
              out.push({ address: receipt.contractAddress.toLowerCase() as Address, from: tx.from.toLowerCase() as Address, tx: tx.hash, block: block.number.toString() });
            }
          }
        }
      }
      return out.reverse();
    })();
    // A failed scan is not cached, so the next call retries instead of reporting an empty chain forever.
    p.catch(() => this.creations.delete(chain));
    this.creations.set(chain, p);
    return p;
  }

  async deployedBy(chain: ChainKey, deployer: Address): Promise<DeployedContract[]> {
    const created = (await this.scan(chain)).filter((c) => c.from === deployer.toLowerCase()).slice(0, MAX_DEPLOYED);
    const out: DeployedContract[] = [];
    for (const c of created) out.push({ address: c.address, name: (await this.contract(chain, c.address))?.name ?? null, tx: c.tx, block: c.block });
    return out;
  }
}

/** Tries each explorer in order and returns the first verified answer (or the first answer at all). */
export class CompositeExplorer implements Explorer {
  readonly id: string;
  private readonly list: readonly Explorer[];
  constructor(list: readonly Explorer[]) {
    this.list = list;
    this.id = list.map((e) => e.id).join("+");
  }
  async contract(chain: ChainKey, address: Address): Promise<ContractMeta | null> {
    let first: ContractMeta | null = null;
    for (const e of this.list) {
      const m = await e.contract(chain, address).catch(() => null);
      if (m?.verified) return m;
      first ??= m;
    }
    return first;
  }
  /**
   * The first explorer that answers with creations wins; unnamed creations are then named from
   * contract metadata (verified name), so the model can tell a WeakBridge from a token. Throws only
   * when every explorer failed: an empty answer from a working explorer is a real "none".
   */
  async deployedBy(chain: ChainKey, deployer: Address): Promise<DeployedContract[]> {
    const failures: string[] = [];
    let answered = false;
    for (const e of this.list) {
      let r: DeployedContract[];
      try {
        r = await e.deployedBy(chain, deployer);
      } catch (err) {
        failures.push(`${e.id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      answered = true;
      if (r.length === 0) continue;
      return await mapLimit(r, NAME_LOOKUP_CONCURRENCY, async (c) => (c.name !== null ? c : { ...c, name: (await this.contract(chain, c.address))?.name ?? null }));
    }
    if (!answered && failures.length > 0) throw new Error(`no explorer answered: ${failures.join("; ").slice(0, 300)}`);
    return [];
  }
}

export const codeHash = (code: Hex): Hex => keccak256(code);
