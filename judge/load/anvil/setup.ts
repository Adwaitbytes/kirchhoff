/**
 * Second half of the Anvil load-test setup (after setup.sh). Uses only Anvil dev account #9.
 *
 *   node load/anvil/setup.ts
 *
 * Proposes the spec hash, advances the private home chain past the registry's 10 minute minimum
 * timelock (anvil_increaseTime: these chains belong to this test alone), activates it, posts a
 * CONSERVED epoch on all three ledgers, emits the debit, and verifies each step by reading it back.
 * Writes load/anvil/out/{deployments.json,payload.json,judge.env}.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Reason, ReportType, Status, encodeReport, type Hex } from "@kirchhoff/engine";
import {
  concatHex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  numberToHex,
  pad,
  parseAbi,
  toHex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TOPIC_CCIP_MESSAGE_SENT, TOPIC_LOCKED_OR_BURNED } from "../../src/abi.ts";
import { loadTokens } from "../../src/spec-cache.ts";
import { AMOUNT, ARB, BASE, HOME, SENDER, SPEC_PATH, kethRequest } from "../../test/helpers/harness.ts";

const here = (f: string): string => fileURLToPath(new URL(f, import.meta.url));
const ACCOUNT = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");
const SIM_WORKFLOW_ID: Hex = `0x${"11".repeat(32)}`;
const SIM_WORKFLOW_OWNER: Hex = `0x${"aa".repeat(20)}`;

type Record_ = Record<string, string>;
const read = (alias: string): Record_ => JSON.parse(readFileSync(here(`./out/${alias}.json`), "utf8")) as Record_;
const emitters = JSON.parse(readFileSync(here("./out/emitters.json"), "utf8")) as { pool: Hex; onRamp: Hex };

const CHAINS = [
  { alias: "home", name: "ethereum-testnet-sepolia", selector: HOME, chainId: 31337, port: 28545, rec: read("home") },
  { alias: "arb", name: "ethereum-testnet-sepolia-arbitrum-1", selector: ARB, chainId: 31338, port: 28546, rec: read("arb") },
  { alias: "base", name: "ethereum-testnet-sepolia-base-1", selector: BASE, chainId: 31339, port: 28547, rec: read("base") },
] as const;

function get(rec: Record_, key: string): Hex {
  const v = rec[key];
  if (v === undefined) throw new Error(`deployment record lacks ${key}`);
  return v.toLowerCase() as Hex;
}

/** Engine deployments format; the arb CCIP pool and OnRamp are the LogEmitter stand-ins. */
function deployments(): unknown {
  const chains: Record<string, unknown> = {};
  for (const c of CHAINS) {
    const isHome = c.alias === "home";
    const isArb = c.alias === "arb";
    chains[c.name] = {
      chainId: c.chainId,
      ledger: get(c.rec, "conservationLedger"),
      quarantine: get(c.rec, "quarantineController"),
      feed: get(c.rec, "conservationFeed"),
      ...(isHome ? { registry: get(c.rec, "kirchhoffRegistry") } : {}),
      ccip: { onRamp: isArb ? emitters.onRamp.toLowerCase() : get(c.rec, "ccipRouter"), offRamp: get(c.rec, "ccipRouter") },
      tokens: {
        kETH: {
          token: get(c.rec, isHome ? "kETH" : "remoteKETH"),
          ...(isHome ? { escrow: get(c.rec, "homeEscrowAdapter"), lockbox: get(c.rec, "ccipLockBox") } : {}),
          bridges: {
            ccip: isArb ? emitters.pool.toLowerCase() : get(c.rec, "kirchhoffTokenPool"),
            weakbridge: get(c.rec, isHome ? "homeEscrowAdapter" : "weakBridge"),
          },
        },
      },
    };
  }
  return { network: "judge-load-anvil", chains };
}

function clients(port: number) {
  const transport = http(`http://127.0.0.1:${port}`);
  return { pub: createPublicClient({ transport }), wallet: createWalletClient({ account: ACCOUNT, transport }) };
}

async function send(port: number, to: Address, data: Hex): Promise<Hex> {
  const { pub, wallet } = clients(port);
  const hash = await wallet.sendTransaction({ to, data, chain: null });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
  return hash;
}

const REGISTRY = parseAbi([
  "function proposeSpec(bytes32 tokenId, bytes32 specHash, string specURI)",
  "function activateSpec(bytes32 tokenId)",
]);
const FORWARDER = parseAbi(["function report(address receiver, bytes rawReport, bytes context, bytes[] signatures)"]);
const EMITTER = parseAbi([
  "function emit2Then(bytes32 t0, bytes32 t1, bytes data, address next, bytes nextCall)",
  "function emit4(bytes32 t0, bytes32 t1, bytes32 t2, bytes32 t3, bytes data)",
]);

/** KeystoneForwarder raw report: version | execId | ts | don | donCfg | workflowId | name | owner | reportId | report. */
function rawReport(report: Hex, epochId: bigint): Hex {
  return concatHex([
    "0x01",
    pad(numberToHex(epochId), { size: 32 }),
    pad(numberToHex(Math.floor(Date.now() / 1000)), { size: 4 }),
    pad("0x01", { size: 4 }),
    pad("0x01", { size: 4 }),
    SIM_WORKFLOW_ID,
    pad("0x00", { size: 10 }),
    SIM_WORKFLOW_OWNER,
    "0x0001",
    report,
  ]);
}

const LEDGER_READ = parseAbi([
  "function statusOf(bytes32 tokenId) view returns (uint8 status, int256 delta, uint64 updatedAt, bool stale)",
]);
const REGISTRY_READ = parseAbi(["function activeSpecHash(bytes32 tokenId) view returns (bytes32)"]);

async function requireCode(port: number, address: Address, what: string): Promise<void> {
  const code = await clients(port).pub.getCode({ address });
  if (code === undefined || code === "0x") throw new Error(`${what} ${address} has no code on port ${port.toString()}: rerun setup.sh`);
}

async function main(): Promise<void> {
  const deploymentsPath = here("./out/deployments.json");
  writeFileSync(deploymentsPath, `${JSON.stringify(deployments(), null, 2)}\n`);
  const [token] = loadTokens([SPEC_PATH], deploymentsPath);
  if (token === undefined) throw new Error("no token");
  const home = CHAINS[0];
  const registry = get(home.rec, "kirchhoffRegistry");
  for (const c of CHAINS) {
    await requireCode(c.port, get(c.rec, "conservationLedger"), "ledger");
    await requireCode(c.port, get(c.rec, "mockKeystoneForwarder"), "forwarder");
  }
  await requireCode(home.port, registry, "registry");
  await requireCode(CHAINS[1].port, emitters.pool, "pool emitter");
  await requireCode(CHAINS[1].port, emitters.onRamp, "onramp emitter");

  await send(home.port, registry, encodeFunctionData({
    abi: REGISTRY,
    functionName: "proposeSpec",
    args: [token.tokenId, token.cachedSpecHash, "file://engine/specs/kETH.yaml#judge-load-anvil"],
  }));
  const { pub } = clients(home.port);
  const anvil = createTestClient({ mode: "anvil", transport: http(`http://127.0.0.1:${home.port.toString()}`) });
  await anvil.increaseTime({ seconds: 601 });
  await anvil.mine({ blocks: 1 });
  await send(home.port, registry, encodeFunctionData({ abi: REGISTRY, functionName: "activateSpec", args: [token.tokenId] }));
  const active = await pub.readContract({ address: registry, abi: REGISTRY_READ, functionName: "activeSpecHash", args: [token.tokenId] });
  if (active.toLowerCase() !== token.cachedSpecHash) throw new Error(`registry active ${active} != cached ${token.cachedSpecHash}`);

  const epochId = BigInt(Math.floor(Date.now() / 1000));
  for (const c of CHAINS) {
    const ledger = get(c.rec, "conservationLedger");
    const report = encodeReport({
      reportType: ReportType.EPOCH,
      chainSelector: c.selector,
      ledger,
      tokenId: token.tokenId,
      payload: {
        epochId,
        delta: 0n,
        blocksHash: `0x${"00".repeat(32)}`,
        evidenceHash: `0x${"00".repeat(32)}`,
        status: Status.CONSERVED,
        reason: Reason.OK,
        settledMessageIds: [],
      },
    });
    await send(c.port, get(c.rec, "mockKeystoneForwarder"), encodeFunctionData({
      abi: FORWARDER,
      functionName: "report",
      args: [ledger, rawReport(report, epochId), "0x", []],
    }));
    const [status, , , stale] = await clients(c.port).pub.readContract({ address: ledger, abi: LEDGER_READ, functionName: "statusOf", args: [token.tokenId] });
    if (status !== Status.CONSERVED || stale) throw new Error(`${c.alias} ledger status ${status.toString()} stale=${String(stale)} after EPOCH`);
  }

  // The CCIP 2.0.0 debit for the load-test message, from arb to home, in one transaction.
  const arb = token.chains.get(ARB);
  if (arb === undefined) throw new Error("no arb");
  const messageId: Hex = `0x${"5a".repeat(32)}`;
  const u64 = (v: bigint): Hex => pad(toHex(v), { size: 32 });
  const sent = encodeFunctionData({
    abi: EMITTER,
    functionName: "emit4",
    args: [TOPIC_CCIP_MESSAGE_SENT, u64(HOME), pad(SENDER, { size: 32 }), messageId, "0x"],
  });
  const hash = await send(CHAINS[1].port, emitters.pool, encodeFunctionData({
    abi: EMITTER,
    functionName: "emit2Then",
    args: [
      TOPIC_LOCKED_OR_BURNED,
      u64(HOME),
      encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [arb.token, emitters.onRamp, AMOUNT]),
      emitters.onRamp,
      sent,
    ],
  }));
  const receipt = await clients(CHAINS[1].port).pub.getTransactionReceipt({ hash });
  if (receipt.logs.length !== 2) throw new Error(`debit tx emitted ${receipt.logs.length.toString()} logs, expected 2`);

  const request = kethRequest(token);
  request.message_id = messageId;
  request.source_tx_hash = hash;
  request.source_block_number = Number(receipt.blockNumber);
  request.finalized_block_number = Number(receipt.blockNumber);
  request.block_depth = 0;
  writeFileSync(here("./out/payload.json"), `${JSON.stringify(request)}\n`);
  // Provider 2 is a second Anvil node per chain, forked from provider 1 after this setup (forks.sh, port + 10):
  // separate processes with the same state, so each "provider" carries its own load.
  const env = CHAINS.flatMap((c) => {
    const prefix = { home: "RPC_ETH_SEPOLIA", arb: "RPC_ARB_SEPOLIA", base: "RPC_BASE_SEPOLIA" }[c.alias];
    return [`${prefix}_1=http://127.0.0.1:${c.port.toString()}`, `${prefix}_2=http://127.0.0.1:${(c.port + 10).toString()}`];
  });
  writeFileSync(here("./out/judge.env"), `${env.join("\n")}\nJUDGE_SPEC_PATH=${SPEC_PATH}\nJUDGE_DEPLOYMENTS_PATH=${deploymentsPath}\n`);
  process.stdout.write(`activated spec, CONSERVED epoch ${epochId.toString()} on 3 chains, debit tx ${hash} block ${receipt.blockNumber.toString()}\n`);
}

await main();
