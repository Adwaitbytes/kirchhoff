import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONTRACTS_ROOT } from "./env.ts";
import { log } from "./events.ts";

export class ProcessError extends Error {
  override readonly name = "ProcessError";
}

export type RunResult = { code: number; stdout: string; stderr: string };

/** Paths for forge, cast and cre regardless of the caller's shell profile. */
export function toolPath(): string {
  const home = homedir();
  return [join(home, ".foundry", "bin"), join(home, ".cre", "bin"), join(home, ".bun", "bin"), process.env.PATH ?? ""].join(":");
}

/**
 * Runs a command with extra env. Output is captured and echoed to stderr (never stdout, which carries JSON events).
 * Secrets travel only through env, never argv, so they cannot appear in process listings or logs.
 */
export function run(cmd: string, args: readonly string[], opts: { cwd: string; env?: Record<string, string>; echo?: boolean; allowFailure?: boolean }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, PATH: toolPath(), ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (opts.echo === true) process.stderr.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (opts.echo === true) process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && opts.allowFailure !== true) {
        reject(new ProcessError(`${cmd} ${args.slice(0, 3).join(" ")} exited ${result.code}\n${tail(stderr || stdout)}`));
      } else resolve(result);
    });
  });
}

const tail = (text: string, lines = 25): string => text.trim().split("\n").slice(-lines).join("\n");

export type ScriptOptions = {
  script: "script/Deploy.s.sol" | "script/ConfigureLanes.s.sol";
  rpcUrl: string;
  env: Record<string, string>;
  broadcast: boolean;
  /** Etherscan V2 verification during broadcast (one key covers all three testnets). */
  verify?: { etherscanApiKey: string };
  /** Testnets: explicit fee caps (wei) so forge never overpays on a small budget. */
  gasPrice?: { max: bigint; priority: bigint };
};

export type ScriptResult = RunResult & { estimatedGas: bigint | null; estimatedEth: string | null };

export async function forgeScript(o: ScriptOptions): Promise<ScriptResult> {
  const args = ["script", o.script, "--rpc-url", o.rpcUrl, "-vv"];
  if (o.broadcast) args.push("--broadcast", "--slow");
  if (o.verify !== undefined) args.push("--verify", "--verifier", "etherscan", "--etherscan-api-key", o.verify.etherscanApiKey, "--retries", "6", "--delay", "12");
  if (o.gasPrice !== undefined) args.push("--with-gas-price", o.gasPrice.max.toString(), "--priority-gas-price", o.gasPrice.priority.toString());
  log(`forge ${args.map((a) => (a === o.rpcUrl || a === o.verify?.etherscanApiKey ? "***" : a)).join(" ")} (${o.env.NETWORK ?? ""})`);
  const result = await run("forge", args, { cwd: CONTRACTS_ROOT, env: o.env, echo: true });
  const gas = /Estimated total gas used for script:\s*(\d+)/.exec(result.stdout)?.[1];
  const eth = /Estimated amount required:\s*([\d.]+)\s*ETH/.exec(result.stdout)?.[1];
  return { ...result, estimatedGas: gas === undefined ? null : BigInt(gas), estimatedEth: eth ?? null };
}
