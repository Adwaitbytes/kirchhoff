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
};

export interface Explorer {
  readonly id: string;
  contract(chain: ChainKey, address: Address): Promise<ContractMeta | null>;
  /** Contracts created by `deployer` on `chain`, newest first. */
  deployedBy(chain: ChainKey, deployer: Address): Promise<{ address: Address; name: string | null }[]>;
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
    };
  }
  async deployedBy(chain: ChainKey, deployer: Address): Promise<{ address: Address; name: string | null }[]> {
    const base = CHAINS[chain].blockscout;
    const r = await this.get(`${base}/api?module=account&action=txlist&address=${deployer}&sort=desc&offset=200&page=1`, AbortSignal.timeout(8_000)).catch(() => null);
    if (!isObj(r) || !Array.isArray(r.result)) return [];
    const out: { address: Address; name: string | null }[] = [];
    for (const tx of r.result) {
      if (isObj(tx) && typeof tx.contractAddress === "string" && tx.contractAddress.length === 42 && (tx.to === "" || tx.to === null)) {
        out.push({ address: tx.contractAddress.toLowerCase() as Address, name: null });
      }
    }
    return out.slice(0, 40);
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
    return { name, verified: name !== null, abi, source: "etherscan", comments: headerComments(first.SourceCode), creator: null };
  }
  deployedBy(): Promise<{ address: Address; name: string | null }[]> {
    // Base Sepolia account endpoints need a paid plan (docs/research/explorers.md); Blockscout covers this.
    return Promise.resolve([]);
  }
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
  private readonly creations = new Map<ChainKey, Promise<{ address: Address; from: Address }[]>>();
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
    const creator = creations.find((c) => c.address === address.toLowerCase())?.from ?? null;
    return {
      name: match?.name ?? null,
      verified: match !== undefined,
      abi: match?.abi ?? null,
      source: "local-artifacts",
      comments: this.comments[`${chain}:${address.toLowerCase()}`] ?? null,
      creator,
    };
  }

  private scan(chain: ChainKey): Promise<{ address: Address; from: Address }[]> {
    const cached = this.creations.get(chain);
    if (cached) return cached;
    const client = this.clients[chain];
    const p = (async () => {
      if (!client) return [];
      const head = await client.getBlockNumber();
      const out: { address: Address; from: Address }[] = [];
      const floor = head > 5_000n ? head - 5_000n : 0n;
      for (let n = head; n >= floor && n >= 0n; n--) {
        const block = await client.getBlock({ blockNumber: n, includeTransactions: true });
        for (const tx of block.transactions) {
          if (tx.to !== null) continue;
          const receipt = await client.getTransactionReceipt({ hash: tx.hash });
          if (receipt.contractAddress) out.push({ address: receipt.contractAddress.toLowerCase() as Address, from: tx.from.toLowerCase() as Address });
        }
        if (n === 0n) break;
      }
      return out;
    })();
    this.creations.set(chain, p);
    return p;
  }

  async deployedBy(chain: ChainKey, deployer: Address): Promise<{ address: Address; name: string | null }[]> {
    const created = (await this.scan(chain)).filter((c) => c.from === deployer.toLowerCase()).slice(0, 40);
    const out: { address: Address; name: string | null }[] = [];
    for (const c of created) out.push({ address: c.address, name: (await this.contract(chain, c.address))?.name ?? null });
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
  async deployedBy(chain: ChainKey, deployer: Address): Promise<{ address: Address; name: string | null }[]> {
    for (const e of this.list) {
      const r = await e.deployedBy(chain, deployer).catch(() => []);
      if (r.length > 0) return r;
    }
    return [];
  }
}

export const codeHash = (code: Hex): Hex => keccak256(code);
