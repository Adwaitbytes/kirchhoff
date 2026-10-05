import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS_ROOT, optional, required } from "./env.ts";
import { log, type stepEmitter } from "./events.ts";
import { run } from "./forge.ts";
import { addressUrl, ROLES, type ChainConfig, type Network } from "./networks.ts";

type Emit = ReturnType<typeof stepEmitter>;

export type Deployed = { name: string; qualified: string; address: string; constructorArgs: string };

type BroadcastTx = {
  transactionType: string;
  contractName: string | null;
  contractAddress: string | null;
  transaction: { input?: string };
  additionalContracts?: { contractName?: string | null; address: string; initCode?: string }[];
};

type Artifact = { bytecode: { object: string }; metadata?: { settings?: { compilationTarget?: Record<string, string> } } };

/** `src/File.sol:Name` and the creation bytecode for a compiled contract (contracts/out). */
function artifactFor(name: string): { qualified: string; creation: string } {
  const out = join(CONTRACTS_ROOT, "out");
  for (const dir of readdirSync(out)) {
    const path = join(out, dir, `${name}.json`);
    if (!existsSync(path)) continue;
    const artifact = JSON.parse(readFileSync(path, "utf8")) as Artifact;
    const target = Object.entries(artifact.metadata?.settings?.compilationTarget ?? {}).find(([, n]) => n === name);
    if (target === undefined) continue;
    return { qualified: `${target[0]}:${name}`, creation: artifact.bytecode.object.toLowerCase() };
  }
  throw new Error(`no compiled artifact for ${name}; run forge build`);
}

/** ABI-encoded constructor args: the creation input minus the compiled creation bytecode (exact, no guessing). */
function constructorArgs(name: string, input: string, creation: string): string {
  const code = input.toLowerCase();
  if (!code.startsWith(creation)) throw new Error(`${name}: deployed initcode does not match the current build (rebuild with the deploy settings)`);
  return code.slice(creation.length);
}

/** Every contract Deploy.s.sol created on a chain, from forge's broadcast record (top-level and internal CREATEs). */
export function deployedContracts(chainId: number): Deployed[] {
  const path = join(CONTRACTS_ROOT, "broadcast", "Deploy.s.sol", String(chainId), "run-latest.json");
  if (!existsSync(path)) throw new Error(`no forge broadcast record for chain ${chainId} (${path})`);
  const record = JSON.parse(readFileSync(path, "utf8")) as { transactions: BroadcastTx[] };
  const out: Deployed[] = [];
  for (const tx of record.transactions) {
    if (tx.transactionType.startsWith("CREATE") && tx.contractName !== null && tx.contractAddress !== null) {
      const { qualified, creation } = artifactFor(tx.contractName);
      out.push({ name: tx.contractName, qualified, address: tx.contractAddress, constructorArgs: constructorArgs(tx.contractName, tx.transaction.input ?? "", creation) });
    }
    for (const inner of tx.additionalContracts ?? []) {
      if (inner.contractName == null) continue;
      const { qualified, creation } = artifactFor(inner.contractName);
      out.push({ name: inner.contractName, qualified, address: inner.address, constructorArgs: constructorArgs(inner.contractName, inner.initCode ?? creation, creation) });
    }
  }
  return out;
}

type Verifier = { kind: "etherscan" | "blockscout"; args: string[] };

function verifiers(chain: ChainConfig): Verifier[] {
  const list: Verifier[] = [{ kind: "etherscan", args: ["--verifier", "etherscan", "--etherscan-api-key", required("ETHERSCAN_API_KEY")] }];
  if (chain.blockscout !== null) list.push({ kind: "blockscout", args: ["--verifier", "blockscout", "--verifier-url", `${chain.blockscout.api.replace(/\/$/, "")}/`] });
  return list;
}

/**
 * `forge verify-contract` for one contract on one explorer, with the exact constructor args recovered from the
 * broadcast. "Already verified" counts as success, so the pass is idempotent.
 */
async function verifyOne(chain: ChainConfig, c: Deployed, v: Verifier): Promise<{ ok: boolean; note: string }> {
  const args = ["verify-contract", c.address, c.qualified, "--chain", String(chain.chainId), "--watch", "--retries", "10", "--delay", "6", ...v.args];
  if (c.constructorArgs !== "") args.push("--constructor-args", `0x${c.constructorArgs}`);
  const result = await run("forge", args, { cwd: CONTRACTS_ROOT, allowFailure: true });
  const text = `${result.stdout}\n${result.stderr}`;
  if (/already verified/i.test(text)) return { ok: true, note: "already verified" };
  if (/Pass - Verified|successfully verified|Contract successfully verified/i.test(text)) return { ok: true, note: "verified" };
  const reason = text.split("\n").filter((l) => /error|fail|unable|reason/i.test(l)).slice(0, 2).join(" | ") || `exit ${result.code}`;
  return { ok: false, note: reason.replace(optional("ETHERSCAN_API_KEY") ?? "\u0000", "***").slice(0, 300) };
}

export type VerifyRow = { chain: string; name: string; address: string; etherscan: string; blockscout: string };

/** Verifies every deployed contract on all three testnets on Etherscan V2 and Blockscout; never throws on a miss. */
export async function verifyAll(net: Network, emit: Emit): Promise<VerifyRow[]> {
  const rows: VerifyRow[] = [];
  for (const role of ROLES) {
    const chain = net.chains[role];
    for (const c of deployedContracts(chain.chainId)) {
      const row: VerifyRow = { chain: role, name: c.name, address: c.address, etherscan: "skipped", blockscout: "skipped" };
      for (const v of verifiers(chain)) {
        // Explorer APIs rate-limit bursts (Blockscout answers "Too many requests"): retry with a growing pause.
        let r = await verifyOne(chain, c, v);
        for (let attempt = 1; !r.ok && attempt < 4; attempt++) {
          await new Promise((done) => setTimeout(done, 15_000 * attempt));
          r = await verifyOne(chain, c, v);
        }
        row[v.kind] = r.ok ? r.note : `FAILED: ${r.note}`;
        await new Promise((done) => setTimeout(done, 3_000));
      }
      log(`${chain.label}: ${c.name} ${c.address} etherscan=${row.etherscan} blockscout=${row.blockscout}`);
      emit({
        step: "verify",
        status: row.etherscan.startsWith("FAILED") || row.blockscout.startsWith("FAILED") ? "failed" : "ok",
        chain: role,
        title: `${c.name} ${c.address}`,
        explorerUrl: addressUrl(chain, c.address),
        detail: { etherscan: row.etherscan, blockscout: row.blockscout, blockscoutUrl: chain.blockscout === null ? null : `${chain.blockscout.web}/address/${c.address}` },
      });
      rows.push(row);
    }
  }
  return rows;
}
