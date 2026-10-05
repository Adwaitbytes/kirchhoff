/**
 * A private three-chain KIRCHHOFF world for integration tests: starts its own Anvil instances
 * (never the shared 8545-8547 chains), deploys the real contracts from contracts/out with viem,
 * and drives them the way the demo and the CRE workflows do (WeakBridge sends, forged credits,
 * EPOCH and BREACH reports through the MockKeystoneForwarder).
 *
 * The keys below are Anvil's public development keys, not secrets.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  parseAbi,
  stringToBytes,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, type ChainDeploymentInfo, type ChainKey, type DeploymentSet } from "@kirchhoff/sdk";

const ROOT = join(import.meta.dirname, "..", "..");
const ANVIL = process.env.ANVIL_BIN ?? join(homedir(), ".foundry", "bin", "anvil");

export const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  user: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  verifier: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  attacker: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;

export const ACCOUNTS = {
  owner: privateKeyToAccount(KEYS.owner),
  user: privateKeyToAccount(KEYS.user),
  verifier: privateKeyToAccount(KEYS.verifier),
  attacker: privateKeyToAccount(KEYS.attacker),
};

const SIM_WORKFLOW_ID: Hex = `0x${"11".repeat(32)}`;
const SIM_WORKFLOW_OWNER: Address = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const ALL_REPORT_TYPES = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4);
const LOCAL_MOCK_MODE = 2;

export const TOKEN_ID = keccak256(stringToBytes("kETH"));

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("world: missing deployment address");
  return v;
}

type Artifact = { abi: Abi; bytecode: { object: Hex } };
const ARTIFACT_FILE: Readonly<Record<string, string>> = { LocalRouterMock: "LocalCCIPMocks", LocalRMNMock: "LocalCCIPMocks" };
function artifact(name: string): Artifact {
  const file = ARTIFACT_FILE[name] ?? name;
  return JSON.parse(readFileSync(join(ROOT, "contracts", "out", `${file}.sol`, `${name}.json`), "utf8")) as Artifact;
}

const forwarderAbi = parseAbi(["function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)"]);
const adminAbi = parseAbi([
  "function setQuarantineController(address controller)",
  "function registerToken(bytes32 tokenId, uint64 stalenessSeconds)",
  "function setWorkflow(bytes32 workflowId, address workflowOwner, string name, uint8 allowedReportTypes)",
  "function configureToken(bytes32 tokenId, address issuerSafe, uint64 recoveryTimelockSeconds)",
  "function setBridge(address bridge)",
  "function grantMintAndBurnRoles(address burnAndMinter)",
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function send(address to, uint256 amount, uint64 dstChain) returns (bytes32 id)",
  "function credit(bytes32 id, address to, uint256 amount, uint64 srcChain, bytes signature)",
  "function nonce() view returns (uint256)",
  "function registerToken(string symbol, address issuerSafe) returns (bytes32)",
]);

export type WorldChain = {
  key: ChainKey;
  rpc: string;
  pub: PublicClient;
  wallet: (who: keyof typeof KEYS) => WalletClient;
  dep: ChainDeploymentInfo;
  forwarder: Address;
};

export class World {
  readonly chains: Record<ChainKey, WorldChain>;
  private readonly procs: ChildProcess[];

  private constructor(chains: Record<ChainKey, WorldChain>, procs: ChildProcess[]) {
    this.chains = chains;
    this.procs = procs;
  }

  get deployments(): DeploymentSet {
    const out: DeploymentSet = { mode: "local", chains: {} };
    for (const c of Object.values(this.chains)) out.chains[c.key] = c.dep;
    return out;
  }

  get rpc(): Record<ChainKey, string[]> {
    const out = {} as Record<ChainKey, string[]>;
    for (const c of Object.values(this.chains)) out[c.key] = [c.rpc];
    return out;
  }

  static async start(basePort = Number(process.env.WORLD_BASE_PORT ?? 28545)): Promise<World> {
    const keys: ChainKey[] = ["ethereum-testnet-sepolia", "ethereum-testnet-sepolia-arbitrum-1", "ethereum-testnet-sepolia-base-1"];
    const procs: ChildProcess[] = [];
    const chains = {} as Record<ChainKey, WorldChain>;
    try {
      for (const [i, key] of keys.entries()) {
        const port = basePort + i;
        const chainId = CHAINS[key].localChainId;
        const busy = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then(() => true, () => false);
        if (busy) throw new Error(`World: port ${port} is already in use (a leftover anvil?); stop it or set another base port`);
        const proc = spawn(ANVIL, ["--port", String(port), "--chain-id", String(chainId), "--silent"], { stdio: "ignore" });
        procs.push(proc);
        process.once("exit", () => proc.kill());
        const rpc = `http://127.0.0.1:${port}`;
        const chain = { id: chainId, name: key, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
        const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 });
        for (let t = 0; t < 100; t++) {
          if (await pub.getChainId().then(() => true, () => false)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const wallet = (who: keyof typeof KEYS): WalletClient => createWalletClient({ account: privateKeyToAccount(KEYS[who]), chain, transport: http(rpc), pollingInterval: 50 });
        chains[key] = { key, rpc, pub, wallet, dep: undefined as unknown as ChainDeploymentInfo, forwarder: "0x" };
      }
      const world = new World(chains, procs);
      for (const key of keys) await world.deploy(key);
      return world;
    } catch (e) {
      for (const p of procs) p.kill();
      throw e;
    }
  }

  async stop(): Promise<void> {
    for (const p of this.procs) p.kill();
    await new Promise((r) => setTimeout(r, 100));
  }

  private async deployContract(c: WorldChain, name: string, args: readonly unknown[]): Promise<Address> {
    const a = artifact(name);
    const hash = await c.wallet("owner").deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, account: ACCOUNTS.owner, chain: null });
    const receipt = await c.pub.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`deploy ${name} failed`);
    return receipt.contractAddress.toLowerCase() as Address;
  }

  async write(c: WorldChain, who: keyof typeof KEYS, address: Address, functionName: string, args: readonly unknown[], abi: Abi = adminAbi): Promise<Hex> {
    const hash = await c.wallet(who).writeContract({ address, abi, functionName, args, account: ACCOUNTS[who], chain: null });
    const receipt = await c.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    return hash;
  }

  private async deploy(key: ChainKey): Promise<void> {
    const c = this.chains[key];
    const owner = ACCOUNTS.owner.address;
    const home = CHAINS[key].alias === "home";
    const forwarder = await this.deployContract(c, "MockKeystoneForwarder", []);
    const ledger = await this.deployContract(c, "ConservationLedger", [forwarder, LOCAL_MOCK_MODE, CHAINS[key].selector, owner]);
    const quarantine = await this.deployContract(c, "QuarantineController", [ledger, owner]);
    const feed = await this.deployContract(c, "ConservationFeed", [ledger, TOKEN_ID, "KIRCHHOFF kETH status"]);
    const guard = await this.deployContract(c, "KirchhoffGuard", [quarantine, TOKEN_ID]);
    await this.write(c, "owner", ledger, "setQuarantineController", [quarantine]);
    await this.write(c, "owner", ledger, "registerToken", [TOKEN_ID, 120n]);
    await this.write(c, "owner", ledger, "setWorkflow", [SIM_WORKFLOW_ID, SIM_WORKFLOW_OWNER, "", ALL_REPORT_TYPES]);
    await this.write(c, "owner", quarantine, "configureToken", [TOKEN_ID, owner, 60n]);
    let token: Address;
    let escrow: Address | null = null;
    let registry: Address | null = null;
    let bridge: Address;
    let pool: Address;
    let lockbox: Address | null = null;
    const router = await this.deployContract(c, "LocalRouterMock", [owner]);
    const rmn = await this.deployContract(c, "LocalRMNMock", [owner]);
    const zero = "0x0000000000000000000000000000000000000000";
    if (home) {
      token = await this.deployContract(c, "KETH", [guard, owner]);
      escrow = await this.deployContract(c, "HomeEscrowAdapter", [token, owner]);
      bridge = await this.deployContract(c, "WeakBridge", [ACCOUNTS.verifier.address, "0x0000000000000000000000000000000000000000", escrow]);
      await this.write(c, "owner", escrow, "setBridge", [bridge]);
      registry = await this.deployContract(c, "KirchhoffRegistry", [600n, owner]);
      await this.write(c, "owner", registry, "registerToken", ["kETH", owner]);
      lockbox = await this.deployContract(c, "ERC20LockBox", [token]);
      pool = await this.deployContract(c, "KirchhoffLockReleaseTokenPool", [token, 18, zero, rmn, router, lockbox, ledger, quarantine, TOKEN_ID]);
    } else {
      token = await this.deployContract(c, "RemoteKETH", [owner]);
      bridge = await this.deployContract(c, "WeakBridge", [ACCOUNTS.verifier.address, token, "0x0000000000000000000000000000000000000000"]);
      await this.write(c, "owner", token, "grantMintAndBurnRoles", [bridge]);
      pool = await this.deployContract(c, "KirchhoffBurnMintTokenPool", [token, 18, zero, rmn, router, ledger, quarantine, TOKEN_ID]);
      await this.write(c, "owner", token, "grantMintAndBurnRoles", [pool]);
    }
    c.forwarder = forwarder;
    c.dep = {
      chain: key,
      chainId: CHAINS[key].localChainId,
      mode: "local",
      role: home ? "home" : "remote",
      tokenSymbol: "kETH",
      ledger,
      quarantine,
      feed,
      guard,
      registry,
      token,
      escrow,
      weakBridge: bridge,
      ccipPool: pool,
      ccipLockBox: lockbox,
      onRamp: null,
      offRamp: null,
      tokenAdminRegistry: null,
      lendingMarket: null,
      issuerSafe: owner.toLowerCase() as Address,
      deployedAtBlock: 0n,
    };
  }

  /** Real round trip leg: lock on home (or burn on a remote) through WeakBridge. Returns the message id. */
  async bridgeSend(from: ChainKey, to: ChainKey, amount: bigint): Promise<{ id: Hex; tx: Hex }> {
    const c = this.chains[from];
    const recipient = ACCOUNTS.user.address;
    if (c.dep.role === "home") {
      await this.write(c, "owner", c.dep.token, "mint", [recipient, amount]);
      await this.write(c, "user", c.dep.token, "approve", [c.dep.escrow, amount]);
    } else {
      await this.write(c, "user", c.dep.token, "approve", [c.dep.weakBridge, amount]);
    }
    const tx = await this.write(c, "user", must(c.dep.weakBridge), "send", [recipient, amount, CHAINS[to].selector]);
    const receipt = await c.pub.getTransactionReceipt({ hash: tx });
    const log = receipt.logs.find((l) => l.topics[0] === keccak256(stringToBytes("Burned(bytes32,address,address,uint256,uint64)")));
    if (!log?.topics[1]) throw new Error("no Burned log");
    return { id: log.topics[1], tx };
  }

  /** Verifier-signed WeakBridge credit. With an id that has no debit, this is the Kelp-style forgery. */
  async bridgeCredit(on: ChainKey, id: Hex, to: Address, amount: bigint, srcChain: ChainKey): Promise<Hex> {
    const c = this.chains[on];
    const signature = await ACCOUNTS.verifier.signTypedData({
      domain: { name: "WeakBridge", version: "1", chainId: c.dep.chainId, verifyingContract: must(c.dep.weakBridge) },
      types: { Credit: [{ name: "id", type: "bytes32" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "srcChain", type: "uint64" }] },
      primaryType: "Credit",
      message: { id, to, amount, srcChain: CHAINS[srcChain].selector },
    });
    return this.write(c, "attacker", must(c.dep.weakBridge), "credit", [id, to, amount, CHAINS[srcChain].selector, signature]);
  }

  private async report(key: ChainKey, reportType: number, payload: Hex): Promise<Hex> {
    const c = this.chains[key];
    const envelope = encodeAbiParameters(
      [{ type: "uint8" }, { type: "uint64" }, { type: "address" }, { type: "bytes32" }, { type: "bytes" }],
      [reportType, CHAINS[key].selector, c.dep.ledger, TOKEN_ID, payload],
    );
    const raw = concat([
      toHex(1, { size: 1 }),
      keccak256(toHex(`${key}:${Date.now()}:${Math.random()}`)),
      toHex(Math.floor(Date.now() / 1000), { size: 4 }),
      toHex(1, { size: 4 }),
      toHex(1, { size: 4 }),
      SIM_WORKFLOW_ID,
      pad("0x", { size: 10 }),
      SIM_WORKFLOW_OWNER,
      toHex(reportType, { size: 2 }),
      envelope,
    ]);
    return this.write(c, "owner", c.forwarder, "report", [c.dep.ledger, raw, "0x", []], forwarderAbi);
  }

  async epoch(key: ChainKey, epochId: bigint, delta: bigint, settled: readonly Hex[] = []): Promise<Hex> {
    const payload = encodeAbiParameters(
      [{ type: "uint64" }, { type: "int256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "uint16" }, { type: "bytes32[]" }],
      [epochId, delta, keccak256(toHex(`blocks:${epochId}`)), keccak256(toHex(`evidence:${epochId}`)), 1, 0, [...settled]],
    );
    return this.report(key, 1, payload);
  }

  async breach(key: ChainKey, p: { epochId: bigint; delta: bigint; evidenceHash: Hex; reason: number; offendingChain: ChainKey | null; offendingTx: Hex; recipient: Address; amount: bigint; messageId: Hex }): Promise<Hex> {
    const payload = encodeAbiParameters(
      [
        { type: "uint64" },
        { type: "int256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [p.epochId, p.delta, keccak256(toHex("blocks:breach")), p.evidenceHash, p.reason, p.offendingChain === null ? 0n : CHAINS[p.offendingChain].selector, p.offendingTx, p.recipient, p.amount, p.messageId],
    );
    return this.report(key, 2, payload);
  }

  async quarantine(key: ChainKey, incidentId: Hex, tainted: readonly Address[]): Promise<Hex> {
    const payload = encodeAbiParameters([{ type: "bytes32" }, { type: "address[]" }], [incidentId, [...tainted]]);
    return this.report(key, 3, payload);
  }
}
