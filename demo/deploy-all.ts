/**
 * demo/deploy-all.ts (TESTNET SIMULATION): deploys the full KIRCHHOFF suite to the three chains, deploys the 2-of-3
 * issuer Safe, wires CCIP lanes, seeds the demo supply, writes the engine-schema deployments doc plus the raw forge
 * records, generates the workflow configs, and (testnet) verifies contracts on Etherscan V2.
 *
 *   pnpm --filter @kirchhoff/demo deploy-all --network local|testnet [--no-verify] [--no-seed]
 *
 * Idempotent: the forge script reuses recorded addresses that still have code, the Safe is reused when already
 * deployed, lanes and seeds are only applied when missing.
 */
import { formatEther } from "viem";
import { addressUrl } from "./src/networks.ts";
import { account, connect, fundIfBelow, type Chain } from "./src/chain.ts";
import { parseArgs, main } from "./src/cli.ts";
import { connectAll, checkChainIds, loadContext } from "./src/context.ts";
import { genConfig } from "./src/cre.ts";
import {
  forgeNetwork,
  loadSet,
  mergedPath,
  readRaw,
  rawPath,
  toEngineDeployments,
  writeJson,
  writeState,
  readState,
  type DeploymentSet,
} from "./src/deployments.ts";
import { required } from "./src/env.ts";
import { log, stepEmitter } from "./src/events.ts";
import { forgeScript } from "./src/forge.ts";
import { network, ROLES, type ChainRole, type Network } from "./src/networks.ts";
import { ensureSafe, installSafeOnAnvil, SAFE, SAFE_SALT_NONCE, ownerAddresses, SAFE_THRESHOLD } from "./src/safe.ts";
import { seedAll } from "./src/supply.ts";
import { toHex } from "viem";

const REGISTRY_TIMELOCK_SECONDS = "600"; // testnet demo minimum (contracts README)
const RECOVERY_TIMELOCK_SECONDS = "60"; // short recovery window so reset stays under 3 minutes (task brief)

async function deployChain(net: Network, role: ChainRole, safe: string, verify: boolean): Promise<void> {
  const config = net.chains[role];
  const isLocal = net.name === "local";
  const env: Record<string, string> = {
    NETWORK: forgeNetwork(net.name, role),
    ROLE: role === "home" ? "home" : "remote",
    ISSUER_SAFE_ADDRESS: safe,
    WEAKBRIDGE_VERIFIER: required("WEAKBRIDGE_VERIFIER_ADDRESS"),
    DEPLOYER_PRIVATE_KEY: required("DEPLOYER_PRIVATE_KEY"),
    REGISTRY_TIMELOCK_SECONDS,
    RECOVERY_TIMELOCK_SECONDS,
    STALENESS_SECONDS: "120",
  };
  if (!isLocal) env.FORWARDER_MODE = "simulation";
  const chain = connect(config);
  const fee = await (async () => {
    const block = await chain.client.getBlock({ blockTag: "latest" });
    const base = block.baseFeePerGas ?? (await chain.client.getGasPrice());
    return { max: (base * 2n) + 1_000_000n, priority: isLocal ? 1_000_000_000n : 10_000_000n };
  })();
  await forgeScript({
    script: "script/Deploy.s.sol",
    rpcUrl: config.rpcUrl,
    env,
    broadcast: true,
    ...(verify && !isLocal ? { verify: { etherscanApiKey: required("ETHERSCAN_API_KEY") } } : {}),
    ...(isLocal ? {} : { gasPrice: fee }),
  });
  // Deploy.s.sol writes <forgeNetwork>.json; it already carries ccipOnRamp/offRamp via the address book only on
  // testnet. Inject the real 2.0.0 ramps (and local placeholders) so the engine schema always has them.
  injectRamps(net, role);
}

/** Adds ccipOnRamp / ccipOffRamp to the raw record (testnet: real 2.0.0 ramps; local: the deployer stands in). */
function injectRamps(net: Network, role: ChainRole): void {
  const raw = readRaw(net.name, role);
  if (raw === null) throw new Error(`forge wrote no record for ${role}`);
  const config = net.chains[role];
  const deployer = account("DEPLOYER").address;
  raw.ccipOnRamp = config.ccip?.onRamp ?? deployer;
  raw.ccipOffRamp = config.ccip?.offRamp ?? deployer;
  writeJson(rawPath(net.name, role), raw);
}

async function wireLanes(net: Network, role: ChainRole): Promise<void> {
  const config = net.chains[role];
  const remotes = ROLES.filter((r) => r !== role).map((r) => forgeNetwork(net.name, r));
  await forgeScript({
    script: "script/ConfigureLanes.s.sol",
    rpcUrl: config.rpcUrl,
    env: {
      NETWORK: forgeNetwork(net.name, role),
      REMOTE_NETWORKS: remotes.join(","),
      DEPLOYER_PRIVATE_KEY: required("DEPLOYER_PRIVATE_KEY"),
    },
    broadcast: true,
    ...(net.name === "local" ? {} : { gasPrice: await testnetFee(connect(config)) }),
  });
}

async function testnetFee(chain: Chain): Promise<{ max: bigint; priority: bigint }> {
  const block = await chain.client.getBlock({ blockTag: "latest" });
  const base = block.baseFeePerGas ?? (await chain.client.getGasPrice());
  return { max: base * 2n + 1_000_000n, priority: 10_000_000n };
}

function writeMerged(net: Network, set: DeploymentSet): void {
  const engine = toEngineDeployments(net, set);
  writeJson(mergedPath(net.name), engine);
  log(`wrote ${mergedPath(net.name)} (engine schema, validated)`);
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { options: [], flags: ["no-verify", "no-seed"] });
  const net = network(args.network);
  const emit = stepEmitter(net.name);
  const verify = !args.flags.has("no-verify");
  emit({ step: "deploy-all", status: "started", detail: { network: net.name, verify } });

  const chains = connectAll(net);
  await checkChainIds(chains);

  // 1. Issuer Safe (same address on all three chains).
  let safeAddress = "";
  for (const role of ROLES) {
    const chain = chains[role];
    if (net.name === "local") await installSafeOnAnvil(chain);
    const { address, sent } = await ensureSafe(chain);
    safeAddress = address;
    emit({ step: "safe", status: "ok", chain: role, title: `issuer Safe 2-of-3 ${address}`, txHash: sent?.hash ?? null, explorerUrl: addressUrl(chain.config, address) });
  }
  log(`issuer Safe: ${safeAddress}`);

  // 2. Deploy the suite per chain, then wire lanes once all three exist.
  for (const role of ROLES) {
    await deployChain(net, role, safeAddress, verify);
    emit({ step: "deploy", status: "ok", chain: role, title: `${net.chains[role].label} suite deployed` });
  }
  const set = loadSet(net.name);
  for (const role of ROLES) {
    await wireLanes(net, role);
    emit({ step: "lanes", status: "ok", chain: role, title: `CCIP lanes wired from ${role}` });
  }

  // 3. Merged engine-schema doc + workflow configs.
  writeMerged(net, set);
  emit({ step: "deployments", status: "ok", title: `deployments/${net.name}.json written` });
  await genConfig(net.name).catch((e: unknown) => {
    log(`gen-config failed (workflows may still be in progress): ${e instanceof Error ? e.message : String(e)}`);
    emit({ step: "gen-config", status: "skipped", detail: { reason: "workflow configs not generated" } });
  });

  // 4. Seed supply (demo admin paths).
  if (!args.flags.has("no-seed")) {
    const seedCtx = await loadContext(net.name);
    const sents = await seedAll(seedCtx);
    emit({ step: "seed", status: "ok", title: "seeded 250k escrow / 180k arb / 70k base", detail: { txs: sents.length } });
  }

  // 5. Save demo state (Safe parameters for reset).
  const state = readState(net.name);
  state.safe = { address: safeAddress as `0x${string}`, owners: ownerAddresses(), threshold: SAFE_THRESHOLD, saltNonce: toHex(SAFE_SALT_NONCE, { size: 32 }), singleton: SAFE.singletonL2, factory: SAFE.factory, fallbackHandler: SAFE.fallbackHandler };
  writeState(state);

  // 6. Top up the attacker and CRE signer minimally for the demo (testnet only).
  if (net.name === "testnet") {
    for (const role of ROLES) {
      const chain = chains[role];
      await fundIfBelow(chain, account("ATTACKER").address, 1_000_000_000_000_000n, 2_000_000_000_000_000n, `attacker on ${role}`).catch(() => null);
    }
  }

  emit({ step: "deploy-all", status: "ok", title: `KIRCHHOFF deployed to ${net.name}`, detail: { safe: safeAddress } });
  for (const role of ROLES) {
    const chain = chains[role];
    const bal = await chain.client.getBalance({ address: account("DEPLOYER").address });
    log(`${chain.config.label}: deployer balance ${formatEther(bal)} ETH`);
  }
}

main(run);
