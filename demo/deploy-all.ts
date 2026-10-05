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
import { account, connect, fundIfBelow, HOME_TESTNET_FEE, type Chain } from "./src/chain.ts";
import { verifyAll } from "./src/verify.ts";
import { activateSpec, specParameters } from "./src/spec.ts";
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
import { privateKey, required } from "./src/env.ts";
import { installLocalInfra, mineLocal, simulatorForwarder } from "./src/local.ts";
import { privateKeyToAccount } from "viem/accounts";
import { log, stepEmitter } from "./src/events.ts";
import { forgeScript } from "./src/forge.ts";
import { network, ROLES, type ChainRole, type Network } from "./src/networks.ts";
import { ensureSafe, installSafeOnAnvil, SAFE, SAFE_SALT_NONCE, ownerAddresses, SAFE_THRESHOLD } from "./src/safe.ts";
import { seedAll } from "./src/supply.ts";
import { toHex } from "viem";

const REGISTRY_TIMELOCK_SECONDS = "600"; // testnet demo minimum (contracts README)

async function deployChain(net: Network, role: ChainRole, safe: string): Promise<void> {
  const config = net.chains[role];
  const isLocal = net.name === "local";
  const params = specParameters();
  const env: Record<string, string> = {
    NETWORK: forgeNetwork(net.name, role),
    ROLE: role === "home" ? "home" : "remote",
    ISSUER_SAFE_ADDRESS: safe,
    WEAKBRIDGE_VERIFIER: required("WEAKBRIDGE_VERIFIER_ADDRESS"),
    DEPLOYER_PRIVATE_KEY: required("DEPLOYER_PRIVATE_KEY"),
    REGISTRY_TIMELOCK_SECONDS,
    // Owned by the KIRCH-SPEC (engine/specs/kETH.yaml), never by env. One-shot at token configuration: an existing
    // deployment keeps what it was configured with (the issuer Safe can change it later).
    RECOVERY_TIMELOCK_SECONDS: params.recoveryTimelockSeconds.toString(),
    STALENESS_SECONDS: params.stalenessSeconds.toString(),
  };
  if (isLocal) env.KEYSTONE_FORWARDER = simulatorForwarder(role);
  else env.FORWARDER_MODE = "simulation";
  await forgeScript({
    script: "script/Deploy.s.sol",
    rpcUrls: config.rpcUrls,
    env,
    broadcast: true,
    ...(isLocal ? {} : { gasPrice: await testnetFee(connect(config)) }),
  });
  // Deploy.s.sol writes <forgeNetwork>.json; it already carries ccipOnRamp/offRamp via the address book only on
  // testnet. Inject the real 2.0.0 ramps (and local placeholders) so the engine schema always has them.
  injectRamps(net, role);
}

/** Adds ccipOnRamp / ccipOffRamp to the raw record (testnet: real 2.0.0 ramps; local: the LocalRouterMock). */
function injectRamps(net: Network, role: ChainRole): void {
  const raw = readRaw(net.name, role);
  if (raw === null) throw new Error(`forge wrote no record for ${role}`);
  const config = net.chains[role];
  const router = String(raw.ccipRouter);
  raw.ccipOnRamp = config.ccip?.onRamp ?? router;
  raw.ccipOffRamp = config.ccip?.offRamp ?? router;
  writeJson(rawPath(net.name, role), raw);
}

async function wireLanes(net: Network, role: ChainRole): Promise<void> {
  const config = net.chains[role];
  const remotes = ROLES.filter((r) => r !== role).map((r) => forgeNetwork(net.name, r));
  await forgeScript({
    script: "script/ConfigureLanes.s.sol",
    rpcUrls: config.rpcUrls,
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
  if (chain.config.role === "home") return { max: HOME_TESTNET_FEE.maxFeePerGas, priority: HOME_TESTNET_FEE.maxPriorityFeePerGas };
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
  if (net.name === "local") {
    // Simulator forwarders + Multicall3, and gas for the CRE simulation key (workflows/scripts/lib/local.ts).
    await installLocalInfra([account("DEPLOYER").address, account("ATTACKER").address, privateKeyToAccount(privateKey("CRE_ETH_PRIVATE_KEY")).address]);
  }

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
    await deployChain(net, role, safeAddress);
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
  if (net.name === "local") await mineLocal();

  // 5. Save demo state (Safe parameters for reset).
  const state = readState(net.name);
  state.safe = { address: safeAddress as `0x${string}`, owners: ownerAddresses(), threshold: SAFE_THRESHOLD, saltNonce: toHex(SAFE_SALT_NONCE, { size: 32 }), singleton: SAFE.singletonL2, factory: SAFE.factory, fallbackHandler: SAFE.fallbackHandler };
  writeState(state);

  // 6. PRD section 6 spec lifecycle: Safe proposes, registry timelock, permissionless activate (idempotent). Without an
  //    active spec the Judge answers UNKNOWN_TOKEN for every kETH message.
  await activateSpec(await loadContext(net.name), emit);

  // 7. Verify every deployed contract on Etherscan V2 and Blockscout (testnet, free).
  if (net.name === "testnet" && verify) await verifyAll(net, emit);

  // 8. Strict-minimum gas for the attacker's own demo txs (testnet). The Safe owners sign offchain and the deployer
  //    relays, so they need none. Home budget: forged credit ~150k + 3 expected reverts reserved at 400k each, sent
  //    one at a time + the reset's return transfer ~60k, at the 1.3 gwei cap.
  if (net.name === "testnet") {
    const target: Record<ChainRole, bigint> = { home: 1_200_000_000_000_000n, arb: 100_000_000_000_000n, base: 100_000_000_000_000n };
    for (const role of ROLES) {
      const sent = await fundIfBelow(chains[role], account("ATTACKER").address, target[role], target[role], `attacker on ${role}`);
      if (sent !== null) emit({ step: "fund", status: "ok", chain: role, title: `attacker funded to ${formatEther(target[role])} ETH`, txHash: sent.hash, explorerUrl: sent.url });
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
