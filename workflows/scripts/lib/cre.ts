import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Hex } from "@kirchhoff/engine";

export type SimulateArgs = {
  workflow: "w1-junction" | "w2-loop" | "w3-responder" | "w4-topology";
  target: "local" | "scenarios" | "staging" | "staging-fallback";
  triggerIndex: number;
  /** EVM log trigger replay: transaction hash and 0-based index of the log in that transaction's receipt. */
  evm?: { txHash: Hex; eventIndex: number };
  broadcast: boolean;
  /** Pre-built WASM (absolute path, from `cre workflow build`): skips the ~10 s compile per run. */
  wasm?: string;
  /** Config file override (`--config`), relative to the workflow folder; the CLI caps the path at 97 characters. */
  config?: string;
};

export type SimulateResult = {
  command: string;
  exitCode: number;
  output: string;
  userLogs: string[];
  /** The handler's return value as printed under "Workflow Simulation Result". */
  result: string | null;
  error: string | null;
};

/** Exact CLI form (docs/research/cre.md section 3); run from workflows/ so project.yaml is the project root. */
export function simulateCommand(a: SimulateArgs): string[] {
  const args = ["workflow", "simulate", `./${a.workflow}`, "--target", a.target, "--non-interactive", "--trigger-index", String(a.triggerIndex)];
  if (a.evm !== undefined) args.push("--evm-tx-hash", a.evm.txHash, "--evm-event-index", String(a.evm.eventIndex));
  if (a.broadcast) args.push("--broadcast");
  if (a.wasm !== undefined) args.push("--wasm", a.wasm);
  if (a.config !== undefined) args.push("--config", a.config);
  args.push("-e", "../.env");
  return args;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function parseSimulateOutput(raw: string): Pick<SimulateResult, "userLogs" | "result" | "error"> {
  const output = raw.replace(ANSI, "");
  const lines = output.split("\n");
  const userLogs = lines.filter((l) => l.includes("[USER LOG]")).map((l) => l.slice(l.indexOf("[USER LOG]") + 11).trim());
  const marker = lines.findIndex((l) => l.includes("Workflow Simulation Result"));
  const resultLine = marker === -1 ? undefined : lines.slice(marker + 1).find((l) => l.trim() !== "");
  const failure = lines.find((l) => l.includes("workflow execution failed") || l.startsWith("Error:") || l.includes("✗"));
  return {
    userLogs,
    result: resultLine === undefined ? null : resultLine.trim().replace(/^"|"$/g, ""),
    error: failure === undefined ? null : failure.trim(),
  };
}

/** CRE login checks reach api.cre.chain.link on every run; a timeout there is not a workflow failure. */
const TRANSIENT = /Credential validation failed|context deadline exceeded|unable to retrieve organization info/;

/** `cre workflow build`: compiles one workflow to <workflow>/binary.wasm (no login needed). */
export async function buildWasm(workflowsDir: string, workflow: SimulateArgs["workflow"], target: SimulateArgs["target"]): Promise<string> {
  await promisify(execFile)("cre", ["workflow", "build", `./${workflow}`, "--target", target], { cwd: workflowsDir, maxBuffer: 64 * 1024 * 1024 });
  return join(workflowsDir, workflow, "binary.wasm");
}

export async function simulate(workflowsDir: string, a: SimulateArgs): Promise<SimulateResult> {
  for (let attempt = 1; ; attempt++) {
    const result = await simulateOnce(workflowsDir, a);
    if (attempt >= 3 || !TRANSIENT.test(result.output)) return result;
  }
}

async function simulateOnce(workflowsDir: string, a: SimulateArgs): Promise<SimulateResult> {
  const args = simulateCommand(a);
  const command = `cre ${args.join(" ")}`;
  const run = promisify(execFile);
  try {
    const { stdout, stderr } = await run("cre", args, { cwd: workflowsDir, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
    const output = `${stdout}${stderr}`;
    return { command, exitCode: 0, output, ...parseSimulateOutput(output) };
  } catch (e) {
    const failed = e as { code?: number; stdout?: string; stderr?: string; message: string };
    const output = `${failed.stdout ?? ""}${failed.stderr ?? ""}` || failed.message;
    return { command, exitCode: typeof failed.code === "number" ? failed.code : 1, output, ...parseSimulateOutput(output) };
  }
}
