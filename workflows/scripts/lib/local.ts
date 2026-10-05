import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_CHAINS, type Hex } from "@kirchhoff/engine";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DeployRecord } from "./deployments.ts";

export type Alias = "home" | "arb" | "base";

export type LocalChain = {
  alias: Alias;
  name: string;
  selector: bigint;
  chainId: number;
  rpc: string;
  /** Where `cre workflow simulate --broadcast` sends reports for this chain (docs/research/cre.md section 3). */
  simulatorForwarder: Hex;
  chain: Chain;
  public: PublicClient<Transport, Chain>;
};

const OFFSET: Readonly<Record<Alias, number>> = { home: 0, arb: 1, base: 2 };
const SIMULATOR_FORWARDERS: Readonly<Record<Alias, Hex>> = {
  home: "0x15fC6ae953E024d975e77382eEeC56A9101f9F88",
  arb: "0xd41263567ddfead91504199b8c6c87371e83ca5d",
  base: "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5",
};
export const MULTICALL3: Hex = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** The three local chains; `basePort` 8545 is demo/anvil-up.sh, 18545 the harness's private chains. */
export function localChains(basePort = 8545): LocalChain[] {
  return (["home", "arb", "base"] as const).map((alias) => {
    const known = KNOWN_CHAINS.find((c) => c.defaultAlias === alias);
    if (known === undefined) throw new Error(`no known chain for ${alias}`);
    const rpc = `http://127.0.0.1:${(basePort + OFFSET[alias]).toString()}`;
    const chain = defineChain({
      id: known.localChainId,
      name: `anvil-${alias}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    });
    return {
      alias,
      name: known.name,
      selector: known.selector,
      chainId: known.localChainId,
      rpc,
      simulatorForwarder: SIMULATOR_FORWARDERS[alias],
      chain,
      public: createPublicClient({ chain, transport: http(rpc) }),
    };
  });
}

/**
 * Starts fresh Anvil chains on basePort..basePort+2 with the local chain ids and 1 s blocks (so block timestamps
 * are real time, which the latency scenario measures). Fails if a port is already taken: the harness never reuses
 * chains it did not start.
 */
export async function startAnvils(basePort: number, repo: string): Promise<ChildProcess[]> {
  const procs = localChains(basePort).map((c) =>
    spawn("anvil", ["--port", String(basePort + OFFSET[c.alias]), "--chain-id", String(c.chainId), "--block-time", "1", "--silent"], {
      cwd: repo,
      stdio: "ignore",
    }),
  );
  for (const c of localChains(basePort)) {
    for (let i = 0; ; i++) {
      try {
        await c.public.getChainId();
        break;
      } catch (e) {
        if (i > 100) throw new Error(`anvil on ${c.rpc} did not start`, { cause: e });
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
  return procs;
}

export function wallet(chain: LocalChain, key: Hex): WalletClient<Transport, Chain, Account> {
  return createWalletClient({ chain: chain.chain, transport: http(chain.rpc), account: privateKeyToAccount(key) });
}

type AnvilRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

export function anvil(chain: LocalChain): AnvilRpc {
  return async (method, params) => {
    const response = await fetch(chain.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (body.error !== undefined) throw new Error(`${chain.alias} ${method}: ${body.error.message}`);
    return body.result;
  };
}

/** Mines `blocks` blocks on every chain so everything written so far is below the `finalized` tag (head - 64). */
export async function mineToFinality(chains: readonly LocalChain[], blocks = 70): Promise<void> {
  await Promise.all(chains.map((c) => anvil(c)("anvil_mine", [`0x${blocks.toString(16)}`])));
}

function deployedRuntime(artifact: string): Hex {
  const json = JSON.parse(readFileSync(artifact, "utf8")) as { deployedBytecode: { object: string } };
  return json.deployedBytecode.object as Hex;
}

/**
 * Installs the infrastructure a fresh Anvil chain lacks but the simulator expects: canonical Multicall3, and
 * our MockKeystoneForwarder (same behavior as Chainlink's deployed simulation mock) at the simulator's built-in
 * forwarder address for the chain's selector. Funds the given accounts (the CRE simulation key sends the report
 * txs).
 */
export async function installInfra(chains: readonly LocalChain[], repo: string, fund: readonly Hex[]): Promise<void> {
  const multicall = readFileSync(join(repo, "workflows/scripts/fixtures/multicall3.runtime.hex"), "utf8").trim();
  const forwarder = deployedRuntime(join(repo, "contracts/out/MockKeystoneForwarder.sol/MockKeystoneForwarder.json"));
  for (const chain of chains) {
    const rpc = anvil(chain);
    await rpc("anvil_setCode", [MULTICALL3, multicall]);
    await rpc("anvil_setCode", [chain.simulatorForwarder, forwarder]);
    for (const account of fund) await rpc("anvil_setBalance", [account, "0x56BC75E2D63100000"]);
  }
}

export type LocalDeployment = { network: string; records: Record<Alias, DeployRecord & Record<string, unknown>> };

/**
 * Deploys a fresh KIRCHHOFF suite on all three chains with contracts/script/Deploy.s.sol (local forwarder mode,
 * forwarder = the simulator's address) and wires the CCIP pools with ConfigureLanes.s.sol. Each scenario uses its
 * own network name, so every scenario starts from UNKNOWN ledgers and zero supply.
 */
export async function deploySuite(
  chains: readonly LocalChain[],
  repo: string,
  network: string,
  env: { deployerKey: Hex; issuer: Hex; verifier: Hex },
  log: (line: string) => void,
): Promise<LocalDeployment> {
  const contracts = join(repo, "contracts");
  const run = promisify(execFile);
  const forge = async (args: string[], extra: Record<string, string>): Promise<void> => {
    log(`$ ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ")} forge ${args.join(" ")}`);
    // Deploy.s.sol and ConfigureLanes.s.sol are idempotent, so a run that lost a nonce race (another process using
    // the same deployer on the shared Anvil chains) is retried and only does what is still missing.
    for (let attempt = 1; ; attempt++) {
      try {
        await run("forge", args, {
          cwd: contracts,
          env: { ...process.env, ...extra, DEPLOYER_PRIVATE_KEY: env.deployerKey },
          maxBuffer: 64 * 1024 * 1024,
        });
        return;
      } catch (e) {
        const failed = e as { stdout?: string; stderr?: string; message: string };
        const detail = `${failed.stderr ?? ""}${failed.stdout ?? ""}`.split("\n").filter((l) => /error|revert|nonce/i.test(l)).slice(0, 8).join("\n");
        if (attempt >= 3) throw new Error(`${failed.message}\n${detail}`, { cause: e });
        log(`forge attempt ${attempt} failed, retrying: ${detail}`);
      }
    }
  };
  // The three chains are independent, so their deployments run in parallel.
  await Promise.all(
    chains.map((chain) =>
      forge(["script", "script/Deploy.s.sol", "--rpc-url", chain.rpc, "--broadcast", "--slow"], {
        NETWORK: `${network}-${chain.alias}`,
        ROLE: chain.alias === "home" ? "home" : "remote",
        ISSUER_SAFE_ADDRESS: env.issuer,
        WEAKBRIDGE_VERIFIER: env.verifier,
        KEYSTONE_FORWARDER: chain.simulatorForwarder,
        // Scenarios mine blocks to reach finality, which also advances time; keep fresh statuses fresh.
        STALENESS_SECONDS: "86400",
        REGISTRY_TIMELOCK_SECONDS: "600",
        RECOVERY_TIMELOCK_SECONDS: "600",
      }),
    ),
  );
  await Promise.all(
    chains.map((chain) =>
      forge(["script", "script/ConfigureLanes.s.sol", "--rpc-url", chain.rpc, "--broadcast", "--slow"], {
        NETWORK: `${network}-${chain.alias}`,
        REMOTE_NETWORKS: chains.filter((c) => c.alias !== chain.alias).map((c) => `${network}-${c.alias}`).join(","),
      }),
    ),
  );
  const records = {} as Record<Alias, DeployRecord & Record<string, unknown>>;
  for (const chain of chains) {
    records[chain.alias] = JSON.parse(readFileSync(join(repo, "deployments", `${network}-${chain.alias}.json`), "utf8")) as DeployRecord &
      Record<string, unknown>;
  }
  return { network, records };
}

/** Compiles and deploys the scenario-only LocalOffRamp (scripts/sol) on one chain; returns its address. */
export function deployLocalOffRamp(repo: string, chain: LocalChain, deployerKey: Hex): Hex {
  const out = mkdtempSync(join(tmpdir(), "kirchhoff-offramp-"));
  try {
    const stdout = execFileSync(
      "forge",
      [
        "create",
        "--root",
        join(repo, "workflows/scripts/sol"),
        "--out",
        join(out, "out"),
        "--cache-path",
        join(out, "cache"),
        "--rpc-url",
        chain.rpc,
        "--private-key",
        deployerKey,
        "--broadcast",
        "LocalOffRamp.sol:LocalOffRamp",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const match = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(stdout);
    if (match?.[1] === undefined) throw new Error(`forge create printed no address:\n${stdout}`);
    return match[1] as Hex;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export const LOCAL_ROUTER_ABI = parseAbi(["function setOffRamp(uint64 sourceChainSelector, address offRamp, bool allowed)"]);

/** Writes a record back (the scenario adds the LocalOffRamp it deployed as the chain's CCIP ramp). */
export function writeRecord(repo: string, network: string, alias: Alias, record: Record<string, unknown>): void {
  writeFileSync(join(repo, "deployments", `${network}-${alias}.json`), `${JSON.stringify(record, null, 2)}\n`);
}
