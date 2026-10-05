/**
 * PRD section 17 "Workflows" layer: the six scripted scenarios, run through `cre workflow simulate --broadcast`
 * against the three local Anvil chains (demo/anvil-up.sh), with every outcome asserted on the ledgers onchain.
 *
 *   pnpm --filter @kirchhoff/workflows scenarios [--only 1,3]
 *
 * Each scenario deploys a fresh suite (contracts/script/Deploy.s.sol + ConfigureLanes.s.sol) under its own network
 * name, compiles its own configs with the engine compiler (gen-config --out .scn/<network>, passed to every
 * simulation with --config, so the shared config.local.json other tools use is never touched), activates the
 * compiled spec in the local KirchhoffRegistry through the issuer, and starts from an UNKNOWN ledger
 * that a first W2 epoch moves to CONSERVED. Commands, workflow logs and assertions are written into
 * SIMULATION_LOG.md between the scenario markers.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Reason, Status, type Hex } from "@kirchhoff/engine";
import { decodeEventLog, keccak256, parseAbi, parseEther, toHex, type Log, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { w1ConfigSchema, w2ConfigSchema, w4ConfigSchema } from "../src/config.ts";
import { creditTriggerGroups } from "../src/w1.ts";
import { watchedChains } from "../src/w4.ts";
import { buildWasm, simulate, simulateCommand, type SimulateArgs, type SimulateResult } from "./lib/cre.ts";
import { loadEnv, privateKey } from "./lib/env.ts";
import {
  deployLocalOffRamp,
  deploySuite,
  anvil,
  installInfra,
  startAnvils,
  LOCAL_ROUTER_ABI,
  localChains,
  mineToFinality,
  wallet,
  writeRecord,
  type Alias,
  type LocalChain,
  type LocalDeployment,
} from "./lib/local.ts";

const WORKFLOWS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WORKFLOWS, "..");
const env = loadEnv(join(REPO, ".env"));
/**
 * The harness's own Anvil-only keys, derived from fixed labels and funded with anvil_setBalance. The .env testnet
 * deployer is shared with other processes (demo/deploy-all) on the same Anvil chains, and concurrent use of one
 * key races nonces. These keys are public by construction and must never hold value anywhere.
 */
const harnessKey = (label: string): Hex => keccak256(toHex(`kirchhoff/workflows/scenarios/${label}`));
const DEPLOYER = harnessKey("deployer");
const ATTACKER = harnessKey("attacker");
const VERIFIER = harnessKey("weakbridge-verifier");
const CRE_KEY = privateKey(env, "CRE_ETH_PRIVATE_KEY");
const user = privateKeyToAccount(DEPLOYER).address;
const attacker = privateKeyToAccount(ATTACKER).address;
const verifier = privateKeyToAccount(VERIFIER);
const TOKEN_ID = keccak256(toHex("kETH"));

/** Private chains for the harness (project.yaml target `scenarios`); see startAnvils. */
const TARGET = "scenarios";
const BASE_PORT = 18545;
const anvils = await startAnvils(BASE_PORT, REPO);
process.on("exit", () => {
  for (const p of anvils) p.kill();
});
const chains = localChains(BASE_PORT);
const byAlias = (alias: Alias): LocalChain => {
  const c = chains.find((x) => x.alias === alias);
  if (c === undefined) throw new Error(`no chain ${alias}`);
  return c;
};

const TOKEN_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function grantMintRole(address minter)",
]);
const BRIDGE_ABI = parseAbi([
  "function send(address to, uint256 amount, uint64 dstChain) returns (bytes32)",
  "function credit(bytes32 id, address to, uint256 amount, uint64 srcChain, bytes signature)",
  "function creditDigest(bytes32 id, address to, uint256 amount, uint64 srcChain) view returns (bytes32)",
  "event Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)",
  "event Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain)",
]);
const LEDGER_ABI = parseAbi([
  "struct Breach { bytes32 tokenId; uint64 epochId; int256 delta; bytes32 blocksHash; bytes32 evidenceHash; uint16 reason; uint64 offendingChain; bytes32 offendingTx; address recipient; uint256 amount; bytes32 messageId; uint64 recordedAt; }",
  "struct Epoch { uint64 epochId; int256 delta; uint64 evaluatedAt; bytes32 blocksHash; bytes32 evidenceHash; uint8 status; uint16 reason; }",
  "function statusOf(bytes32 tokenId) view returns (uint8 status, int256 delta, uint64 updatedAt, bool stale)",
  "function latestEpoch(bytes32 tokenId) view returns (Epoch)",
  "function activeIncident(bytes32 tokenId) view returns (bytes32)",
  "function breachOf(bytes32 incidentId) view returns (Breach)",
  "function isConsumed(bytes32 messageId) view returns (bool)",
  "event BreachRecorded(bytes32 indexed tokenId, uint16 reason, bytes32 evidenceHash, uint64 offendingChain, bytes32 offendingTx, address recipient, uint256 amount)",
]);
const REGISTRY_ABI = parseAbi([
  "function proposeSpec(bytes32 tokenId, bytes32 specHash, string specURI)",
  "function activateSpec(bytes32 tokenId)",
]);
const OFFRAMP_ABI = parseAbi([
  "function execute(address pool, uint64 sourceChainSelector, bytes32 messageId, address receiver, uint256 amount, address localToken, address sourcePool)",
  "event ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed messageNumber, bytes32 indexed messageId, uint8 state, bytes returnData)",
]);

// ---------------------------------------------------------------- log

const log: string[] = [];
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
  log.push(line);
};

class AssertionFailed extends Error {
  override readonly name = "AssertionFailed";
}
function check(condition: boolean, what: string): void {
  say(`${condition ? "PASS" : "FAIL"}  ${what}`);
  if (!condition) throw new AssertionFailed(what);
}

// ---------------------------------------------------------------- suite

type Suite = {
  deployment: LocalDeployment;
  addr: (alias: Alias, key: string) => Hex;
  offRamp: Hex;
};

const RUN = Date.now().toString(36);

async function freshSuite(n: number): Promise<Suite> {
  const network = `wfs${RUN}s${n}`;
  say(`\n#### Setup: fresh suite \`${network}\``);
  await installInfra(chains, REPO, [privateKeyToAccount(CRE_KEY).address, user, attacker]);
  const deployment = await deploySuite(chains, REPO, network, { deployerKey: DEPLOYER, issuer: user, verifier: verifier.address }, say);
  const addr = (alias: Alias, key: string): Hex => {
    const v = deployment.records[alias][key];
    if (typeof v !== "string") throw new Error(`deployment ${network}-${alias} has no ${key}`);
    return v as Hex;
  };
  // A stand-in CCIP OffRamp on arb (scenario 4), authorized on the LocalRouterMock for every source chain.
  const arb = byAlias("arb");
  const offRamp = deployLocalOffRamp(REPO, arb, DEPLOYER);
  const admin = wallet(arb, DEPLOYER);
  for (const src of chains.filter((c) => c.alias !== "arb")) {
    await send(arb, await admin.writeContract({ address: addr("arb", "ccipRouter"), abi: LOCAL_ROUTER_ABI, functionName: "setOffRamp", args: [src.selector, offRamp, true] }));
  }
  writeRecord(REPO, network, "arb", { ...deployment.records.arb, ccipOffRamp: offRamp });
  configDir = `.scn/${network}`;
  say(`$ node scripts/gen-config.ts --target local --network ${network} --out ${configDir}`);
  execFileSync("node", ["scripts/gen-config.ts", "--target", "local", "--network", network, "--out", configDir], { cwd: WORKFLOWS, stdio: ["ignore", "pipe", "pipe"] });
  await activateSpec(addr("home", "kirchhoffRegistry"));
  // Seed the user on home and make every contract visible at the finalized pin.
  const home = byAlias("home");
  await send(home, await wallet(home, DEPLOYER).writeContract({ address: addr("home", "kETH"), abi: TOKEN_ABI, functionName: "mint", args: [user, parseEther("100")] }));
  await mineToFinality(chains);
  await runW2("baseline epoch: UNKNOWN -> CONSERVED");
  await expectLedgers(addr, Status.CONSERVED, "every ledger CONSERVED after the baseline epoch");
  return { deployment, addr, offRamp };
}

async function send(chain: LocalChain, hash: Hex): Promise<TransactionReceipt> {
  const receipt = await chain.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx ${hash} on ${chain.alias} reverted`);
  return receipt;
}

let configDir = "";
/** `--config` resolves against the workflow folder, like `config-path` in workflow.yaml. */
const configPath = (workflow: string): string => `../${configDir}/${workflow}/config.local.json`;

function localConfig(workflow: string): unknown {
  return JSON.parse(readFileSync(join(WORKFLOWS, configDir, workflow, "config.local.json"), "utf8"));
}

/**
 * PRD section 6 spec lifecycle on the local registry: the issuer (the harness deployer, ISSUER_SAFE_ADDRESS of the
 * local suite) proposes the compiled spec hash, the 600 s timelock is skipped with evm_increaseTime, and anyone
 * activates it. W4 compares this active hash with the spec it runs.
 */
let lastActivation: TransactionReceipt | null = null;
async function activateSpec(registry: Hex): Promise<void> {
  const home = byAlias("home");
  const specHash = w4ConfigSchema.parse(localConfig("w4-topology")).specHash;
  const w = wallet(home, DEPLOYER);
  await send(home, await w.writeContract({ address: registry, abi: REGISTRY_ABI, functionName: "proposeSpec", args: [TOKEN_ID, specHash, "ipfs://kirchhoff/specs/kETH.yaml"] }));
  // Advance every chain's clock together: a home-only jump would skew the cross-chain timestamps W1 and W2 compare.
  for (const c of chains) {
    await anvil(c)("evm_increaseTime", [601]);
    await anvil(c)("evm_mine", []);
  }
  lastActivation = await send(home, await w.writeContract({ address: registry, abi: REGISTRY_ABI, functionName: "activateSpec", args: [TOKEN_ID] }));
  say(`spec ${specHash} proposed and activated on the local KirchhoffRegistry (tx ${lastActivation.transactionHash})`);
}

function eventIndex(receipt: TransactionReceipt, address: Hex, topic0: Hex): number {
  const i = receipt.logs.findIndex((l) => l.address.toLowerCase() === address.toLowerCase() && l.topics[0]?.toLowerCase() === topic0.toLowerCase());
  if (i === -1) throw new Error(`receipt ${receipt.transactionHash} has no ${topic0} from ${address}`);
  return i;
}

// ---------------------------------------------------------------- bridge actions

async function bridgeSend(s: Suite, from: Alias, to: Alias, amount: bigint): Promise<Hex> {
  const chain = byAlias(from);
  const w = wallet(chain, DEPLOYER);
  const token = s.addr(from, from === "home" ? "kETH" : "remoteKETH");
  const spender = s.addr(from, from === "home" ? "homeEscrowAdapter" : "weakBridge");
  await send(chain, await w.writeContract({ address: token, abi: TOKEN_ABI, functionName: "approve", args: [spender, amount] }));
  const receipt = await send(chain, await w.writeContract({ address: s.addr(from, "weakBridge"), abi: BRIDGE_ABI, functionName: "send", args: [user, amount, byAlias(to).selector] }));
  const burned = receipt.logs.map((l: Log) => {
    try {
      return decodeEventLog({ abi: BRIDGE_ABI, data: l.data, topics: l.topics });
    } catch {
      return null;
    }
  }).find((e) => e?.eventName === "Burned");
  if (burned?.eventName !== "Burned") throw new Error("send emitted no Burned");
  say(`debit on ${from}: ${amount} kETH to ${to}, message id ${burned.args.id} (tx ${receipt.transactionHash})`);
  return burned.args.id;
}

/** A WeakBridge credit signed by the bridge's single verifier key: honest when a debit exists, forged otherwise. */
async function bridgeCredit(s: Suite, on: Alias, srcAlias: Alias, id: Hex, to: Hex, amount: bigint): Promise<{ txHash: Hex; eventIndex: number }> {
  const chain = byAlias(on);
  const bridge = s.addr(on, "weakBridge");
  const src = byAlias(srcAlias).selector;
  const digest = await chain.public.readContract({ address: bridge, abi: BRIDGE_ABI, functionName: "creditDigest", args: [id, to, amount, src] });
  const signature = await verifier.sign({ hash: digest });
  const receipt = await send(chain, await wallet(chain, ATTACKER).writeContract({ address: bridge, abi: BRIDGE_ABI, functionName: "credit", args: [id, to, amount, src, signature] }));
  const emitter = on === "home" ? s.addr("home", "homeEscrowAdapter") : bridge;
  const index = eventIndex(receipt, emitter, keccak256(toHex("Released(bytes32,address,uint256,uint64)")));
  say(`credit on ${on}: ${amount} kETH to ${to} for id ${id} claiming source ${srcAlias} (tx ${receipt.transactionHash}, log ${index})`);
  return { txHash: receipt.transactionHash, eventIndex: index };
}

// ---------------------------------------------------------------- workflow runs

const wasm = new Map<SimulateArgs["workflow"], string>();

async function runCre(label: string, args: SimulateArgs): Promise<SimulateResult> {
  // Compile once per harness run; the config is read per simulation, so a rebuilt config needs no rebuild.
  let binary = wasm.get(args.workflow);
  if (binary === undefined) {
    binary = await buildWasm(WORKFLOWS, args.workflow, args.target);
    say(`(compiled ${args.workflow} once with \`cre workflow build ./${args.workflow} --target ${args.target}\`; runs below pass --wasm ${binary})`);
    wasm.set(args.workflow, binary);
  }
  const withWasm = { ...args, wasm: binary, config: configPath(args.workflow) };
  say(`\n**${label}**\n\n\`\`\`\n$ cre ${simulateCommand(withWasm).join(" ")}`);
  const result = await simulate(WORKFLOWS, withWasm);
  for (const line of result.userLogs) say(line);
  say(`result: ${result.result ?? "(none)"}${result.error === null ? "" : `\nerror: ${result.error}`}\n\`\`\``);
  if (result.error !== null || result.result === null) {
    process.stderr.write(result.output);
    throw new Error(`${args.workflow} simulation failed: ${result.error ?? "no result"}`);
  }
  return result;
}

const runW2 = (label: string): Promise<SimulateResult> => runCre(`W2 ${label}`, { workflow: "w2-loop", target: TARGET, triggerIndex: 0, broadcast: true });

function w1Index(chain: Alias): number {
  const i = creditTriggerGroups(w1ConfigSchema.parse(localConfig("w1-junction"))).findIndex((g) => g.chain === byAlias(chain).name);
  if (i === -1) throw new Error(`W1 has no trigger on ${chain}`);
  return i;
}

const runW1 = (label: string, chain: Alias, evm: { txHash: Hex; eventIndex: number }): Promise<SimulateResult> =>
  runCre(`W1 ${label}`, { workflow: "w1-junction", target: TARGET, triggerIndex: w1Index(chain), evm, broadcast: true });

// ---------------------------------------------------------------- ledger assertions

type LedgerView = { status: number; delta: bigint; active: Hex };

async function ledgerView(addr: Suite["addr"], alias: Alias): Promise<LedgerView> {
  const c = byAlias(alias);
  const ledger = addr(alias, "conservationLedger");
  const [status, delta] = await c.public.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "statusOf", args: [TOKEN_ID] });
  const active = await c.public.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "activeIncident", args: [TOKEN_ID] });
  return { status, delta, active };
}

async function expectLedgers(addr: Suite["addr"], status: number, what: string, delta?: bigint): Promise<LedgerView[]> {
  const views = await Promise.all(chains.map((c) => ledgerView(addr, c.alias)));
  const shown = views.map((v, i) => `${chains[i]?.alias ?? "?"}=${v.status}/${v.delta}`).join(" ");
  check(views.every((v) => v.status === status && (delta === undefined || v.delta === delta)), `${what} [status/delta ${shown}]`);
  return views;
}

async function expectBreach(addr: Suite["addr"], reason: number, what: string, amount?: bigint): Promise<void> {
  for (const c of chains) {
    const { active } = await ledgerView(addr, c.alias);
    const breach = await c.public.readContract({ address: addr(c.alias, "conservationLedger"), abi: LEDGER_ABI, functionName: "breachOf", args: [active] });
    check(breach.reason === reason && (amount === undefined || breach.amount === amount), `${c.alias} active incident ${active}: reason ${breach.reason}, amount ${breach.amount} (${what})`);
  }
}

async function expectConsumed(addr: Suite["addr"], id: Hex): Promise<void> {
  const flags = await Promise.all(
    chains.map((c) => c.public.readContract({ address: addr(c.alias, "conservationLedger"), abi: LEDGER_ABI, functionName: "isConsumed", args: [id] })),
  );
  check(flags.every(Boolean), `message ${id} consumed on every ledger`);
}

function expectResult(r: SimulateResult, pattern: RegExp, what: string): void {
  check(r.result !== null && pattern.test(r.result), `${what} (result: ${r.result ?? "none"})`);
}

// ---------------------------------------------------------------- scenarios

const E = (n: string): bigint => parseEther(n);

const SCENARIOS: { n: number; title: string; run: (s: Suite) => Promise<void> }[] = [
  {
    n: 1,
    title: "Normal round trip home -> Arbitrum -> home: CONSERVED throughout",
    run: async (s) => {
      const out = await bridgeSend(s, "home", "arb", E("10"));
      const credit = await bridgeCredit(s, "arb", "home", out, user, E("10"));
      await mineToFinality(chains);
      expectResult(await runW1("outbound credit on arb", "arb", credit), new RegExp(`status=${Status.CONSERVED} reason=${Reason.OK} writes=0`), "W1 matches the outbound credit");
      expectResult(await runW2("after outbound leg"), /status=1 reason=0 delta=0 writes=3/, "W2 EPOCH CONSERVED, delta 0");
      await expectConsumed(s.addr, out);
      const back = await bridgeSend(s, "arb", "home", E("10"));
      const home = await bridgeCredit(s, "home", "arb", back, user, E("10"));
      await mineToFinality(chains);
      expectResult(await runW1("return credit on home", "home", home), new RegExp(`status=${Status.CONSERVED} reason=${Reason.OK} writes=0`), "W1 matches the return credit");
      expectResult(await runW2("after return leg"), /status=1 reason=0 delta=0 writes=3/, "W2 EPOCH CONSERVED, delta 0");
      await expectConsumed(s.addr, back);
      await expectLedgers(s.addr, Status.CONSERVED, "every ledger CONSERVED with delta 0 after the round trip", 0n);
    },
  },
  {
    n: 2,
    title: "Message in flight across an epoch boundary: no false DRIFT or BROKEN",
    run: async (s) => {
      const id = await bridgeSend(s, "home", "arb", E("5"));
      await mineToFinality(chains);
      expectResult(await runW2("epoch while 5 kETH is locked but not minted"), /status=1 reason=0 delta=0 writes=3/, "W2 counts the locked amount in flight: CONSERVED, delta 0");
      await expectLedgers(s.addr, Status.CONSERVED, "every ledger CONSERVED with delta 0 mid-flight", 0n);
      const credit = await bridgeCredit(s, "arb", "home", id, user, E("5"));
      await mineToFinality(chains);
      expectResult(await runW1("delivery on arb", "arb", credit), /status=1 reason=0 writes=0/, "W1 matches the delivery");
      expectResult(await runW2("epoch after delivery"), /status=1 reason=0 delta=0 writes=3/, "W2 CONSERVED, delta 0 after delivery");
      await expectConsumed(s.addr, id);
    },
  },
  {
    n: 3,
    title: "Forged WeakBridge release (Kelp Replay): BROKEN by DEBIT_NOT_FOUND",
    run: async (s) => {
      const id = await bridgeSend(s, "home", "arb", E("10"));
      await bridgeCredit(s, "arb", "home", id, user, E("10"));
      await mineToFinality(chains);
      await runW2("escrow funded by a real transfer");
      const forgedId = keccak256(toHex(`forged-${RUN}`));
      const forged = await bridgeCredit(s, "home", "arb", forgedId, attacker, E("7"));
      await mineToFinality(chains);
      expectResult(await runW1("forged release on home", "home", forged), new RegExp(`status=${Status.BROKEN} reason=${Reason.DEBIT_NOT_FOUND} writes=3`), "W1 BROKEN DEBIT_NOT_FOUND, BREACH written to 3 chains in the same run");
      await expectLedgers(s.addr, Status.BROKEN, "every ledger BROKEN");
      await expectBreach(s.addr, Reason.DEBIT_NOT_FOUND, "forged credit", E("7"));
      // W3 containment on the BreachRecorded the BREACH emitted on home.
      const home = byAlias("home");
      const ledger = s.addr("home", "conservationLedger");
      const events = await home.public.getContractEvents({ address: ledger, abi: LEDGER_ABI, eventName: "BreachRecorded", fromBlock: 0n });
      const last = events.at(-1);
      if (last === undefined) throw new Error("no BreachRecorded on home");
      const receipt = await home.public.getTransactionReceipt({ hash: last.transactionHash });
      const idx = eventIndex(receipt, ledger, last.topics[0]);
      await mineToFinality(chains);
      const w3 = await runCre("W3 on BreachRecorded", { workflow: "w3-responder", target: TARGET, triggerIndex: 0, evm: { txHash: last.transactionHash, eventIndex: idx }, broadcast: true });
      expectResult(w3, /quarantined on 3 chain\(s\)/, "W3 QUARANTINE_APPLIED on 3 chains");
      await expectLedgers(s.addr, Status.QUARANTINED, "every ledger QUARANTINED");
    },
  },
  {
    n: 4,
    title: "Double credit of one real burn: BROKEN by DOUBLE_CREDIT",
    run: async (s) => {
      const id = await bridgeSend(s, "home", "arb", E("10"));
      const first = await bridgeCredit(s, "arb", "home", id, user, E("10"));
      await mineToFinality(chains);
      expectResult(await runW1("first (honest) credit", "arb", first), /status=1 reason=0 writes=0/, "W1 matches the first credit");
      expectResult(await runW2("settles the message id"), /status=1 reason=0 delta=0 writes=3/, "W2 CONSERVED and settles the id");
      await expectConsumed(s.addr, id);
      // The same debit credited again through the arb CCIP pool (a second minter in the spec).
      const arb = byAlias("arb");
      const receipt = await send(
        arb,
        await wallet(arb, ATTACKER).writeContract({
          address: s.offRamp,
          abi: OFFRAMP_ABI,
          functionName: "execute",
          args: [s.addr("arb", "kirchhoffTokenPool"), byAlias("home").selector, id, user, E("10"), s.addr("arb", "remoteKETH"), s.addr("home", "kirchhoffTokenPool")],
        }),
      );
      const idx = eventIndex(receipt, s.offRamp, keccak256(toHex("ExecutionStateChanged(uint64,uint64,bytes32,uint8,bytes)")));
      say(`second credit of ${id} on arb through the CCIP pool (tx ${receipt.transactionHash}, log ${idx})`);
      await mineToFinality(chains);
      expectResult(await runW1("replayed credit via CCIP pool", "arb", { txHash: receipt.transactionHash, eventIndex: idx }), new RegExp(`status=${Status.BROKEN} reason=${Reason.DOUBLE_CREDIT} writes=3`), "W1 BROKEN DOUBLE_CREDIT on 3 chains");
      await expectLedgers(s.addr, Status.BROKEN, "every ledger BROKEN");
      await expectBreach(s.addr, Reason.DOUBLE_CREDIT, "replayed credit", E("10"));
    },
  },
  {
    n: 5,
    title: "Direct mint by a compromised minter key, no message: BROKEN by LOOP_DEFICIT",
    run: async (s) => {
      if (lastActivation === null) throw new Error("no spec activation recorded");
      const registry = w4ConfigSchema.parse(localConfig("w4-topology")).registry;
      const activated = { txHash: lastActivation.transactionHash, eventIndex: eventIndex(lastActivation, registry.address, registry.specActivatedTopic0) };
      const reload = await runCre("W4 on SpecActivated (reload the active spec)", { workflow: "w4-topology", target: TARGET, triggerIndex: 0, evm: activated, broadcast: true });
      expectResult(reload, /findings=0 writes=0/, "W4 reloads the active spec: it equals the compiled spec, topology clean");
      const arb = byAlias("arb");
      const token = s.addr("arb", "remoteKETH");
      const grant = await send(arb, await wallet(arb, DEPLOYER).writeContract({ address: token, abi: TOKEN_ABI, functionName: "grantMintRole", args: [attacker] }));
      await send(arb, await wallet(arb, ATTACKER).writeContract({ address: token, abi: TOKEN_ABI, functionName: "mint", args: [attacker, E("50")] }));
      await mineToFinality(chains);
      const w4cfg = w4ConfigSchema.parse(localConfig("w4-topology"));
      const w4Index = 2 + watchedChains(w4cfg).findIndex((c) => c.name === arb.name);
      const roleGranted = eventIndex(grant, token, w4cfg.roleGrantedTopic0);
      const w4 = await runCre("W4 on the RoleGranted(MINTER_ROLE) grant", { workflow: "w4-topology", target: TARGET, triggerIndex: w4Index, evm: { txHash: grant.transactionHash, eventIndex: roleGranted }, broadcast: true });
      expectResult(w4, /findings=1 writes=3/, "W4 flags the unlisted minter (EPOCH DRIFT SPEC_MISMATCH on 3 chains)");
      await expectLedgers(s.addr, Status.DRIFT, "every ledger DRIFT (SPEC_MISMATCH)");
      expectResult(await runW2("after the direct mint"), new RegExp(`status=${Status.BROKEN} reason=${Reason.LOOP_DEFICIT} delta=-${E("50")} writes=3`), "W2 BROKEN LOOP_DEFICIT, delta -50 kETH, BREACH on 3 chains");
      await expectLedgers(s.addr, Status.BROKEN, "every ledger BROKEN");
      await expectBreach(s.addr, Reason.LOOP_DEFICIT, "Loop Rule deficit", E("50"));
    },
  },
  {
    n: 6,
    title: "Donation to the escrow: delta rises, status stays CONSERVED (surplus)",
    run: async (s) => {
      const home = byAlias("home");
      await send(home, await wallet(home, DEPLOYER).writeContract({ address: s.addr("home", "kETH"), abi: TOKEN_ABI, functionName: "transfer", args: [s.addr("home", "homeEscrowAdapter"), E("3")] }));
      await mineToFinality(chains);
      expectResult(await runW2("after a 3 kETH donation to the escrow"), new RegExp(`status=1 reason=0 delta=${E("3")} writes=3`), "W2 CONSERVED with delta +3 kETH");
      await expectLedgers(s.addr, Status.CONSERVED, "every ledger CONSERVED with delta +3 kETH (unclaimed surplus)", E("3"));
    },
  },
  {
    n: 7,
    title: "Latency: Loop Rule breach to BROKEN onchain (PRD 2.M2, under 60 s after confidence)",
    run: async (s) => {
      const arb = byAlias("arb");
      const token = s.addr("arb", "remoteKETH");
      await send(arb, await wallet(arb, DEPLOYER).writeContract({ address: token, abi: TOKEN_ABI, functionName: "grantMintRole", args: [attacker] }));
      // The breach: an unbacked mint. Anvil mines one block per second, so timestamps here are real time.
      const mint = await send(arb, await wallet(arb, ATTACKER).writeContract({ address: token, abi: TOKEN_ABI, functionName: "mint", args: [attacker, E("50")] }));
      const breachBlock = await arb.public.getBlock({ blockNumber: mint.blockNumber });
      say(`breach: mint of 50 kETH on arb in block ${mint.blockNumber} at ${breachBlock.timestamp} (tx ${mint.transactionHash})`);
      // Confidence: W2 pins `finalized` (Anvil: head - 64). Wait in real time for the mint block to get there.
      let finalized = await arb.public.getBlock({ blockTag: "finalized" });
      while (finalized.number < mint.blockNumber) {
        await new Promise((r) => setTimeout(r, 500));
        finalized = await arb.public.getBlock({ blockTag: "finalized" });
      }
      // The moment of confidence is the head that made the mint block final (finalized = head - 64 on Anvil).
      const confident = await arb.public.getBlock({ blockTag: "latest" });
      say(`confidence: arb head ${confident.number} at ${confident.timestamp} makes the mint block final (finalized head ${finalized.number})`);
      // The supply-change log trigger (arb mint side) replays the mint's Transfer(from = 0).
      const w2cfg = w2ConfigSchema.parse(localConfig("w2-loop"));
      const side = w2cfg.supplyTriggers.findIndex((t) => t.chain === arb.name && t.side === "mint");
      const transfer = eventIndex(mint, token, keccak256(toHex("Transfer(address,address,uint256)")));
      const w2 = await runCre("W2 on the arb mint supply trigger", { workflow: "w2-loop", target: TARGET, triggerIndex: side + 1, evm: { txHash: mint.transactionHash, eventIndex: transfer }, broadcast: true });
      expectResult(w2, new RegExp(`status=${Status.BROKEN} reason=${Reason.LOOP_DEFICIT}`), "W2 BROKEN LOOP_DEFICIT from the supply trigger");
      await expectLedgers(s.addr, Status.BROKEN, "every ledger BROKEN");
      const rows: string[] = [];
      for (const c of chains) {
        const events = await c.public.getContractEvents({ address: s.addr(c.alias, "conservationLedger"), abi: LEDGER_ABI, eventName: "BreachRecorded", fromBlock: 0n });
        const last = events.at(-1);
        if (last === undefined) throw new Error(`no BreachRecorded on ${c.alias}`);
        const block = await c.public.getBlock({ blockNumber: last.blockNumber });
        const fromBreach = block.timestamp - breachBlock.timestamp;
        const fromConfidence = block.timestamp - confident.timestamp;
        rows.push(`| ${c.alias} | ${last.transactionHash} | ${block.timestamp} | ${fromBreach} s | ${fromConfidence} s |`);
        check(fromConfidence < 60n, `${c.alias}: BROKEN ${fromConfidence} s after confidence (< 60 s), ${fromBreach} s after the breach block`);
      }
      say(`\n| chain | BREACH tx | block time | breach -> BROKEN | confidence -> BROKEN |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`);
    },
  },
];

// ---------------------------------------------------------------- main

const only = (() => {
  const i = process.argv.indexOf("--only");
  return i === -1 ? null : new Set((process.argv[i + 1] ?? "").split(",").map(Number));
})();

const results: { n: number; title: string; ok: boolean; error?: string }[] = [];
let lastNetwork: string | null = null;
for (const scenario of SCENARIOS) {
  if (only !== null && !only.has(scenario.n)) continue;
  say(`\n### Scenario ${scenario.n}: ${scenario.title}`);
  try {
    const suite = await freshSuite(scenario.n);
    if (lastNetwork !== null) for (const c of chains) rmSync(join(REPO, "deployments", `${lastNetwork}-${c.alias}.json`), { force: true });
    lastNetwork = suite.deployment.network;
    await scenario.run(suite);
    results.push({ n: scenario.n, title: scenario.title, ok: true });
    say(`\n**Scenario ${scenario.n}: PASS**`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    results.push({ n: scenario.n, title: scenario.title, ok: false, error });
    say(`\n**Scenario ${scenario.n}: FAIL** ${error}`);
  }
}

// The suites live on the harness's private chains, which stop with this process: their records are dead.
if (lastNetwork !== null) for (const c of chains) rmSync(join(REPO, "deployments", `${lastNetwork}-${c.alias}.json`), { force: true });

const summary = ["| # | Scenario | Result |", "| --- | --- | --- |", ...results.map((r) => `| ${r.n} | ${r.title} | ${r.ok ? "PASS" : `FAIL: ${r.error ?? ""}`} |`)].join("\n");
say(`\n### Summary\n\n${summary}`);

const LOG_PATH = join(WORKFLOWS, "SIMULATION_LOG.md");
const START = "<!-- scenarios:start -->";
const END = "<!-- scenarios:end -->";
const existing = (() => {
  try {
    return readFileSync(LOG_PATH, "utf8");
  } catch {
    // First run: start the log with empty scenario markers.
    return `# Simulation log\n\n${START}\n${END}\n`;
  }
})();
const block = `${START}\n## Local scenarios (generated by \`pnpm --filter @kirchhoff/workflows scenarios\`, run ${new Date().toISOString()})\n${log.join("\n")}\n${END}`;
const updated = existing.includes(START) && existing.includes(END)
  ? existing.slice(0, existing.indexOf(START)) + block + existing.slice(existing.indexOf(END) + END.length)
  : `${existing}\n${block}\n`;
writeFileSync(LOG_PATH, updated);
process.exit(results.every((r) => r.ok) ? 0 : 1);
